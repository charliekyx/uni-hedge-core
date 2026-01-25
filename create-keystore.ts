import { ethers } from 'ethers';
import * as fs from 'fs';
import * as readline from 'readline';
import { Writable } from 'stream';

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

async function createKeystore() {
    try {
        console.log("--- 加密Keystore生成器 ---");

        // 1. 输入私钥 (隐藏)
        let privateKey = await askHidden('请输入您的私钥 (输入内容将隐藏): ');
        
        // 清理输入并验证
        privateKey = privateKey.trim();
        if (!privateKey.startsWith('0x')) {
            privateKey = '0x' + privateKey;
        }

        if (!ethers.isHexString(privateKey, 32)) {
            console.error("\n 错误: 私钥格式无效。请确保是64位十六进制字符串。");
            return;
        }

        const wallet = new ethers.Wallet(privateKey);
        console.log(`\n已识别钱包地址: ${wallet.address}`);

        // 2. 设置密码
        let password = "";
        while (true) {
            password = await askHidden('请设置加密密码 (输入内容将隐藏): ');
            if (password.length < 8) {
                console.log("密码太短, 为了安全请至少使用8位字符。");
                continue;
            }
            const confirm = await askHidden('请再次输入密码以确认: ');
            if (password === confirm) {
                break;
            }
            console.log("两次输入的密码不匹配，请重试。");
        }

        console.log("\n正在生成高强度加密文件, 请稍候...");

        // 3. 生成加密JSON
        const json = await wallet.encrypt(password);
        const filename = `keystore-${wallet.address}.json`;
        fs.writeFileSync(filename, json);

        console.log(`\n成功! Keystore文件已保存为: ${filename}`);
        console.log(`\n接下来请更新您的 .env 文件`);
        console.log(`KEYSTORE_PATH=./${filename}`);
        console.log(`KEYSTORE_PASSWORD=您的密码`);
        
    } catch (error) {
        console.error("\n 发生错误:", error);
    }
}

createKeystore();