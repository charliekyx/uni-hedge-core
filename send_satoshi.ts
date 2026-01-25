import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as readline from "readline";
import { Writable } from "stream";
import { USDC_TOKEN, ERC20_ABI } from "./config";

dotenv.config();

// ================= 配置区域 =================
const TARGET_ADDRESS = process.env.SATOSHI_TARGET_ADDRESS || ""; 
const AMOUNT = "2"; // Coinbase 指定的金额 (请再次确认这个数字)
const IS_ETH = false; // 如果是转 ETH 填 true；如果是转 USDC 填 false
// ===========================================

async function main() {
    console.log("---  Satoshi Test 转账脚本 ---");

    // 1. 连接网络
    const rpcEnv = process.env.RPC_URL || "";
    // 处理可能包含多个 URL 的情况，取第一个
    const rpcUrl = rpcEnv.split(',')[0].trim();
    
    if (!rpcUrl) throw new Error("Missing RPC_URL in .env");
    
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    
    // 2. 安全获取钱包
    let wallet: ethers.Wallet;
    const keystorePath = process.env.KEYSTORE_PATH;
    const privateKey = process.env.PRIVATE_KEY;

    if (keystorePath) {
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
            const decryptedWallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
            wallet = decryptedWallet.connect(provider) as ethers.Wallet;
            console.log(`钱包解锁成功: ${wallet.address}`);
        } catch (e) {
            console.error("密码错误或解密失败。");
            process.exit(1);
        }
    } else if (privateKey) {
        console.warn("警告: 正在使用明文私钥 (不推荐)");
        wallet = new ethers.Wallet(privateKey, provider);
    } else {
        console.log("未找到环境变量配置 (KEYSTORE_PATH 或 PRIVATE_KEY)。");
        console.log("切换到临时手动输入模式...");
        let inputKey = await askHidden("请输入您的私钥 (输入内容将隐藏): ");
        inputKey = inputKey.trim();
        if (!inputKey) throw new Error("未输入私钥");
        
        if (!inputKey.startsWith("0x")) {
            inputKey = "0x" + inputKey;
        }
        
        wallet = new ethers.Wallet(inputKey, provider);
        console.log(`钱包已临时加载: ${wallet.address}`);
    }

    const ethBalance = await provider.getBalance(wallet.address);
    console.log(`当前 ETH 余额: ${ethers.formatEther(ethBalance)} ETH`);

    if (ethBalance < ethers.parseEther("0.00005")) {
        console.error("\n严重错误: ETH 余额不足以支付 Gas 费！");
        return;
    }

    // 检查地址是否已修改
    if (!TARGET_ADDRESS || TARGET_ADDRESS.includes("Coinbase给你的充值地址")) {
        console.warn("\n提示: 未配置 SATOSHI_TARGET_ADDRESS 环境变量或地址无效。");
        console.warn("请在 .env 文件中设置 SATOSHI_TARGET_ADDRESS, 然后再次运行。");
        return;
    }

    if (IS_ETH) {
        // --- 转账 ETH ---
        console.log(`\n正在发送 ${AMOUNT} ETH 到 ${TARGET_ADDRESS}...`);
        const tx = await wallet.sendTransaction({
            to: TARGET_ADDRESS,
            value: ethers.parseEther(AMOUNT)
        });
        console.log(`交易已发送! Hash: ${tx.hash}`);
        console.log("等待确认...");
        await tx.wait();
        console.log("Satoshi Test 转账成功！");
    } else {
        // --- 转账 USDC ---
        console.log(`\n正在发送 ${AMOUNT} USDC 到 ${TARGET_ADDRESS}...`);
        const usdcContract = new ethers.Contract(USDC_TOKEN.address, ERC20_ABI, wallet);
        
        // 1. 先检查并打印余额
        const balance = await usdcContract.balanceOf(wallet.address);
        console.log(`🔍 脚本读取到的 USDC 余额: ${ethers.formatUnits(balance, 6)}`);
        console.log(`ℹ️  脚本使用的 USDC 合约地址: ${USDC_TOKEN.address}`);

        // 注意：USDC 是 6 位精度
        const amountWei = ethers.parseUnits(AMOUNT, 6); 

        if (balance < amountWei) {
            console.error(`\n错误: 余额不足。需要 ${AMOUNT}，但只有 ${ethers.formatUnits(balance, 6)}`);
            console.error("提示: Arbitrum 上有两种 USDC。您可能持有的是 'USDC.e' (Bridged)，但脚本使用的是 'Native USDC'。");
            console.error("   请在 Uniswap 上将 USDC.e 兑换为 USDC (Native)，或者检查您的资金是否在正确的钱包地址。");
            return;
        }
        
        const tx = await usdcContract.transfer(TARGET_ADDRESS, amountWei);
        console.log(`交易已发送! Hash: ${tx.hash}`);
        console.log("等待确认...");
        await tx.wait();
        console.log("Satoshi Test 转账成功！");
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