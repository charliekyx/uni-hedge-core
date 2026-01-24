import axios from 'axios';
import { RSI, ATR } from 'technicalindicators';
import { withRetry } from './utils'; // Reuse retry logic

// Binance API for public market data
const BINANCE_API_URL = 'https://api.binance.com/api/v3/klines';

// Coinbase API for fallback (ETH-USD)
const COINBASE_API_URL = 'https://api.exchange.coinbase.com/products/ETH-USD/candles';

interface CandleData {
    high: number[];
    low: number[];
    close: number[];
}

async function fetchCandles(symbol: string, interval: string, limit: number): Promise<CandleData> {
    // 1. Try Binance
    try {
        const response = await axios.get(BINANCE_API_URL, {
            params: {
                symbol: symbol,
                interval: interval,
                limit: limit
            },
            timeout: 5000
        });

        // Binance API format: [open_time, open, high, low, close, ...]
        // Index: 2=High, 3=Low, 4=Close
        const highs = response.data.map((c: any[]) => parseFloat(c[2]));
        const lows = response.data.map((c: any[]) => parseFloat(c[3]));
        const closes = response.data.map((c: any[]) => parseFloat(c[4]));

        return { high: highs, low: lows, close: closes };
    } catch (error: any) {
        console.warn(`[Analytics] Binance API failed (${error.message}). Switching to Coinbase fallback...`);
        
        // 2. Try Coinbase Fallback
        try {
            // Map interval to seconds (Coinbase uses 'granularity' in seconds)
            let granularity = 3600; // Default 1h
            if (interval === '15m') granularity = 900;
            if (interval === '5m') granularity = 300;
            if (interval === '1d') granularity = 86400;

            // Note: Coinbase uses ETH-USD. We ignore the 'symbol' param (ETHUSDT) for fallback.
            const response = await axios.get(COINBASE_API_URL, {
                params: {
                    granularity: granularity
                },
                timeout: 5000
            });

            // Coinbase returns [ time, low, high, open, close, volume ]
            // And it returns Newest -> Oldest. We need to reverse it for technicalindicators.
            const data = response.data.reverse();

            // Ensure we have enough data, take the last 'limit' candles
            const slicedData = data.slice(-limit);

            const highs = slicedData.map((c: number[]) => c[2]);
            const lows = slicedData.map((c: number[]) => c[1]);
            const closes = slicedData.map((c: number[]) => c[4]);

            return { high: highs, low: lows, close: closes };

        } catch (cbError: any) {
            throw new Error(`Failed to fetch market data. Binance: ${error.message} | Coinbase: ${cbError.message}`);
        }
    }
}

export async function getEthRsi(interval: string = '1h', period: number = 14): Promise<number> {
    try {
        // Use withRetry to increase stability
        const data = await withRetry(() => fetchCandles('ETHUSDT', interval, period + 50));
        
        const inputRSI = {
            values: data.close,
            period: period
        };

        const rsiResult = RSI.calculate(inputRSI);

        if (rsiResult.length > 0) {
            return rsiResult[rsiResult.length - 1];
        }
        throw new Error("Insufficient data for RSI");
    } catch (error) {
        console.error(`[Analytics] Failed to fetch RSI: ${(error as Error).message}`);
        throw error; // Throw error to stop strategy execution and prevent wrong positioning
    }
}

/**
 * Calculate Average True Range (ATR) to measure volatility in USD.
 * Returns the average dollar movement per candle (e.g., $30).
 */
export async function getEthAtr(interval: string = '1h', period: number = 14): Promise<number> {
    try {
        // Use withRetry to increase stability
        const data = await withRetry(() => fetchCandles('ETHUSDT', interval, period + 20));
        
        const inputATR = {
            high: data.high,
            low: data.low,
            close: data.close,
            period: period
        };

        const atrResult = ATR.calculate(inputATR);

        if (atrResult.length > 0) {
            return atrResult[atrResult.length - 1];
        }
        
        throw new Error("Insufficient data for ATR");
    } catch (error) {
        console.error(`[Analytics] Failed to fetch ATR: ${(error as Error).message}`);
        throw error; 
    }
}