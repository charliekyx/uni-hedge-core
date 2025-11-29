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
} from "../config";

import { withRetry, waitWithTimeout } from "./utils";
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

    const pos = await withRetry(() => npm.positions(tokenId));
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
    configuredPool: Pool
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

    if (usdcAmount.greaterThan(wethValueInUsdc)) {
        // Sell USDC
        const diff = usdcAmount.subtract(wethValueInUsdc);
        const amountToSell = diff.divide(2);

        if (BigInt(amountToSell.quotient.toString()) < REBALANCE_THRESHOLD_USDC) {
            console.log("   Balance is good enough. Skipping swap.");
            return;
        }
        console.log(
            `   [Swap] Selling ${amountToSell.toSignificant(6)} USDC for WETH`
        );

        const tx = await router.exactInputSingle({
            tokenIn: USDC_TOKEN.address,
            tokenOut: WETH_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountToSell.quotient.toString(),
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
        });
        await waitWithTimeout(tx, TX_TIMEOUT_MS);
    } else {
        // Sell WETH
        const diffValueInUsdc = wethValueInUsdc.subtract(usdcAmount);
        const amountToSellValue = diffValueInUsdc.divide(2);

        const priceUsdcToWeth =
            configuredPool.token0.address === USDC_TOKEN.address
                ? configuredPool.token0Price
                : configuredPool.token1Price;

        const amountToSell = priceUsdcToWeth.quote(amountToSellValue);

        if (BigInt(amountToSell.quotient.toString()) < REBALANCE_THRESHOLD_WETH) {
            console.log("   Balance is good enough. Skipping swap.");
            return;
        }

        console.log(
            `   [Swap] Selling ${amountToSell.toSignificant(6)} WETH for USDC`
        );

        const tx = await router.exactInputSingle({
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountToSell.quotient.toString(),
            amountOutMinimum: 0,
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

    // Calculate 99.9% of balance to avoid rounding errors causing reverts
    // BigInt math: amount * 999 / 1000
    // to ensure there is always a tiny bit more tokens in the wallet than the contract asks for.
    // This prevents "Insufficient Balance" reverts caused by tiny math discrepancies between the SDK and the Smart Contract.

    // Temporary debugging: Use only 50% of balance to rule out "Insufficient Funds" completely
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
            const toAddress = ethers.dataSlice(log.topics[2], 12); // Take last 20 bytes
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

    // TokenID is in the 3rd topic (indexed) for ERC721 Transfer
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

    // 1. Exit Old Position
    if (oldTokenId !== "0") {
        await atomicExitPosition(wallet, oldTokenId);
    }

    // 2. Swap to align portfolio ratio
    await rebalancePortfolio(wallet, configuredPool);

    console.log("   [System] Refreshing market data...");

    // 3. Refresh Data (Fetch latest Price/Liquidity)
    const poolAddr = Pool.getAddress(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        undefined,
        V3_FACTORY_ADDR
    );
    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, wallet);

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

    // A. Get ATR (Volatility)
    const atr = await getEthAtr("1h"); // e.g., 45 USD

    // B. Convert ATR to Ticks
    // Rule of thumb: 1% Price Move ~= 100 Ticks
    // Price is approx `configuredPool.token0Price` (if WETH is T0) or inverse
    const priceStr =
        freshPool.token0.address === WETH_TOKEN.address
            ? freshPool.token0Price.toSignificant(6)
            : freshPool.token1Price.toSignificant(6);
    const currentPrice = parseFloat(priceStr);

    // Volatility Percentage = ATR / Price
    // Example: 50 / 3000 = 1.6%
    const volPercent = (atr / currentPrice) * 100;

    // Dynamic Width = Volatility% * 100 Ticks * SafetyFactor
    // SafetyFactor 4 means we cover 4x the hourly volatility
    let dynamicWidth = Math.floor(volPercent * 100 * ATR_SAFETY_FACTOR);

    console.log(
        `   [Strategy] ATR: $${atr.toFixed(2)} | Vol: ${volPercent.toFixed(2)}% | Calc Width: ${dynamicWidth}`
    );

    // C. Clamp Limits (Don't go too narrow or too wide)
    // Min: 500 ticks (Tight)
    // Max: 4000 ticks (Wide)
    // WIDTH here represents the "Radius" (half of the total range)
    const WIDTH = Math.max(500, Math.min(dynamicWidth, 4000));

    console.log(`   [Strategy] Base Radius Width: ${WIDTH}`);

    // D. Calculate Range with RSI SKEW
    const tickSpace = freshPool.tickSpacing;
    const MIN_TICK = -887272;
    const MAX_TICK = 887272;

    // 1. Get RSI
    const rsi = await getEthRsi("1h");
    console.log(`   [Strategy] RSI Check: ${rsi.toFixed(2)}`);

    // 2. Determine Skew Factor
    // 0.5 = Symmetric (Default)
    // > 0.5 = More space above (Bullish)
    // < 0.5 = More space below (Bearish)
    let skew = 0.5;

    if (rsi > 75) {
        // Overbought -> Price likely to drop.
        // Skew range DOWN: Less space above, more space below to catch the dip.
        skew = 0.3;
        console.log(`   [Strategy] RSI High -> Skewing Range DOWN (Bearish Setup)`);
    } else if (rsi < 25) {
        // Oversold -> Price likely to bounce.
        // Skew range UP: More space above to catch the rally, less space below.
        skew = 0.7;
        console.log(`   [Strategy] RSI Low -> Skewing Range UP (Bullish Setup)`);
    } else {
        console.log(`   [Strategy] RSI Neutral -> Symmetric Range`);
    }

    // 3. Apply Skew
    // Total span is roughly WIDTH * 2 (since WIDTH was calculated as a radius)
    const totalSpan = WIDTH * 2;

    const upperTickDiff = Math.floor(totalSpan * skew);
    const lowerTickDiff = Math.floor(totalSpan * (1 - skew));

    let tickLower =
        Math.floor((newCurrentTick - lowerTickDiff) / tickSpace) * tickSpace;
    let tickUpper =
        Math.floor((newCurrentTick + upperTickDiff) / tickSpace) * tickSpace;

    // E. Boundary Checks and Sanitization
    if (tickLower < MIN_TICK)
        tickLower = Math.ceil(MIN_TICK / tickSpace) * tickSpace;
    if (tickUpper > MAX_TICK)
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;

    // Ensure tickUpper > tickLower
    if (tickLower >= tickUpper) {
        // Force minimum spacing if calculation collapsed the range
        tickUpper = tickLower + tickSpace;
    }

    // Clamp again if upper exceeded max due to adjustment
    if (tickUpper > MAX_TICK) {
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;
        tickLower = tickUpper - tickSpace;
    }

    console.log(
        `   New Range: [${tickLower}, ${tickUpper}] (Skew: ${skew}, Span: ${
            tickUpper - tickLower
        })`
    );

    // 4. Mint New Position
    const newTokenId = await mintMaxLiquidity(
        wallet,
        freshPool,
        tickLower,
        tickUpper
    );
    saveState(newTokenId);
}