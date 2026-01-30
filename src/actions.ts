import { ethers } from "ethers";

import { Pool, Position } from "@uniswap/v3-sdk";
import { Token, CurrencyAmount, Percent } from "@uniswap/sdk-core";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    ERC20_ABI,
    NPM_ABI,
    SWAP_ROUTER_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    SWAP_ROUTER_ADDR,
    MAX_UINT128,
    SLIPPAGE_TOLERANCE,
    TX_TIMEOUT_MS,
    POOL_ABI,
    V3_FACTORY_ADDR,
    RSI_OVERBOUGHT,
    RSI_OVERSOLD,
    AAVE_POOL_ADDR,
    REBALANCE_THRESHOLD_USDC,
    REBALANCE_THRESHOLD_WETH,
    ATR_SAFETY_FACTOR,
    QUOTER_ADDR,
    QUOTER_ABI,
} from "../config";

import { withRetry, waitWithTimeout, getPoolTwap, sendEmailAlert } from "./utils";
import { saveState } from "./state";
import { getEthAtr, getEthRsi } from "./analytics";

// --- Wallet Utilities ---
export async function getBalance(
    token: Token,
    wallet: ethers.Wallet
): Promise<bigint> {
    const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
    return await withRetry(() => contract.balanceOf(wallet.address));
}

export async function approveAll(wallet: ethers.Wallet) {
    const tokens = [USDC_TOKEN, WETH_TOKEN];
    const spenders = [
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        SWAP_ROUTER_ADDR,
        AAVE_POOL_ADDR,
    ];

    for (const token of tokens) {
        const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
        for (const spender of spenders) {
            const allowance = await withRetry(() =>
                contract.allowance(wallet.address, spender)
            );
            const threshold = ethers.MaxUint256 / 2n;

            if (allowance < threshold) {
                console.log(
                    `[Approve] Authorizing ${token.symbol} for ${spender}...`
                );
                const tx = await contract.approve(spender, ethers.MaxUint256);
                await waitWithTimeout(tx, TX_TIMEOUT_MS);
                console.log(`[Approve] Success.`);
            }
        }
    }
}

// --- Core Actions ---
export async function atomicExitPosition(
    wallet: ethers.Wallet,
    tokenId: string
) {
    console.log(`\n[Exit] Executing Atomic Exit for Token ${tokenId}...`);
    const npm = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        NPM_ABI,
        wallet
    );

    let pos;
    try {
        pos = await withRetry(() => npm.positions(tokenId));
    } catch (e: any) {
        // If the token is invalid, it means it's likely already burned.
        if (String(e).includes("Invalid token ID") || e.reason === "Invalid token ID") {
            console.log(`   [Exit] Token ${tokenId} is invalid (already burned). Skipping exit.`);
            return;
        }
        throw e;
    }
    const liquidity = pos.liquidity;

    const calls: string[] = [];
    const iface = npm.interface;

    // 1. Decrease Liquidity
    if (liquidity > 0n) {
        const decreaseData = {
            tokenId: tokenId,
            liquidity: liquidity,
            amount0Min: 0,
            amount1Min: 0,
            deadline: Math.floor(Date.now() / 1000) + 120,
        };
        calls.push(
            iface.encodeFunctionData("decreaseLiquidity", [decreaseData])
        );
    }

    // 2. Collect Fees
    const collectData = {
        tokenId: tokenId,
        recipient: wallet.address,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
    };
    calls.push(iface.encodeFunctionData("collect", [collectData]));

    // 3. Burn NFT
    calls.push(iface.encodeFunctionData("burn", [tokenId]));

    try {
        const tx = await npm.multicall(calls, { value: 0 });
        await waitWithTimeout(tx, TX_TIMEOUT_MS);
        console.log(`   Atomic Exit Successful! (Tx: ${tx.hash})`);
    } catch (e) {
        console.error(`   Atomic Exit Failed:`, e);
        throw e;
    }
}

export async function rebalancePortfolio(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    tokenId: string
) {
    console.log(`\n[Rebalance] Calculating Optimal Swap with RSI Filter...`);

    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const priceWethToUsdc =
        configuredPool.token0.address === WETH_TOKEN.address
            ? configuredPool.token0Price
            : configuredPool.token1Price;

    const wethAmount = CurrencyAmount.fromRawAmount(
        WETH_TOKEN,
        balWETH.toString()
    );
    const usdcAmount = CurrencyAmount.fromRawAmount(
        USDC_TOKEN,
        balUSDC.toString()
    );
    const wethValueInUsdc = priceWethToUsdc.quote(wethAmount);

    const router = new ethers.Contract(
        SWAP_ROUTER_ADDR,
        SWAP_ROUTER_ABI,
        wallet
    );

    const quoter = new ethers.Contract(QUOTER_ADDR, QUOTER_ABI, wallet);

    // Slippage Helper
    const calculateMinOut = (quotedAmount: bigint) => {
        const tolerance = BigInt(SLIPPAGE_TOLERANCE.numerator.toString());
        const basis = BigInt(SLIPPAGE_TOLERANCE.denominator.toString());
        return quotedAmount * (basis - tolerance) / basis;
    };

    if (usdcAmount.greaterThan(wethValueInUsdc)) {
        // Sell USDC
        const diff = usdcAmount.subtract(wethValueInUsdc);
        const amountToSell = diff.divide(2);
        
        // [Strategy: Profit Taking]
        // If we have a lot of USDC and very little ETH, it means ETH price skyrocketed out of range.
        // We stop here to secure profits in USDC and avoid FOMO buying at the top.
        const wethBalanceRaw = await getBalance(WETH_TOKEN, wallet);
        if (tokenId !== "0" && wethBalanceRaw < ethers.parseEther("0.005")) {
             console.log("!!! [Strategy Trigger] ETH Pumped. Profit secured in USDC.");
             console.log("!!! [Strategy Trigger] Stopping bot to avoid FOMO buying.");
             throw new Error("PROFIT_SECURED: Holding USDC. Stopping to avoid FOMO buying.");
        }

        if (BigInt(amountToSell.quotient.toString()) < REBALANCE_THRESHOLD_USDC) {
            console.log("   Balance is good enough. Skipping swap.");
            return;
        }
    
        const amountIn = BigInt(amountToSell.quotient.toString());
        console.log(`   [Swap] Selling ${amountToSell.toSignificant(6)} USDC for WETH`);

        // 1. Quote
        const quoteParams = {
            tokenIn: USDC_TOKEN.address,
            tokenOut: WETH_TOKEN.address,
            amountIn: amountIn,
            fee: POOL_FEE,
            sqrtPriceLimitX96: 0
        };
        // QuoterV2 returns struct, ethers v6 parses it. First return value is amountOut.
        const [quotedAmountOut] = await quoter.getFunction("quoteExactInputSingle").staticCall(quoteParams);
        const amountOutMin = calculateMinOut(quotedAmountOut);

        console.log(`   [Quote] Expect: ${ethers.formatEther(quotedAmountOut)} ETH, Min: ${ethers.formatEther(amountOutMin)}`);

       const tx = await router.exactInputSingle({
            tokenIn: USDC_TOKEN.address,
            tokenOut: WETH_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0,
        });

        await waitWithTimeout(tx, TX_TIMEOUT_MS);
    } else {
        // Sell WETH
        const diffValueInUsdc = wethValueInUsdc.subtract(usdcAmount);
        
        // [Strategy: Accumulation] Sell less ETH (1/4 instead of 1/2) to keep more chips during dips.
        const amountToSellValue = diffValueInUsdc.divide(4);

        const priceUsdcToWeth =
            configuredPool.token0.address === USDC_TOKEN.address
                ? configuredPool.token0Price
                : configuredPool.token1Price;

        const amountToSell = priceUsdcToWeth.quote(amountToSellValue);

        if (BigInt(amountToSell.quotient.toString()) < REBALANCE_THRESHOLD_WETH) {
            console.log("   Balance is good enough. Skipping swap.");
            return;
        }

       const amountIn = BigInt(amountToSell.quotient.toString());
        console.log(`   [Swap] Selling ${amountToSell.toSignificant(6)} WETH for USDC`);

        // 1. Quote
        const quoteParams = {
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            amountIn: amountIn,
            fee: POOL_FEE,
            sqrtPriceLimitX96: 0
        };
        const [quotedAmountOut] = await quoter.getFunction("quoteExactInputSingle").staticCall(quoteParams);
        const amountOutMin = calculateMinOut(quotedAmountOut);

        console.log(`   [Quote] Expect: ${ethers.formatUnits(quotedAmountOut, 6)} USDC, Min: ${ethers.formatUnits(amountOutMin, 6)}`);

        const tx = await router.exactInputSingle({
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0,
        });

        await waitWithTimeout(tx, TX_TIMEOUT_MS);
    }
}

export async function mintMaxLiquidity(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    tickLower: number,
    tickUpper: number
): Promise<string> {
    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const amount0Input =
        configuredPool.token0.address === WETH_TOKEN.address
            ? balWETH
            : balUSDC;
    const amount1Input =
        configuredPool.token1.address === WETH_TOKEN.address
            ? balWETH
            : balUSDC;

    // 99.9% Buffer
    const amount0Safe = (amount0Input * 999n) / 1000n;
    const amount1Safe = (amount1Input * 999n) / 1000n;

    const position = Position.fromAmounts({
        pool: configuredPool,
        tickLower,
        tickUpper,
        amount0: amount0Safe.toString(),
        amount1: amount1Safe.toString(),
        useFullPrecision: true,
    });

    const { amount0: amount0Min, amount1: amount1Min } =
        position.mintAmountsWithSlippage(SLIPPAGE_TOLERANCE);

    const mintParams = {
        token0: configuredPool.token0.address,
        token1: configuredPool.token1.address,
        fee: POOL_FEE,
        tickLower,
        tickUpper,
        amount0Desired: position.mintAmounts.amount0.toString(),
        amount1Desired: position.mintAmounts.amount1.toString(),

        amount0Min: amount0Min.toString(),
        amount1Min: amount1Min.toString(),

        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 120,
    };

    console.log(`\n[Mint] Minting new position...`);
    const npm = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        NPM_ABI,
        wallet
    );
    const tx = await npm.mint(mintParams, { gasLimit: 1_000_000 });
    const receipt = await waitWithTimeout(tx, TX_TIMEOUT_MS);

    const transferEventSig = ethers.id("Transfer(address,address,uint256)");

    const transferLog = receipt.logs.find((log: any) => {
        if (log.topics[0] !== transferEventSig) return false;

        try {
            const toAddress = ethers.dataSlice(log.topics[2], 12); 
            return ethers.getAddress(toAddress) === wallet.address;
        } catch {
            return false;
        }
    });

    if (!transferLog) {
        throw new Error(
            "Mint successful but failed to parse Token ID from logs (Transfer event not found)."
        );
    }

    const newTokenId = BigInt(transferLog.topics[3]).toString();

    console.log(`   Success! Token ID: ${newTokenId}`);
    return newTokenId;
}

// Full Rebalancing Process: Remove Old -> Swap -> Refresh Price -> Mint New
export async function executeFullRebalance(
    wallet: ethers.Wallet,
    configuredPool: Pool,
    oldTokenId: string
) {
    console.log(`[Rebalance] Starting full rebalance sequence...`);

    // 0. TWAP Price Safety Check
    // Prevents price manipulation via flash loans from triggering a rebalance at a bad price.
    const poolAddr = Pool.getAddress(USDC_TOKEN, WETH_TOKEN, POOL_FEE, undefined, V3_FACTORY_ADDR);
    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, wallet);

    try {
        // Get TWAP Tick for the last 5 minutes (300 seconds)
        const twapTick = Number(await getPoolTwap(poolContract, 300));
        const currentTick = configuredPool.tickCurrent;
        
        // Calculate tick difference
        const tickDiff = Math.abs(currentTick - twapTick);
        
        // 1% price deviation is roughly 100 ticks (Basis Points)
        // Threshold: If Spot deviates from TWAP by more than 200 ticks (~2%), reject the trade.
        const MAX_TICK_DEVIATION = 200; 

        console.log(`   [Safety] Spot Tick: ${currentTick} | TWAP Tick: ${twapTick} | Diff: ${tickDiff}`);

        if (tickDiff > MAX_TICK_DEVIATION) {
            const msg = `Price manipulation detected! Spot price deviates from TWAP by ${tickDiff} ticks.`;
            await sendEmailAlert("TWAP Check Failed", msg);
            throw new Error(`Price manipulation detected! Spot price deviates from TWAP by ${tickDiff} ticks.`);
        }
    } catch (e) {
        console.error("   [Safety] TWAP check failed:", e);
        await sendEmailAlert("TWAP Check Error", `Error checking TWAP: ${e}`);
        throw e; // Must throw exception to stop further operations
    }

    
    console.log("   [Strategy] Pre-fetching market analytics...");
    let atr, rsi4h, rsi15m;
    try {
        [atr, rsi4h, rsi15m] = await Promise.all([
            getEthAtr("1h"),
            getEthRsi("4h"), // Trend Context
            getEthRsi("15m") // Immediate Momentum
        ]);
        console.log(`   [Strategy] Data acquired. ATR: ${atr}, RSI(4h): ${rsi4h}, RSI(15m): ${rsi15m}`);
    } catch (e) {
        console.error("   [Strategy] Failed to fetch market data. Aborting rebalance to keep old position safe.");
        throw e; // keep old position
    }

    // 1. Exit Old Position
    if (oldTokenId !== "0") {
        await atomicExitPosition(wallet, oldTokenId);
        saveState({ tokenId: "0" });
    }

    // 2. Swap to align portfolio ratio
    try {
        await rebalancePortfolio(wallet, configuredPool, oldTokenId);
    } catch (e) {
        console.error("   [Rebalance] Swap failed:", e);
        await sendEmailAlert("Rebalance Swap Failed", `Swap likely reverted due to Slippage or Gas: ${e}`);
        throw e; 
    }

    console.log("   [System] Refreshing market data...");

    // 3. Refresh Data (Fetch latest Price/Liquidity)
    // Need to re-fetch data because the swap above changed the pool state
    const [newSlot0, newLiquidity] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
    ]);

    const newCurrentTick = Number(newSlot0.tick);

    const freshPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        newSlot0.sqrtPriceX96.toString(),
        newLiquidity.toString(),
        newCurrentTick
    );

    console.log(`   [Update] Tick: ${newCurrentTick}`);

    // ============================================================
    // DYNAMIC RANGE CALCULATION (ATR + RSI SKEW)
    // ============================================================

    const priceStr =
        freshPool.token0.address === WETH_TOKEN.address
            ? freshPool.token0Price.toSignificant(6)
            : freshPool.token1Price.toSignificant(6);
    const currentPrice = parseFloat(priceStr);

    const volPercent = (atr / currentPrice) * 100;

    let dynamicWidth = Math.floor(volPercent * 100 * ATR_SAFETY_FACTOR);

    console.log(
        `   [Strategy] ATR: $${atr.toFixed(2)} | Vol: ${volPercent.toFixed(2)}% | Calc Width: ${dynamicWidth}`
    );

    const WIDTH = Math.max(500, Math.min(dynamicWidth, 4000));

    console.log(`   [Strategy] Base Radius Width: ${WIDTH}`);

    const tickSpace = freshPool.tickSpacing;
    const MIN_TICK = -887272;
    const MAX_TICK = 887272;


    let skew = 0.5;

    // [Strategy Update] Multi-Timeframe Skew Logic
    // 1. Base Skew on Macro Trend (4h)
    // Trend Following: If trend is UP, we want more range ABOVE current price to capture gains.
    if (rsi4h > 60) {
        skew = 0.6; // Bullish Trend -> Shift range UP
        console.log(`   [Strategy] Trend is Bullish (RSI 4h: ${rsi4h}). Skewing UP.`);
    } else if (rsi4h < 40) {
        skew = 0.4; // Bearish Trend -> Shift range DOWN
        console.log(`   [Strategy] Trend is Bearish (RSI 4h: ${rsi4h}). Skewing DOWN.`);
    } else {
        console.log(`   [Strategy] Trend is Neutral (RSI 4h: ${rsi4h}). Keeping Symmetric.`);
    }

    // 2. Safety Check with Short-term Momentum (15m)
    // If we are Bullish but 15m is Overbought, dampen the skew (don't chase the top)
    if (skew > 0.5 && rsi15m > 70) {
        skew = 0.55; 
        console.log(`   [Strategy] Short-term Overbought (RSI 15m: ${rsi15m}). Dampening Bullish Skew.`);
    } else if (skew < 0.5 && rsi15m < 30) {
        skew = 0.45;
        console.log(`   [Strategy] Short-term Oversold (RSI 15m: ${rsi15m}). Dampening Bearish Skew.`);
    }

    const totalSpan = WIDTH * 2;

    const upperTickDiff = Math.floor(totalSpan * skew);
    const lowerTickDiff = Math.floor(totalSpan * (1 - skew));

    let tickLower =
        Math.floor((newCurrentTick - lowerTickDiff) / tickSpace) * tickSpace;
    let tickUpper =
        Math.floor((newCurrentTick + upperTickDiff) / tickSpace) * tickSpace;

    if (tickLower < MIN_TICK)
        tickLower = Math.ceil(MIN_TICK / tickSpace) * tickSpace;
    if (tickUpper > MAX_TICK)
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;

    if (tickLower >= tickUpper) {
        tickUpper = tickLower + tickSpace;
    }

    if (tickUpper > MAX_TICK) {
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;
        tickLower = tickUpper - tickSpace;
    }

    console.log(
        `   New Range: [${tickLower}, ${tickUpper}] (Skew: ${skew}, Span: ${
            tickUpper - tickLower
        })`
    );

    const newTokenId = await mintMaxLiquidity(
        wallet,
        freshPool,
        tickLower,
        tickUpper
    );
    const usdcBalanceAfterMint = await getBalance(USDC_TOKEN, wallet);
    saveState({ tokenId: newTokenId, lastKnownUSDCBalance: usdcBalanceAfterMint.toString() });
}