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
} from "../config";
import { withRetry, waitWithTimeout, sendEmailAlert } from "./utils";
import { closeLpPosition } from "./actions";

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

    // --- Safety Checks (New) ---

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
            // Alternatively, return false if you want fail-safe behavior.
            return true;
        }
    }

    // --- Actions ---

    async supplyUsdc(amount: bigint) {
        console.log(
            `   [Aave] Supplying ${ethers.formatUnits(amount, 6)} USDC...`
        );

        const usdcContract = new ethers.Contract(
            USDC_TOKEN.address,
            ERC20_ABI,
            this.wallet
        );
        const allowance = await usdcContract.allowance(
            this.wallet.address,
            AAVE_POOL_ADDR
        );

        if (allowance < amount) {
            console.log(`   [Aave] Approving USDC...`);
            const txAppr = await usdcContract.approve(
                AAVE_POOL_ADDR,
                ethers.MaxUint256
            );
            await waitWithTimeout(txAppr, TX_TIMEOUT_MS);
        }

        const tx = await this.poolContract.supply(
            USDC_TOKEN.address,
            amount,
            this.wallet.address,
            0
        );
        await waitWithTimeout(tx, TX_TIMEOUT_MS);
        console.log(`   [Aave] Supply Confirmed.`);
    }

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

        const wethContract = new ethers.Contract(
            WETH_TOKEN.address,
            ERC20_ABI,
            this.wallet
        );
        const allowance = await wethContract.allowance(
            this.wallet.address,
            SWAP_ROUTER_ADDR
        );
        if (allowance < amountEth) {
            const txAppr = await wethContract.approve(
                SWAP_ROUTER_ADDR,
                ethers.MaxUint256
            );
            await waitWithTimeout(txAppr, TX_TIMEOUT_MS);
        }

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

    async decreaseShort(amountEth: bigint) {
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
        // -----------------------------

        // Repay Logic

        try {
            const tx = await this.poolContract.repay(
                WETH_TOKEN.address,
                amountEth, // Or use ethers.MaxUint256 to repay all if close to balance
                RATE_MODE_VARIABLE,
                this.wallet.address
            );
            await waitWithTimeout(tx, TX_TIMEOUT_MS);
            console.log(`   [Hedge] Repay Confirmed.`);
        } catch (e) {
            console.error(`   [Aave] Repay Failed:`, e);
        }
    }

    /**
     * PANIC EXIT: Clear all debt and positions
     * IMPROVED: Exits LP first to ensure we have collateral to repay
     */
    async panicExitAll(lpTokenId: string) {
        console.log(`\n[CRITICAL EXIT] Initiating panic cleanup!`);

        // 1. Alert
        const hf = await this.getHealthFactor();
        await sendEmailAlert(
            "CRITICAL: Panic Exit",
            `HF ${hf}. Exiting all positions.`
        );

        // 2. BREAK LP FIRST (Get the WETH back!)
        try {
            if (lpTokenId && lpTokenId !== "0") {
                await closeLpPosition(this.wallet, lpTokenId);
            }
        } catch (e) {
            console.error("   [Panic] Failed to close LP:", e);
            // Continue anyway, try to repay with whatever we have
        }

        // 3. Repay Debt
        const currentDebt = await this.getCurrentEthDebt();
        if (currentDebt > 0n) {
            console.log(
                `   [Aave] Repaying debt: ${ethers.formatEther(currentDebt)} ETH`
            );
            // This will now use the WETH we just got from closing the LP
            // plus any WETH we got from the auto-swap inside decreaseShort (if still needed)
            await this.decreaseShort(currentDebt);
        }

        console.log(`[EXIT] Strategy Stopped.`);
        process.exit(1);
    }

    async adjustHedge(lpEthAmount: bigint, lpTokenId: string) {
        // Redundant safety check (optional but recommended)
        const hf = await this.getHealthFactor();
        if (hf < AAVE_MIN_HEALTH_FACTOR) {
            await this.panicExitAll(lpTokenId);
            return;
        }

        console.log(`\n[Hedge] Checking Delta Neutrality...`);

        const currentDebt = await this.getCurrentEthDebt();
        const diff = lpEthAmount - currentDebt;

        // Threshold: 0.02 ETH to avoid gas waste
        const THRESHOLD = ethers.parseEther("0.02");

        console.log(
            `   [Status] LP Long: ${ethers.formatEther(lpEthAmount)} ETH | Aave Short: ${ethers.formatEther(currentDebt)} ETH`
        );
        console.log(`   [Status] Net Delta: ${ethers.formatEther(diff)} ETH`);

        if (diff > THRESHOLD) {
            // Long > Short -> Increase Hedge
            await this.increaseShort(diff);
        } else if (diff < -THRESHOLD) {
            // Short > Long -> Decrease Hedge
            const repayAmt = -diff;
            await this.decreaseShort(repayAmt);
        } else {
            console.log(`   [Hedge] Balanced.`);
        }
    }
}
