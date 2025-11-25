import { ethers } from "ethers";
import { Pool } from "@uniswap/v3-sdk";
import * as dotenv from "dotenv";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    POOL_ABI,
    NPM_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    V3_FACTORY_ADDR,
} from "./config";
import { sleep, withRetry, sendEmailAlert } from "./src/utils"; // Added sendEmailAlert
import { loadState, saveState } from "./src/state";
import {
    approveAll,
    atomicExitPosition,
    rebalancePortfolio,
    mintMaxLiquidity,
    executeFullRebalance,
    getBalance,
} from "./src/actions";

dotenv.config();

// Global variable to track price changes between cycles
let LAST_PRICE: number = 0;
const PRICE_SHOCK_LIMIT =
    Number(process.env.PRICE_SHOCK_THRESHOLD_PERCENT) || 10;

// ==========================================
// Main Logic
// ==========================================

async function runLifeCycle() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

    const poolAddr = Pool.getAddress(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        undefined,
        V3_FACTORY_ADDR
    );
    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const npm = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        NPM_ABI,
        wallet
    );

    console.log(`\n[System] Cycle Start | ${new Date().toISOString()}`);

    await approveAll(wallet);

    const [slot0, liquidity] = await withRetry(() =>
        Promise.all([poolContract.slot0(), poolContract.liquidity()])
    );

    const configuredPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        slot0.sqrtPriceX96.toString(),
        liquidity.toString(),
        Number(slot0.tick)
    );
    const currentTick = Number(slot0.tick);

    // Calculate Price
    const priceStr =
        configuredPool.token0.address === WETH_TOKEN.address
            ? configuredPool.token0Price.toSignificant(6)
            : configuredPool.token1Price.toSignificant(6);

    const currentPrice = parseFloat(priceStr);

    console.log(
        `   Price: 1 WETH = ${currentPrice} USDC | Tick: ${currentTick}`
    );

    if (LAST_PRICE > 0) {
        const priceChange =
            Math.abs((currentPrice - LAST_PRICE) / LAST_PRICE) * 100;

        console.log(
            `   [Market] Price Change: ${priceChange.toFixed(2)}% (Limit: ${PRICE_SHOCK_LIMIT}%)`
        );

        if (priceChange > PRICE_SHOCK_LIMIT) {
            const msg = `EMERGENCY STOP: Price changed by ${priceChange.toFixed(2)}% in 5 minutes! \nOld: ${LAST_PRICE} \nNew: ${currentPrice}`;
            console.error(msg);
            await sendEmailAlert("PRICE SHOCK - SHUTTING DOWN", msg);
            process.exit(1); // Kill the bot to prevent trading in chaos
        }
    }
    // Update global tracker
    LAST_PRICE = currentPrice;

    let { tokenId } = loadState();

    // Branch A: Create new Position
    if (tokenId === "0") {
        console.log(`   [Action] No position. Starting fresh.`);
        await executeFullRebalance(wallet, configuredPool, "0");
        return;
    }

    // Branch B: Manage Existing Position
    try {
        const pos = await withRetry(() => npm.positions(tokenId));

        if (pos.liquidity === 0n && pos.tickLower === 0n) {
            console.warn(
                `   [Warning] Position ${tokenId} is dead. Resetting.`
            );
            saveState("0");
            return;
        }

        const tl = Number(pos.tickLower);
        const tu = Number(pos.tickUpper);

        if (currentTick < tl || currentTick > tu) {
            console.log(
                `   [Action] Out of Range! (${tl} < ${currentTick} < ${tu})`
            );

            // ============================================================
            // 2. Optimization: Fee Collection Alert
            // ============================================================
            const fees0 = ethers.formatUnits(pos.tokensOwed0, 18);
            const fees1 = ethers.formatUnits(pos.tokensOwed1, 6);
            const feeMsg = `Rebalancing triggered! Collected Fees: ${fees0} WETH + ${fees1} USDC`;

            console.log(`   [Email] Sending Fee Alert...`);
            await sendEmailAlert("Fees Collected & Rebalancing", feeMsg);

            // Trigger the full atomic rebalance workflow
            await executeFullRebalance(wallet, configuredPool, tokenId);
        } else {
            console.log(`   [Status] In Range.`);

            // Enhanced Fee Display: Force higher precision
            // Use parseFloat to handle strings correctly, then toFixed(8) to show 8 decimal places
            const fees0Raw = ethers.formatUnits(pos.tokensOwed0, 18);
            const fees1Raw = ethers.formatUnits(pos.tokensOwed1, 6);

            // Convert to number and force 8 decimals to see tiny amounts
            const fees0 = parseFloat(fees0Raw).toFixed(8);
            const fees1 = parseFloat(fees1Raw).toFixed(6);

            console.log(`   Unclaimed Fees: ${fees0} WETH / ${fees1} USDC`);
        }
    } catch (e) {
        console.error(`   [Error] Cycle failed:`, e);
        await sendEmailAlert("Bot Error", `The bot encountered an error: ${e}`);
    }
}

async function main() {
    // Send startup email
    await sendEmailAlert("Bot Started", "Arbitrum V3 Bot is now running.");

    while (true) {
        try {
            await runLifeCycle();
        } catch (e) {
            console.error("[Fatal] Main loop error:", e);
            await sendEmailAlert("FATAL CRASH", `Main loop crashed: ${e}`);
            await sleep(10000);
        }
        console.log(`[System] Sleeping 5 min...`);
        await sleep(5 * 60 * 1000);
    }
}

main();
