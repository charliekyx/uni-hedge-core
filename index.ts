import { ethers, NonceManager } from "ethers";
import { Pool, Position } from "@uniswap/v3-sdk";

import * as dotenv from "dotenv";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    POOL_ABI,
    NPM_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    V3_FACTORY_ADDR,
    RSI_OVERBOUGHT,
    RSI_OVERSOLD,
} from "./config";

import { loadState } from "./src/state"; // Now uses Redis
import { approveAll, executeFullRebalance } from "./src/actions";
import { AaveManager } from "./src/hedge";
import { RobustProvider } from "./src/connection";
import { sendEmailAlert } from "./src/utils";
import { getEthRsi } from "./src/analytics";

dotenv.config();

const HEDGE_CHECK_INTERVAL_MS = 60 * 1000; // 60s Throttle for Rebalance/Hedge
const HEDGE_THRESHOLD_ETH = ethers.parseEther("0.05"); // Min delta to bother hedging

let wallet: ethers.Wallet;
let provider: ethers.Provider;
let robustProvider: RobustProvider;
let npm: ethers.Contract;
let poolContract: ethers.Contract;
let aave: AaveManager;

let isProcessing = false; // Lock to prevent overlapping executions

let lastHedgeTime = 0; // State for throttling

async function initialize() {
    const rpcUrl = process.env.RPC_URL || "";

    // Initialize Robust WebSocket Provider
    robustProvider = new RobustProvider(rpcUrl, async () => {
        console.log("[System] Reconnected. Re-binding events...");
        await setupEventListeners();
    });

    provider = robustProvider.getProvider();
  const baseWallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    
    // 1. 创建 NonceManager
    const managedWallet = new NonceManager(baseWallet);
    
    // 2. [关键修复] 手动把 address 属性贴上去
    // 这样 src/hedge.ts 里的 this.wallet.address 就不会报错了
    (managedWallet as any).address = baseWallet.address;

    // 3. 赋值给全局变量
    wallet = managedWallet as any;
    console.log(`[System] Wallet initialized with NonceManager: ${await wallet.getAddress()}`);
    
    const poolAddr = Pool.getAddress(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        undefined,
        V3_FACTORY_ADDR
    );
    poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
    npm = new ethers.Contract(
        NONFUNGIBLE_POSITION_MANAGER_ADDR,
        NPM_ABI,
        wallet
    );
    aave = new AaveManager(wallet);

    console.log(`[System] Initialized. Wallet: ${wallet.address}`);

    // Initial Checks
    await approveAll(wallet);

    await setupEventListeners();
}

async function setupEventListeners() {
    provider.removeAllListeners();
    console.log("[System] Listening for blocks...");

    provider.on("block", async (blockNumber) => {
        if (isProcessing) return;
        isProcessing = true;

        try {
            await onNewBlock(blockNumber);
        } catch (e) {
            console.error(`[Block ${blockNumber}] Error:`, e);
        } finally {
            isProcessing = false;
        }
    });
}

async function onNewBlock(blockNumber: number) {
    // 1. Load State (Fast, usually local Redis/File)
    const { tokenId } = await loadState();

    if (!tokenId || tokenId === "0") {
        console.log(
            `[Block ${blockNumber}] No active position. Initializing Strategy...`
        );

        const [slot0, liquidity] = await Promise.all([
            poolContract.slot0(),
            poolContract.liquidity(),
        ]);

        const configuredPool = new Pool(
            USDC_TOKEN,
            WETH_TOKEN,
            POOL_FEE,
            slot0.sqrtPriceX96.toString(),
            liquidity.toString(),
            Number(slot0.tick)
        );

        await executeFullRebalance(wallet, configuredPool, "0");

        lastHedgeTime = 0;
        return;
    }

    // ============================================================
    // CRITICAL PATH: SAFETY CHECK (Every Block, No Throttle)
    // ============================================================
    // This protects against flash crashes or liquidation events.
    const isSafe = await aave.checkHealthAndPanic(tokenId);

    if (!isSafe) {
        console.log("[System] Panic exit triggered. Halting strategy.");
        process.exit(1); // Stop the bot
    }

    // ============================================================
    // STRATEGY PATH: REBALANCE & HEDGE (Throttled)
    // ============================================================

    const now = Date.now();
    if (now - lastHedgeTime < HEDGE_CHECK_INTERVAL_MS) {
        return; // Skip delta logic, save RPC/Gas
    }

    console.log(`[Block ${blockNumber}] Running Strategy Logic...`);

    // Fetch Uniswap Data (RPC Heavy)
    const [slot0, liquidity] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
    ]);

    const currentTick = Number(slot0.tick);
    const sqrtPriceX96 = slot0.sqrtPriceX96.toString();

    // Construct Pool
    const configuredPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        sqrtPriceX96,
        liquidity.toString(),
        currentTick
    );

    // Check Rebalance Necessity (Range check)
    const pos = await npm.positions(tokenId);
    if (pos.liquidity === 0n) {
        // 1. Send Notification
        await sendEmailAlert(
            "CRITICAL: Position has 0 Liquidity (Closed).",
            `Stopping monitor for this ID (${tokenId}).`
        );

        // 2. Break the loop logic
        // Option A: If this is a single-run script, exit with error
        // process.exit(1);

        // Option B: If this is a loop/array, return false/null to signal removal
        return null;
    }

    const tl = Number(pos.tickLower);
    const tu = Number(pos.tickUpper);

    if (currentTick < tl || currentTick > tu) {
        console.log(`[Strategy] Out of Range. Rebalancing...`);    
        await executeFullRebalance(wallet, configuredPool, tokenId);
        lastHedgeTime = Date.now(); // Reset timer
        return;
    }

    // Check Hedge Necessity (Delta check)
    // Calculate ETH Amount in LP
    const positionSDK = new Position({
        pool: configuredPool,
        liquidity: pos.liquidity.toString(),
        tickLower: tl,
        tickUpper: tu,
    });

    const amount0 = BigInt(positionSDK.amount0.quotient.toString());
    const amount1 = BigInt(positionSDK.amount1.quotient.toString());

    // Determine which is ETH based on address sort order
    const lpEthAmount =
        WETH_TOKEN.address.toLowerCase() < USDC_TOKEN.address.toLowerCase()
            ? amount0
            : amount1;

    // Execute Hedge Adjustment
    // Note: adjustHedge inside AaveManager should calculate debt and compare diff
    await aave.adjustHedge(lpEthAmount, tokenId);

    lastHedgeTime = Date.now();
}

initialize().catch(console.error);
