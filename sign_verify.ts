import { ethers } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as readline from "readline";
import { Writable } from "stream";

dotenv.config();

async function main() {
    console.log("---  钱包签名验证脚本 ---");

    // 1. 安全获取钱包 (集成 Keystore 逻辑)
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
            // 签名不需要连接 Provider，直接解密即可
            const decryptedWallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
            wallet = decryptedWallet as ethers.Wallet;
            console.log(`钱包解锁成功: ${wallet.address}`);
        } catch (e) {
            console.error("密码错误或解密失败。");
            process.exit(1);
        }
    } else if (privateKey) {
        console.warn("警告: 正在使用明文私钥 (不推荐)");
        wallet = new ethers.Wallet(privateKey);
        console.log(`正在使用钱包地址: ${wallet.address}`);
    } else {
        console.log("未找到环境变量配置 (KEYSTORE_PATH 或 PRIVATE_KEY)。");
        console.log("切换到临时手动输入模式...");
        let inputKey = await askHidden("请输入您的私钥 (输入内容将隐藏): ");
        inputKey = inputKey.trim();
        if (!inputKey) throw new Error("未输入私钥");
        
        if (!inputKey.startsWith("0x")) {
            inputKey = "0x" + inputKey;
        }
        wallet = new ethers.Wallet(inputKey);
        console.log(`钱包已临时加载: ${wallet.address}`);
    }

    // ==========================================
    // 2. 把 Coinbase 给你的那段文字完整粘贴在这里
    // ==========================================
    const messageToSign = "Coinbase verification message \n 复制你的完整消息粘贴到这里"; 

    if (messageToSign.includes("复制你的完整消息粘贴到这里")) {
        console.warn("\n提示: 您尚未修改脚本中的 messageToSign 变量。");
        console.warn("请先打开 sign_verify.ts 文件，将第 49 行的字符串替换为 Coinbase 提供的实际消息，然后再次运行。");
        // 为了演示，程序继续运行，但通常这里应该 return
    }

    console.log(`\n正在签名消息:\n"${messageToSign}"\n...`);

    // 3. 签名
    const signature = await wallet.signMessage(messageToSign);

    console.log("\n================ 签名结果 ================");
    console.log(signature);
    console.log("==========================================");
    console.log("请把上面这一长串字符复制回 Coinbase 的验证框内。");
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