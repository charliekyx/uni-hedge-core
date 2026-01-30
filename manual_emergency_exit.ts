import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as readline from "readline";
import { Writable } from "stream";

import {
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    SWAP_ROUTER_ADDR,
    SWAP_ROUTER_ABI,
    ERC20_ABI,
    TX_TIMEOUT_MS
} from "./config";

import { loadState, saveState } from "./src/state";
import { atomicExitPosition } from "./src/actions";
import { waitWithTimeout } from "./src/utils";

dotenv.config();

async function main() {
    console.log("\n==================================================");
    console.log("MANUAL EMERGENCY EXITd");
    console.log("==================================================");
    console.log("此脚本将执行以下操作：");
    console.log("1. 强制关闭当前的 Uniswap V3 LP 头寸 (Remove Liquidity + Collect Fees + Burn NFT)");
    console.log("2. 将钱包内所有的 WETH 卖成 USDC (Market Sell)");
    console.log("==================================================\n");

    // 1. 连接网络
    const rpcEnv = process.env.RPC_URL || "";
    const rpcUrl = rpcEnv.split(',')[0].trim();
    if (!rpcUrl) throw new Error("Missing RPC_URL in .env");
    
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // 2. 获取钱包 (支持 Keystore)
    let wallet: ethers.Wallet;
    const keystorePath = process.env.KEYSTORE_PATH;
    const privateKey = process.env.PRIVATE_KEY;

    if (keystorePath) {
        if (!fs.existsSync(keystorePath)) {
            throw new Error(`Keystore file not found: ${keystorePath}`);
        }
        const keystoreJson = fs.readFileSync(keystorePath, 'utf8');
        let password = process.env.KEYSTORE_PASSWORD;
        if (!password) {
            password = await askHidden("请输入 Keystore 密码: ");
        }
        try {
            const decryptedWallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
            wallet = decryptedWallet.connect(provider) as ethers.Wallet;
        } catch (e) {
            console.error("密码错误或解密失败。");
            process.exit(1);
        }
    } else if (privateKey) {
        wallet = new ethers.Wallet(privateKey, provider);
    } else {
        let inputKey = await askHidden("请输入私钥: ");
        wallet = new ethers.Wallet(inputKey.trim(), provider);
    }

    console.log(`钱包已连接: ${wallet.address}`);

    // 3. 检查并关闭 LP
    const state = loadState();
    const tokenId = state.tokenId;

    if (tokenId && tokenId !== "0") {
        console.log(`\n[1/2] 发现活跃 LP 头寸 (Token ID: ${tokenId})，正在关闭...`);
        try {
            // 使用 atomicExitPosition 执行关闭
            await atomicExitPosition(wallet, tokenId);
            
            // 更新本地状态，防止重复操作
            saveState({ tokenId: "0" });
            console.log("LP 头寸已成功关闭！");
        } catch (e) {
            console.error("关闭 LP 失败:", e);
            console.log("脚本将尝试继续执行 WETH 抛售步骤...");
        }
    } else {
        console.log("\n[1/2] 未发现活跃 LP 头寸 (Token ID 为 0 或不存在)，跳过此步骤。");
    }

    // 4. 卖出所有 WETH -> USDC
    console.log("\n[2/2] 检查 WETH 余额并准备抛售...");
    
    const wethContract = new ethers.Contract(WETH_TOKEN.address, ERC20_ABI, wallet);
    const usdcContract = new ethers.Contract(USDC_TOKEN.address, ERC20_ABI, wallet);
    
    const wethBalance = await wethContract.balanceOf(wallet.address);
    const usdcBalanceBefore = await usdcContract.balanceOf(wallet.address);

    console.log(`   当前 WETH 余额: ${ethers.formatEther(wethBalance)} ETH`);
    console.log(`   当前 USDC 余额: ${ethers.formatUnits(usdcBalanceBefore, 6)} USDC`);

    if (wethBalance > 0n) {
        const sellPercent = 75n;
        const sellAmount = (wethBalance * sellPercent) / 100n;
        console.log(`\n正在将 ${ethers.formatEther(sellAmount)} WETH (${sellPercent}%) 兑换为 USDC...`);

        const router = new ethers.Contract(SWAP_ROUTER_ADDR, SWAP_ROUTER_ABI, wallet);

        // 授权 (如果需要)
        const allowance = await wethContract.allowance(wallet.address, SWAP_ROUTER_ADDR);
        if (allowance < sellAmount) {
            console.log("   正在授权 Router 使用 WETH...");
            const txApprove = await wethContract.approve(SWAP_ROUTER_ADDR, ethers.MaxUint256);
            await txApprove.wait();
            console.log("   授权完成。");
        }

        try {
            // 紧急抛售：amountOutMinimum 设为 0 (接受最大滑点以确保卖出)
            const params = {
                tokenIn: WETH_TOKEN.address,
                tokenOut: USDC_TOKEN.address,
                fee: POOL_FEE,
                recipient: wallet.address,
                deadline: Math.floor(Date.now() / 1000) + 300,
                amountIn: sellAmount,
                amountOutMinimum: 0, // 紧急模式：不设滑点保护，确保成交
                sqrtPriceLimitX96: 0,
            };

            const txSwap = await router.exactInputSingle(params);
            console.log(`交易已发送! Hash: ${txSwap.hash}`);
            console.log("等待确认...");
            await waitWithTimeout(txSwap, TX_TIMEOUT_MS);
            
            const usdcBalanceAfter = await usdcContract.balanceOf(wallet.address);
            const received = usdcBalanceAfter - usdcBalanceBefore;
            console.log(`抛售成功! 获得: ${ethers.formatUnits(received, 6)} USDC`);
            console.log(`最终 USDC 余额: ${ethers.formatUnits(usdcBalanceAfter, 6)} USDC`);

        } catch (e) {
            console.error("WETH 抛售失败:", e);
        }
    } else {
        console.log("WETH 余额为 0, 无需操作。");
    }
}

// 辅助函数：隐藏输入
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

main().catch(console.error);
