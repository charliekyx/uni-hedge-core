import { ethers, NonceManager } from "ethers";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as readline from "readline";
import { Writable } from "stream";

import {
    NPM_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR,
} from "../config";

import { loadState, saveState } from "./state";
import { atomicExitPosition } from "./actions";
import { AaveManager } from "./hedge";
import { RobustProvider } from "./connection";

dotenv.config();

let wallet: ethers.Wallet;
let provider: ethers.Provider;
let robustProvider: RobustProvider;
let npm: ethers.Contract;
let aave: AaveManager;

async function manualClosePosition() {
    console.log("[System] Manual close position triggered.");

    const { tokenId } = await loadState();

    if (tokenId && tokenId !== "0") {
        console.log(`[System] Closing Uniswap position token ${tokenId}...`);
        await atomicExitPosition(wallet, tokenId);
        console.log("[System] Uniswap position closed.");
    } else {
        console.log("[System] No active Uniswap position found.");
    }

    console.log("[System] Closing Aave position...");
    await aave.closePositions();
    console.log("[System] Aave position closed.");

    saveState({ tokenId: "0" });
    console.log("[System] State reset.");
}

async function initialize() {
    const rpcEnv = process.env.RPC_URL || "";
    const rpcUrls = rpcEnv.split(',').map(u => u.trim()).filter(u => u.length > 0);

    if (rpcUrls.length === 0) {
        throw new Error("RPC_URL is not set in .env");
    }

    console.log(`[System] Loaded ${rpcUrls.length} RPC nodes.`);

    robustProvider = new RobustProvider(rpcUrls, () => {});

    provider = robustProvider.getProvider();
    
    // --- Secure Wallet Initialization ---
    let baseWallet: ethers.Wallet;
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

        const decryptedWallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
        baseWallet = decryptedWallet.connect(provider) as ethers.Wallet;
    } else if (privateKey) {
        baseWallet = new ethers.Wallet(privateKey, provider);
    } else {
        throw new Error("Wallet initialization failed: Please provide KEYSTORE_PATH or PRIVATE_KEY.");
    }

    const managedWallet = new NonceManager(baseWallet);
    (managedWallet as any).address = baseWallet.address;
    wallet = managedWallet as any;

    console.log(`[System] Wallet initialized: ${await wallet.getAddress()}`);
    
    npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    aave = new AaveManager(wallet);

    console.log(`[System] Initialized.`);

    await manualClosePosition();
    process.exit(0);
}

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

initialize().catch(console.error);
