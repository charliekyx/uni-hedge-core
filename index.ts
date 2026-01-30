import { ethers, NonceManager } from "ethers";
import { Pool, Position } from "@uniswap/v3-sdk";
import * as fs from "fs";
import * as dotenv from "dotenv";
import * as readline from "readline";
import { Writable } from "stream";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    POOL_ABI,
    NPM_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
    V3_FACTORY_ADDR,
    AUTO_INVEST_NEW_FUNDS,
    AUTO_INVEST_THRESHOLD_USDC,
    PULLBACK_THRESHOLD, // &lt;-- Imported from config
    ERC20_ABI,
    CIRCUIT_BREAKER_ENABLED,
    CIRCUIT_BREAKER_THRESHOLD,
    STOP_LOSS_KEEP_WETH_PERCENT,
    SWAP_ROUTER_ADDR,
    SWAP_ROUTER_ABI,
    MAX_UINT128,
} from "./config";

import { loadState, scanLocalOrphans, saveState } from "./src/state"; // [Added] scanLocalOrphans
import { approveAll, executeFullRebalance, getBalance, atomicExitPosition } from "./src/actions";
import { AaveManager } from "./src/hedge";
import { RobustProvider } from "./src/connection";
import { sendEmailAlert } from "./src/utils";
import { getEthRsi } from "./src/analytics";

dotenv.config();

const HEDGE_CHECK_INTERVAL_MS = 60 * 1000; // 1 min

let wallet: ethers.Wallet;
let provider: ethers.Provider;
let robustProvider: RobustProvider;
let npm: ethers.Contract;
let poolContract: ethers.Contract;
let aave: AaveManager;

let isProcessing = false; 
let lastHedgeTime = 0; 

// Safe Mode Flag
let isSafeMode = false;

// [Auto-Resume]
let isProfitStandby = false; // Is it in standby after taking profit
let profitSecuredPrice = 0;  // Record the price at profit taking

// Last run timestamp for block listener throttling
let lastRunTime = 0;
const MIN_INTERVAL_MS = 3000; // 3s

// [Circuit Breaker]
let lastAlertTime = 0;

async function initialize() {
    const rpcEnv = process.env.RPC_URL || "";
    const rpcUrls = rpcEnv.split(',').map(u => u.trim()).filter(u => u.length > 0);

    if (rpcUrls.length === 0) {
        throw new Error("RPC_URL is not set in .env");
    }

    console.log(`[System] Loaded ${rpcUrls.length} RPC nodes.`);

    // Initialize Robust WebSocket Provider with Fallback
    robustProvider = new RobustProvider(rpcUrls, async () => {
        console.log("[System] Provider switched/reconnected. Re-binding events...");
        
        provider = robustProvider.getProvider();
        
        // [Important] Wallet also needs to reconnect to the new Provider, otherwise transactions will fail with Network Error
        // Note: Since wallet is a global variable, we need to update its provider
       const newWallet = wallet.connect(provider);

        const userAddress = await newWallet.getAddress();
        (newWallet as any).address = userAddress;
        
        wallet = newWallet as any;
        
        poolContract = poolContract.connect(provider) as ethers.Contract;
        npm = npm.connect(wallet) as ethers.Contract; 
        aave = new AaveManager(wallet);

        console.log("[System] Contracts and Managers re-linked to new provider.");
        
        await setupEventListeners();
    });

    provider = robustProvider.getProvider();
    
    // [Note] When initializing wallet here
    // --- [New] Secure Wallet Initialization ---
    let baseWallet: ethers.Wallet;
    const keystorePath = process.env.KEYSTORE_PATH;
    const privateKey = process.env.PRIVATE_KEY;

    if (keystorePath) {
        console.log(`[Security] Initializing wallet from encrypted keystore: ${keystorePath}`);
        if (!fs.existsSync(keystorePath)) {
            throw new Error(`Keystore file not found at path: ${keystorePath}`);
        }
        const keystoreJson = fs.readFileSync(keystorePath, 'utf8');
        let password = process.env.KEYSTORE_PASSWORD;

        if (!password) {
            console.log("[Security] KEYSTORE_PASSWORD not found in .env. Switching to manual input mode.");
            password = await askHidden("Please enter Keystore Password to unlock wallet: ");
        }

        try {
            // Decrypt and connect to provider
            const decryptedWallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
            baseWallet = decryptedWallet.connect(provider) as ethers.Wallet;
        } catch (e) {
            console.error("[Security] Failed to decrypt keystore. Please check your password and keystore file.");
            // Hide detailed error to avoid leaking info
            throw new Error("Keystore decryption failed."); 
        }
        console.log("[Security] Wallet successfully decrypted from keystore.");

    } else if (privateKey) {
        console.warn("[Security] WARNING: Initializing wallet from a plaintext PRIVATE_KEY. For production and larger funds, using an encrypted keystore is strongly recommended.");
        baseWallet = new ethers.Wallet(privateKey, provider);
    } else {
        console.log("[Security] No credentials found in .env. Switching to manual private key input mode.");
        let inputKey = await askHidden("Please enter your Private Key (hidden): ");
        inputKey = inputKey.trim();
        if (!inputKey) throw new Error("No private key entered.");
        if (!inputKey.startsWith("0x")) inputKey = "0x" + inputKey;
        baseWallet = new ethers.Wallet(inputKey, provider);
        console.log("[Security] Wallet temporarily loaded from manual input.");
    }
    const managedWallet = new NonceManager(baseWallet);
    (managedWallet as any).address = baseWallet.address;
    wallet = managedWallet as any;

    console.log(`[System] Wallet initialized: ${await wallet.getAddress()}`);
    
    const poolAddr = Pool.getAddress(USDC_TOKEN, WETH_TOKEN, POOL_FEE, undefined, V3_FACTORY_ADDR);
    poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
    npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    aave = new AaveManager(wallet);

    console.log(`[System] Initialized.`);

    await approveAll(wallet);

    // Orphan Position Scanning
    // If local state is 0 but on-chain position exists, sync state.
    const state = loadState();
    if (state.tokenId === "0") {
        await scanLocalOrphans(wallet);
    }

    await setupEventListeners();

    // 每天 (24小时) 发送一次状态报告
    setInterval(async () => {
        try {
            const balUSDC = await getBalance(USDC_TOKEN, wallet);
            const balWETH = await getBalance(WETH_TOKEN, wallet);
            const { tokenId } = await loadState();
            
            const msg = `
            [Daily Report]
            Status: ${isProfitStandby ? `STANDBY (All USDC, profit taken at $${profitSecuredPrice})` : "ACTIVE (Farming)"}
            Token ID: ${tokenId || "None"}
            Balance USDC: ${ethers.formatUnits(balUSDC, 6)}
            Balance WETH: ${ethers.formatEther(balWETH)}
            `;
            
            console.log("[System] Sending Daily Report...");
            await sendEmailAlert("Daily Bot Report", msg);
        } catch (e) {
            console.error("[System] Daily report failed:", e);
            await sendEmailAlert("Daily Bot Report FAILED", `Failed to generate report: ${e}`);
        }
    }, 24 * 60 * 60 * 1000); // 24小时

}

async function setupEventListeners() {
    provider.removeAllListeners();
    console.log("[System] Listening for blocks...");

    provider.on("block", async (blockNumber) => {

        // Safe Mode Check
        if (isSafeMode) {
            if (blockNumber % 100 === 0) { // Reduce log noise
                console.warn(`[SafeMode] Bot is in SAFE MODE. No actions taken. Block: ${blockNumber}`);
            }
            return;
        }

        if (isProcessing) return;
        isProcessing = true;

        const now = Date.now();
        
        if (now - lastRunTime < MIN_INTERVAL_MS) {
            console.log("[rpc limit]: skip less than")
            return; 
        }

        try {
            lastRunTime = now; 
            await onNewBlock(blockNumber);
        } catch (e) {
            if ((e as Error).message.includes("PROFIT_SECURED")) {
                console.log("[System] Strategy Triggered: Profit Secured.");
                console.log("[System] Entering STANDBY MODE. Will periodically check for reentry conditions.");
                
                // 发送邮件通知，但不退出了
                await sendEmailAlert("Bot Standby: Profit Secured", `Sold all ETH for USDC. Bot is now waiting for opportunities.`);
                
                isProfitStandby = true; // &lt;--- 关键：标记为待机

                // --- 记录当前价格 ---
                try {
                    const slot0 = await poolContract.slot0();
                    const configuredPool = new Pool(
                        USDC_TOKEN,
                        WETH_TOKEN,
                        POOL_FEE,
                        slot0.sqrtPriceX96.toString(),
                        "0", // Liquidity doesn't matter for price
                        Number(slot0.tick)
                    );
                    // [Fix] Dynamically determine which token is WETH to get the correct price (USDC per WETH)
                    const priceStr = (configuredPool.token0.address.toLowerCase() === WETH_TOKEN.address.toLowerCase()) 
                        ? configuredPool.token0Price.toSignificant(6) 
                        : configuredPool.token1Price.toSignificant(6);
                    profitSecuredPrice = parseFloat(priceStr);
                    console.log(`[Standby] Profit secured at price: ${profitSecuredPrice}`);
                } catch (priceError) {
                    console.error("[Standby] CRITICAL: Failed to record profit-taking price:", priceError);
                    // If we can't get the price, we can't automatically re-enter.
                    // Send an alert and keep it in standby for manual intervention.
                    await sendEmailAlert("Bot Standby Error", "Profit secured, but failed to record current price. Manual restart required after dip.");
                }
                
                return; // End processing for this block
            }
            console.error(`[Block ${blockNumber}] Error:`, e);
        } finally {
            isProcessing = false;
        }
    });
}

async function onNewBlock(blockNumber: number) {
    let { tokenId, lastKnownUSDCBalance, stopLossTriggered, circuitBreakerPrice } = await loadState() as any;

    // --- [Circuit Breaker] Stop Loss Check ---
    if (stopLossTriggered) {
        if (blockNumber % 50 === 0) console.log(`[StopLoss] Bot is in STOP_LOSS mode. Monitoring for revival conditions...`);
        
        // Revival Monitor: Check if price drops 10% below exit price (Good entry) or recovers
        if (circuitBreakerPrice) {
            const currentPrice = await getPrice();
            const targetEntry = circuitBreakerPrice * 0.90; // 10% drop
            
            // [Strategy] Multi-Timeframe RSI Check
            // 1h is too slow for flash crashes. We use 15m for speed and 4h for trend context.
            let rsi15m = 50;
            let rsi4h = 50;
            try {
                [rsi15m, rsi4h] = await Promise.all([
                    getEthRsi("15m"),
                    getEthRsi("4h")
                ]);
            } catch (e) {
                console.warn("[StopLoss] Failed to fetch RSI data.");
            }

            // Condition: Price is cheap (< Target) AND Short-term Panic (RSI 15m < 30)
            if (currentPrice < targetEntry && rsi15m < 30 && (Date.now() - lastAlertTime > 3600 * 1000)) {
                console.log(`[StopLoss] Opportunity detected! Price ${currentPrice} < Target ${targetEntry} | RSI 15m: ${rsi15m} | RSI 4h: ${rsi4h}`);
                await sendEmailAlert("Bot Revival Opportunity", `Price dropped 10% below exit & RSI Oversold.\nCurrent: ${currentPrice}\nTarget: ${targetEntry}\nRSI (15m): ${rsi15m} (Panic)\nRSI (4h): ${rsi4h} (Trend)\n\nUpdate 'stopLossTriggered' to false in state to restart.`);
                lastAlertTime = Date.now();
            }
        }
        return; // Stop all other actions
    }

    // --- [Circuit Breaker] Monitor Total Value ---
    if (CIRCUIT_BREAKER_ENABLED) {
        const totalValue = await calculateTotalAssets(tokenId);
        if (blockNumber % 20 === 0) console.log(`[Monitor] Total Assets: $${totalValue.toFixed(2)} (StopLoss: $${CIRCUIT_BREAKER_THRESHOLD})`);
        
        if (totalValue < CIRCUIT_BREAKER_THRESHOLD) {
            await triggerCircuitBreaker(tokenId, totalValue);
            return;
        }
    }

    let forceRebalance = false;

    // --- [Auto-Resume] Standby Check ---
    if (isProfitStandby) {
        if (profitSecuredPrice > 0) {
            const slot0 = await poolContract.slot0();
            const configuredPool = new Pool(
                USDC_TOKEN,
                WETH_TOKEN,
                POOL_FEE,
                slot0.sqrtPriceX96.toString(),
                "0", // Liquidity doesn't matter for price
                Number(slot0.tick)
            );
            // [Fix] Dynamically determine which token is WETH
            const priceStr = (configuredPool.token0.address.toLowerCase() === WETH_TOKEN.address.toLowerCase()) 
                ? configuredPool.token0Price.toSignificant(6) 
                : configuredPool.token1Price.toSignificant(6);
            const currentPrice = parseFloat(priceStr);
            
            const reentryPrice = profitSecuredPrice * (1 - PULLBACK_THRESHOLD);

            console.log(`[Standby] Checking for re-entry. Current Price: ${currentPrice}, Re-entry Target: < ${reentryPrice.toFixed(2)}`);

            if (currentPrice < reentryPrice) {
                console.log(`[Standby] Price has pulled back sufficiently! Resuming trading...`);
                await sendEmailAlert("Bot Resuming", `Price dropped to ${currentPrice.toFixed(2)}. Re-entering position.`);
                isProfitStandby = false;
                profitSecuredPrice = 0;
                forceRebalance = true; // Force re-invest
            } else {
                 console.log(`[Standby] Bot is holding USDC (Profit Secured). Waiting for dip...`);
            }
        } else {
            console.warn('[Standby] In standby mode but profitSecuredPrice is not set. Manual action may be needed.');
        }
    }

    // --- Auto-Invest Deposit Check ---
    if (AUTO_INVEST_NEW_FUNDS) {
        const currentUSDCBalance = await getBalance(USDC_TOKEN, wallet);
        
        if (lastKnownUSDCBalance === undefined || lastKnownUSDCBalance === "0") {
            console.log("[Auto-Invest] Initializing baseline USDC balance.");

            // If we have funds and no position on startup, invest immediately instead of waiting
            if (tokenId === "0" && currentUSDCBalance >= AUTO_INVEST_THRESHOLD_USDC) {
                console.log(`[Auto-Invest] Initial funds detected (${ethers.formatUnits(currentUSDCBalance, 6)} USDC). Triggering initial investment.`);
                forceRebalance = true;
            } else {
                saveState({ lastKnownUSDCBalance: currentUSDCBalance.toString() });
                lastKnownUSDCBalance = currentUSDCBalance.toString();
            }
        } else {
            const depositAmount = currentUSDCBalance - BigInt(lastKnownUSDCBalance);
            if (depositAmount >= AUTO_INVEST_THRESHOLD_USDC) {
                console.log(`[Auto-Invest] New deposit of ${ethers.formatUnits(depositAmount, 6)} USDC detected. Scheduling a rebalance.`);
                forceRebalance = true;
            }
        }
    }

    if (!tokenId || tokenId === "0") {
        if (forceRebalance || !AUTO_INVEST_NEW_FUNDS) {
            console.log(`[Block ${blockNumber}] No active position. Initializing strategy...`);
            await executeFullRebalanceWrapper(blockNumber, "0", forceRebalance);
            lastHedgeTime = 0;
        } else {
            console.log(`[Block ${blockNumber}] No active position and no new funds to invest. Waiting...`);
        }
        return;
    }

    // ============================================================
    // CRITICAL PATH: SAFETY CHECK
    // ============================================================
    const isSafe = await aave.checkHealthAndPanic(tokenId, poolContract);
    if (!isSafe) {
        console.error("[System] Panic exit triggered. Entering SAFE MODE.");
        await sendEmailAlert("Bot Stopped", "Entered SAFE MODE after panic exit.");
        isSafeMode = true;
        return;
    }
    
    // ============================================================
    // STRATEGY PATH
    // ============================================================
    const now = Date.now();
    if (!forceRebalance && (now - lastHedgeTime < HEDGE_CHECK_INTERVAL_MS)) {
        return;
    }

    console.log(`[Block ${blockNumber}] Running Strategy Logic...`);
    await executeFullRebalanceWrapper(blockNumber, tokenId, forceRebalance);
    lastHedgeTime = Date.now();
}

async function executeFullRebalanceWrapper(blockNumber: number, tokenId: string, force: boolean) {
    const [slot0, liquidity] = await Promise.all([
        poolContract.slot0(),
        poolContract.liquidity(),
    ]);

    const currentTick = Number(slot0.tick);
    const configuredPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        slot0.sqrtPriceX96.toString(),
        liquidity.toString(),
        currentTick
    );
    
    if (tokenId !== "0") {
        const pos = await npm.positions(tokenId);
        if (pos.liquidity === 0n) {
            await sendEmailAlert("CRITICAL: Position Closed.", `ID: ${tokenId}`);
            await scanLocalOrphans(wallet); 
            return;
        }

        const tl = Number(pos.tickLower);
        const tu = Number(pos.tickUpper);

        // If we are not forcing a rebalance AND the position is in range, just adjust the hedge
        if (!force && (currentTick >= tl && currentTick <= tu)) {
            console.log(`[Strategy] In Range. Adjusting Hedge...`);
            
            const positionSDK = new Position({
                pool: configuredPool,
                liquidity: pos.liquidity.toString(),
                tickLower: tl,
                tickUpper: tu,
            });

            const amount0 = BigInt(positionSDK.amount0.quotient.toString());
            const amount1 = BigInt(positionSDK.amount1.quotient.toString());

            const lpEthAmount =
                WETH_TOKEN.address.toLowerCase() < USDC_TOKEN.address.toLowerCase()
                    ? amount0
                    : amount1;

            await aave.adjustHedge(lpEthAmount, tokenId);
            return;
        }
        
        if (force) {
            console.log(`[Strategy] Forcing rebalance to incorporate new funds.`);
        } else {
            console.log(`[Strategy] Out of Range. Rebalancing...`);
        }
    }

    try {
        await executeFullRebalance(wallet, configuredPool, tokenId);
    } catch (e) {
        if ((e as Error).message.includes("PROFIT_SECURED")) {
            throw e; // Rethrow to let the block listener handle the exit
        }
        console.error(`[Rebalance] Failed during full rebalance at block ${blockNumber}:`, e);
    }
}

// --- Helper: Get Current Price (WETH in USDC) ---
async function getPrice(): Promise<number> {
    const slot0 = await poolContract.slot0();
    const configuredPool = new Pool(
        USDC_TOKEN,
        WETH_TOKEN,
        POOL_FEE,
        slot0.sqrtPriceX96.toString(),
        "0",
        Number(slot0.tick)
    );
    // [Fix] Dynamic check: If WETH is token0, use token0Price (USDC/WETH). If WETH is token1, use token1Price.
    const price = (configuredPool.token0.address.toLowerCase() === WETH_TOKEN.address.toLowerCase())
        ? configuredPool.token0Price
        : configuredPool.token1Price;
    return parseFloat(price.toSignificant(6));
}

// --- Helper: Calculate Total Asset Value in USDC ---
async function calculateTotalAssets(tokenId: string): Promise<number> {
    // 1. Wallet Balances
    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);
    
    const price = await getPrice();
    
    let totalValue = Number(ethers.formatUnits(balUSDC, 6)) + (Number(ethers.formatEther(balWETH)) * price);

    // 2. LP Position Value
    if (tokenId && tokenId !== "0") {
        try {
            const pos = await npm.positions(tokenId);
            if (pos.liquidity > 0n) {
                const slot0 = await poolContract.slot0();
                const configuredPool = new Pool(USDC_TOKEN, WETH_TOKEN, POOL_FEE, slot0.sqrtPriceX96.toString(), "0", Number(slot0.tick));
                
                const positionSDK = new Position({
                    pool: configuredPool,
                    liquidity: pos.liquidity.toString(),
                    tickLower: Number(pos.tickLower),
                    tickUpper: Number(pos.tickUpper),
                });

                const amount0 = parseFloat(positionSDK.amount0.toSignificant(6)); // WETH
                const amount1 = parseFloat(positionSDK.amount1.toSignificant(6)); // USDC
                
                totalValue += amount1 + (amount0 * price);

                // [Added] Include Unclaimed Fees via Static Call
                try {
                    const collectParams = {
                        tokenId: tokenId,
                        recipient: wallet.address,
                        amount0Max: MAX_UINT128,
                        amount1Max: MAX_UINT128,
                    };
                    // Simulate collection to get pending fees without executing tx
                    const [fee0, fee1] = await npm.getFunction("collect").staticCall(collectParams);
                    
                    let feeVal = 0;
                    if (configuredPool.token0.address.toLowerCase() === WETH_TOKEN.address.toLowerCase()) {
                        // token0 is WETH, token1 is USDC
                        feeVal = parseFloat(ethers.formatUnits(fee1, 6)) + (parseFloat(ethers.formatUnits(fee0, 18)) * price);
                    } else {
                        // token0 is USDC, token1 is WETH
                        feeVal = parseFloat(ethers.formatUnits(fee0, 6)) + (parseFloat(ethers.formatUnits(fee1, 18)) * price);
                    }
                    totalValue += feeVal;
                } catch (e) {
                    console.warn("[Monitor] Failed to fetch pending fees (ignoring):", e);
                }
            }
        } catch (e) {
            console.error("[Monitor] Failed to calc LP value:", e);
        }
    }
    return totalValue;
}

// --- Action: Trigger Circuit Breaker ---
async function triggerCircuitBreaker(tokenId: string, currentVal: number) {
    console.error(`\n[CircuitBreaker] TRIGGERED! Total Value ($${currentVal.toFixed(2)}) < Threshold ($${CIRCUIT_BREAKER_THRESHOLD})`);
    
    // 1. Remove Liquidity
    if (tokenId && tokenId !== "0") {
        console.log("[CircuitBreaker] Removing Liquidity...");
        try {
            await atomicExitPosition(wallet, tokenId);
        } catch (e) {
            console.error("[CircuitBreaker] Failed to remove liquidity (continuing to swap):", e);
        }
    }

    // 2. Swap WETH to USDC
    try {
        const balWETH = await getBalance(WETH_TOKEN, wallet);
        const keepAmount = (balWETH * BigInt(Math.floor(STOP_LOSS_KEEP_WETH_PERCENT * 100))) / 100n;
        const sellAmount = balWETH - keepAmount;

        if (sellAmount > 100000000000000n) { // > 0.0001 ETH
            console.log(`[CircuitBreaker] Selling ${ethers.formatEther(sellAmount)} WETH (Keeping ${ethers.formatEther(keepAmount)})...`);
            const router = new ethers.Contract(SWAP_ROUTER_ADDR, SWAP_ROUTER_ABI, wallet);
            await router.exactInputSingle({
                tokenIn: WETH_TOKEN.address,
                tokenOut: USDC_TOKEN.address,
                fee: POOL_FEE,
                recipient: wallet.address,
                deadline: Math.floor(Date.now() / 1000) + 300,
                amountIn: sellAmount,
                amountOutMinimum: 0, 
                sqrtPriceLimitX96: 0
            }).then((tx: any) => tx.wait());
            console.log("[CircuitBreaker] Swap Complete.");
        }
    } catch (e) {
        console.error("[CircuitBreaker] Swap failed:", e);
    }

    // 3. Update State & Alert
    const exitPrice = await getPrice();
    saveState({ stopLossTriggered: true, tokenId: "0", circuitBreakerPrice: exitPrice });
    
    await sendEmailAlert("CIRCUIT BREAKER TRIGGERED", 
        `Bot stopped.\nValue: $${currentVal.toFixed(2)}\nAction: Liquidity Removed, WETH Sold.\nExit Price: $${exitPrice}\n\nTo Restart: Set 'stopLossTriggered' to false in state.`);
}

initialize().catch(async (e) => {
    console.error(e);
    await sendEmailAlert("Bot Crashed", `The bot process exited unexpectedly.\nError: ${e.message}`);
    process.exit(1);
});

function askHidden(query: string): Promise<string> {
    return new Promise((resolve) => {
        let muted = false;
        
        const mutableStdout = new Writable({
            write: function(chunk, encoding, callback) {
                if (!muted) process.stdout.write(chunk, encoding);
                callback();
            }
        });

        const rl = readline.createInterface({
            input: process.stdin,
            output: mutableStdout,
            terminal: true
        });

        rl.question(query, (answer) => {
            rl.close();
            console.log(''); 
            resolve(answer);
        });
        
        muted = true;
    });
}