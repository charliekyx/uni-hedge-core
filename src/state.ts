import * as fs from "fs";
import * as path from "path";

const STATE_FILE = path.join(process.cwd(), "bot_state.json");

export interface BotState {
    tokenId: string; // tokenid from my last postion mint
    lastCheck: number;
}

export function loadState(): BotState {
    if (fs.existsSync(STATE_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        } catch (e) {
            console.error("[System] Corrupt state file. Resetting.");
        }
    }
    return { tokenId: "0", lastCheck: 0 };
}

export function saveState(tokenId: string) {
    const state: BotState = { tokenId, lastCheck: Date.now() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[System] State saved: Token ID ${tokenId}`);
}
