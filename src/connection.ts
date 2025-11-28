import { ethers } from "ethers";

export class RobustProvider {
    private url: string;
    private provider: ethers.WebSocketProvider | ethers.JsonRpcProvider;
    private pingInterval: NodeJS.Timeout | null = null;
    private reconnectCallback: () => void;
    private isWs: boolean;

    constructor(url: string, onReconnect: () => void) {
        this.url = url;
        this.reconnectCallback = onReconnect;
        this.isWs = url.startsWith("ws");
        this.provider = this.initProvider();
    }

    private initProvider() {
        if (this.isWs) {
            console.log(`[Network] Initializing WebSocket Provider...`);
            const provider = new ethers.WebSocketProvider(this.url);

            // Error Handling
            provider.websocket.onerror = (error: any) => {
                console.error("[Network] WebSocket Error:", error);
                this.triggerReconnect();
            };

            // Close Handling
            // https://docs.ethers.org/v6/single-page/#api_providers__WebSocketLike 
            // ether.js v6 does not have onclose becuase it's encapuslated, cast it as any first
            (provider.websocket as any).onclose = (code: any) => {
                console.warn(
                    `[Network] WebSocket Closed (Code: ${code}). Reconnecting...`
                );
                this.triggerReconnect();
            };

            // Heartbeat: Keep the connection alive
            this.startHeartbeat(provider);

            return provider;
        } else {
            console.log(`[Network] Initializing HTTP Provider (Fallback)...`);
            return new ethers.JsonRpcProvider(this.url);
        }
    }

    private startHeartbeat(provider: ethers.WebSocketProvider) {
        if (this.pingInterval) clearInterval(this.pingInterval);

        // Ping every 30 seconds to prevent timeout
        this.pingInterval = setInterval(async () => {
            try {
                await provider.getBlockNumber();
            } catch (e) {
                console.error("[Network] Heartbeat failed. Reconnecting...");
                this.triggerReconnect();
            }
        }, 30000);
    }

    private async triggerReconnect() {
        if (this.pingInterval) clearInterval(this.pingInterval);

        // Wait 5 seconds before reconnecting to avoid spamming
        await new Promise((r) => setTimeout(r, 5000));

        this.provider = this.initProvider();
        this.reconnectCallback(); // Notify main app to reload contracts
    }

    public getProvider() {
        return this.provider;
    }
}
