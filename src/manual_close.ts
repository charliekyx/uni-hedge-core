import { ethers, NonceManager } from "ethers";
import * as dotenv from "dotenv";

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
    
    const baseWallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
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

initialize().catch(console.error);
