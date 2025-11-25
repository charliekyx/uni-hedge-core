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
} from "../config";
import { withRetry, waitWithTimeout } from "./utils";
import { saveState } from "./state";

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
    const spenders = [NONFUNGIBLE_POSITION_MANAGER_ADDR, SWAP_ROUTER_ADDR];

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
    console.log(`[Debug] Checking balances for wallet: ${wallet.address}`);
    console.log(`[Debug] USDC Contract: ${USDC_TOKEN.address}`);
    console.log(`[Debug] WETH Contract: ${WETH_TOKEN.address}`);

    console.log(`\n[Rebalance] Calculating Optimal Swap...`);

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

   
    console.log(`[Debug] USDC amount: ${usdcAmount.toSignificant(6)}`);
    console.log(`[Debug] WETH amount: ${wethAmount.toSignificant(18)}`);
    console.log(`[Debug] wethValueInUsdc amount: ${wethValueInUsdc.toSignificant(6)}`);

    // 5 USDC (6 decimals) = 5,000,000
    const THRESHOLD_USDC = 5_000_000n;
    // 0.002 WETH (18 decimals) = 2,000,000,000,000,000
    const THRESHOLD_WETH = 2_000_000_000_000_000n;

    if (usdcAmount.greaterThan(wethValueInUsdc)) {
        // Sell USDC
        const diff = usdcAmount.subtract(wethValueInUsdc);
        const amountToSell = diff.divide(2);

        if (BigInt(amountToSell.quotient.toString()) < THRESHOLD_USDC) {
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

        if (BigInt(amountToSell.quotient.toString()) < THRESHOLD_WETH) {
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

    // This prevents Reverts (good for bot uptime) while stopping total disasters (good for wallet)
    const SLIPPAGE_TOLERANCE_WIDE = new Percent(300, 10_000); // 3%

    // const { amount0: amount0Min, amount1: amount1Min } =
    //     position.mintAmountsWithSlippage(SLIPPAGE_TOLERANCE_WIDE);

    const mintParams = {
        token0: configuredPool.token0.address,
        token1: configuredPool.token1.address,
        fee: POOL_FEE,
        tickLower,
        tickUpper,
        amount0Desired: position.mintAmounts.amount0.toString(),
        amount1Desired: position.mintAmounts.amount1.toString(),

        // todo: 强制改为 "0" for now!!!!!!! need to fine-tune
        amount0Min: "0",
        amount1Min: "0",

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
    const npm = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        NPM_ABI,
        wallet
    );

    // 1. Burn old position if exists
    if (oldTokenId !== "0") {
        await atomicExitPosition(wallet, oldTokenId);
    }

    // 2. Rebalance (Swap)
    await rebalancePortfolio(wallet, configuredPool);

    // ============================================================
    // Refresh Pool State After Swap
    // ============================================================
    console.log(
        "   [System] Refreshing market price and liquidity after swap..."
    );

    // Explicitly passing V3_FACTORY_ADDR is required for Sepolia
    const poolAddr = Pool.getAddress(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        undefined,
        V3_FACTORY_ADDR
    );
    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, wallet);

    // Fetch fresh slot0 AND liquidity
    const [newSlot0, newLiquidity] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
    ]);

    const newCurrentTick = Number(newSlot0.tick);

    // Create a FRESH pool instance for accurate Mint math
    const freshPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        newSlot0.sqrtPriceX96.toString(),
        newLiquidity.toString(),
        newCurrentTick
    );

    console.log(
        `   [Update] Price moved from ${configuredPool.tickCurrent} to ${newCurrentTick}`
    );

    // 3. Calculate new Tick Range
    const tickSpace = freshPool.tickSpacing;
    const WIDTH = 2000;
    const MIN_TICK = -887272;
    const MAX_TICK = 887272;

    let tickLower =
        Math.floor((newCurrentTick - WIDTH) / tickSpace) * tickSpace;
    let tickUpper =
        Math.floor((newCurrentTick + WIDTH) / tickSpace) * tickSpace;

    if (tickLower < MIN_TICK)
        tickLower = Math.ceil(MIN_TICK / tickSpace) * tickSpace;
    if (tickUpper > MAX_TICK)
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;

    if (tickLower === tickUpper) tickUpper += tickSpace;
    if (tickUpper > MAX_TICK) {
        tickUpper = Math.floor(MAX_TICK / tickSpace) * tickSpace;
        tickLower = tickUpper - tickSpace;
    }
    if (tickLower > tickUpper) [tickLower, tickUpper] = [tickUpper, tickLower];

    console.log(`   New Range: [${tickLower}, ${tickUpper}]`);

    // 4. Mint (Using the FRESH pool instance)
    const newTokenId = await mintMaxLiquidity(
        wallet,
        freshPool,
        tickLower,
        tickUpper
    );

    // 5. Save State
    saveState(newTokenId);
}
