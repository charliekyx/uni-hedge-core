import { ethers } from "ethers";

import {
    AAVE_POOL_ADDR,
    AAVE_POOL_ABI,
    WETH_DEBT_TOKEN_ADDR,
    USDC_TOKEN,
    WETH_TOKEN,
    ERC20_ABI,
    SWAP_ROUTER_ADDR,
    SWAP_ROUTER_ABI,
    POOL_FEE,
    TX_TIMEOUT_MS,
    AAVE_TARGET_HEALTH_FACTOR,
    AAVE_MIN_HEALTH_FACTOR,
    DELTA_NEUTRAL_THRESHOLD,
} from "../config";

import { withRetry, waitWithTimeout, sendEmailAlert } from "./utils";
import { saveState } from "./state";
import { atomicExitPosition } from "./actions";

const RATE_MODE_VARIABLE = 2; // Aave Variable Rate

export class AaveManager {
    private wallet: ethers.Wallet;
    private poolContract: ethers.Contract;
    private swapRouter: ethers.Contract;

    constructor(wallet: ethers.Wallet) {
        this.wallet = wallet;
        this.poolContract = new ethers.Contract(
            AAVE_POOL_ADDR,
            AAVE_POOL_ABI,
            wallet
        );
        this.swapRouter = new ethers.Contract(
            SWAP_ROUTER_ADDR,
            SWAP_ROUTER_ABI,
            wallet
        );
    }

    // --- Info Getters ---

    async getHealthFactor(): Promise<number> {
        const data = await withRetry(() =>
            this.poolContract.getUserAccountData(this.wallet.address)
        );
        // If totalCollateralBase is very small, HF might be huge, treat as safe (999.0)
        if (data.totalCollateralBase === 0n) return 999.0;
        if (data.healthFactor > 100n * 10n ** 18n) return 999.0;
        return parseFloat(ethers.formatUnits(data.healthFactor, 18));
    }

    async getCurrentEthDebt(): Promise<bigint> {
        if (WETH_DEBT_TOKEN_ADDR === ethers.ZeroAddress) return 0n;
        const debtContract = new ethers.Contract(
            WETH_DEBT_TOKEN_ADDR,
            ["function balanceOf(address) view returns (uint256)"],
            this.wallet
        );
        return await withRetry(() =>
            debtContract.balanceOf(this.wallet.address)
        );
    }

    // --- Safety Checks ---

    /**
     * Lightweight check to be called on every block.
     * Returns true if safe, false if panic exit triggered.
     */
    async checkHealthAndPanic(lpTokenId: string): Promise<boolean> {
        try {
            const hf = await this.getHealthFactor();

            // CRITICAL RISK CHECK
            if (hf < AAVE_MIN_HEALTH_FACTOR) {
                console.warn(
                    `[Risk] Health Factor Critical: ${hf.toFixed(4)} < ${AAVE_MIN_HEALTH_FACTOR}`
                );
                await this.panicExitAll(lpTokenId);
                return false;
            }

            return true;
        } catch (e) {
            console.error("[Aave] Health check failed:", e);
            // Assume safe on RPC error to prevent premature panic, but log it.
            return true;
        }
    }

    /**
     * borrow more weth from aave ans swap them to USDC for hedging
     * @param amountEth 
     * @returns 
     */
    async increaseShort(amountEth: bigint) {
        const hf = await this.getHealthFactor();
        if (hf < AAVE_TARGET_HEALTH_FACTOR) {
            console.warn(
                `   [Hedge] Health Factor low (${hf.toFixed(2)}). Skipping borrow.`
            );
            await sendEmailAlert(
                "Hedge Warning",
                `Health Factor low (${hf}). Skipping borrow.`
            );
            return;
        }

        console.log(
            `   [Hedge] OPEN SHORT: Borrowing ${ethers.formatUnits(amountEth, 18)} ETH...`
        );

        try {
            const txBorrow = await this.poolContract.borrow(
                WETH_TOKEN.address,
                amountEth,
                RATE_MODE_VARIABLE,
                0,
                this.wallet.address
            );
            await waitWithTimeout(txBorrow, TX_TIMEOUT_MS);
        } catch (e) {
            console.error("   [Hedge] Borrow failed (Check Collateral):", e);
            return;
        }

        console.log(`   [Hedge] Selling borrowed ETH for USDC...`);

        const txSwap = await this.swapRouter.exactInputSingle({
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            fee: POOL_FEE,
            recipient: this.wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 300,
            amountIn: amountEth,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
        });
        await waitWithTimeout(txSwap, TX_TIMEOUT_MS);
        console.log(`   [Hedge] Short Position Increased.`);
    }

    /**
     * pay back aave with weth, if not enough in the wallet, try swap with USDC first
     * @param amountEth 
     * @returns 
     */
    async decreaseShort(amountEth: bigint, force:boolean = false) {
        console.log(
            `   [Hedge] CLOSE SHORT: Repaying ${ethers.formatUnits(amountEth, 18)} ETH...`
        );

        const wethContract = new ethers.Contract(
            WETH_TOKEN.address,
            ERC20_ABI,
            this.wallet
        );
        let currentWeth = await wethContract.balanceOf(this.wallet.address);

        // --- Auto-Swap Logic ---
        if (currentWeth < amountEth) {
            const deficit = amountEth - currentWeth;

            const params = {
                tokenIn: USDC_TOKEN.address,
                tokenOut: WETH_TOKEN.address,
                fee: POOL_FEE,
                recipient: this.wallet.address,
                deadline: Math.floor(Date.now() / 1000) + 300,
                amountOut: deficit, // We need exactly this much WETH
                amountInMaximum: ethers.MaxUint256, // Use as much USDC as needed
                sqrtPriceLimitX96: 0,
            };

            try {
                const txSwap = await this.swapRouter.exactOutputSingle(params);
                await waitWithTimeout(txSwap, TX_TIMEOUT_MS);

                // Update balance after swap
                currentWeth = await wethContract.balanceOf(this.wallet.address);
            } catch (e) {
                console.error("   [Hedge] Swap USDC->WETH failed:", e);
                return; // Stop if swap fails
            }
        }

        // Repay Logic

        try {
            const tx = await this.poolContract.repay(
                WETH_TOKEN.address,
                force === true? ethers.MaxUint256 : amountEth, // if force === true, use ethers.MaxUint256 to repay all if close to balance, for panic exit to have a clean repayment
                RATE_MODE_VARIABLE,
                this.wallet.address
            );
            await waitWithTimeout(tx, TX_TIMEOUT_MS);
            console.log(`   [Hedge] Repay Confirmed.`);
        } catch (e) {
            console.error(`   [Aave] Repay Failed:`, e);
            sendEmailAlert("[Aave] Repay Failed", "Not enough weth and USDC in the wallet to repay Aave")
        }
    }

   /**
     * PANIC EXIT: Clear all debt and positions
     */
    async panicExitAll(lpTokenId: string) {
        console.log(`\n[CRITICAL EXIT] Initiating panic cleanup!`);

        // 1. Alert (Fail-safe)
        try {
            const hf = await this.getHealthFactor();
            await sendEmailAlert("CRITICAL: Panic Exit", `HF ${hf}. Exiting all positions.`);
        } catch (e) {
            console.error("   [Panic] Failed to send initial alert:", e);
        }

        // 2. BREAK LP FIRST (Get the WETH back!)
        try {
            if (lpTokenId && lpTokenId !== "0") {
               await atomicExitPosition(this.wallet, lpTokenId);

                await saveState("0"); // the program will restart itself, its important tp reset position token
                console.log("   [Panic] LP Closed & State Reset.");
            }
        } catch (e) {
            console.error("   [Panic] Failed to close LP:", e);
            await sendEmailAlert("[Panic] Failed to close LP", String(e));
        }

        // 3. Repay Debt
        try {
            const currentDebt = await this.getCurrentEthDebt();
            if (currentDebt > 0n) {
                console.log(`   [Aave] Found debt: ${ethers.formatEther(currentDebt)} ETH`);
                await this.decreaseShort(currentDebt, true); // force to use eveything in the wallet to repay aave
            }
        } catch (e) {
            console.error("   [Panic] Failed to repay Aave debt:", e);
            await sendEmailAlert("[Panic] Failed to repay Aave debt", String(e));
        }

        console.log(`[EXIT] Strategy Stopped.`);
        process.exit(1);
    }

    async adjustHedge(lpEthAmount: bigint, lpTokenId: string) {
        // double check safety level 
        const hf = await this.getHealthFactor();
        if (hf < AAVE_MIN_HEALTH_FACTOR) {
            await this.panicExitAll(lpTokenId);
            return;
        }

        console.log(`\n[Hedge] Checking Delta Neutrality...`);

        const currentDebt = await this.getCurrentEthDebt();
        const diff = lpEthAmount - currentDebt;

        console.log(
            `   [Status] LP Long: ${ethers.formatEther(lpEthAmount)} ETH | Aave Short: ${ethers.formatEther(currentDebt)} ETH`
        );
        console.log(`   [Status] Net Delta: ${ethers.formatEther(diff)} ETH`);

        if (diff > DELTA_NEUTRAL_THRESHOLD) {
            // Long > Short -> Increase Hedge
            await this.increaseShort(diff);
        } else if (diff < -DELTA_NEUTRAL_THRESHOLD) {
            // Short > Long -> Decrease Hedge
            const repayAmt = -diff;
            await this.decreaseShort(repayAmt);
        } else {
            console.log(`   [Hedge] Balanced.`);
        }
    }
}
