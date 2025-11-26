# UniHedge Bot: Uniswap V3 Delta-Neutral Market Maker

A professional-grade, automated liquidity provision bot for **Uniswap V3 (Arbitrum One)**.
It features **Delta Neutral Hedging** via Aave V3, **RSI-based trend filtering**, and **Atomic execution** to maximize fee generation while minimizing price exposure and Impermanent Loss (IL).

## Key Features

- **Automated Rebalancing**: Automatically adjusts liquidity ranges when the price moves out of bounds to ensure 100% capital efficiency.

- **Delta Neutral Hedging**: Integrates with Aave V3 to borrow and short ETH. This neutralizes the inventory risk of holding ETH in the liquidity pool (Profits = Fees - Borrow Interest).

- **RSI Trend Filtering**: Prevents "buying the top" or "selling the bottom" during rebalances by checking the Relative Strength Index (RSI) from Binance data.

- **Atomic Execution**: Uses Multicall to bundle Decrease Liquidity -> Collect Fees -> Burn NFT into a single transaction. Zero dust left behind, zero gas wasted on failed steps.

- **Auto-Compounding**: Automatically reinvests earned fees into the new position during every rebalance cycle.

- **Smart Alerts**: Sends email notifications (via Nodemailer) for critical events: Price Shock, Rebalance Triggered, and Profit Collection.

- **Safety First**:
  - **99.9% Buffer**: Prevents "Insufficient Balance" reverts due to rounding errors.
  - **Slippage Protection**: Configurable thresholds.
  - **Price Shock Circuit Breaker**: Shuts down if volatility exceeds limits (e.g., 10% in 5 mins).

## Strategy Logic

1. **Market Making**:

  - Provides liquidity in a concentrated range (e.g., current_price ± 2000 ticks).

  - Collects trading fees from Uniswap.

2. **Hedging (Delta Neutral)**:

  - Calculates the precise amount of ETH held in the Uniswap position.

  - Borrows the exact same amount of ETH from Aave V3 (using USDC collateral).

  - Sells the borrowed ETH for USDC.

  - Result: If ETH drops, the LP loses value, but the Aave debt becomes cheaper to repay. Net PnL ≈ Fees.

3. **Execution**:

- Runs on a 5-minute cycle.

- Checks Current Tick vs Position Range.

- Checks Health Factor on Aave.

- Checks RSI before executing swaps.

## Prerequisites

- Node.js (v18+)

- Docker & Docker Compose (Recommended for production)

- Wallet: An Arbitrum wallet with:

  - USDC (Native): For principal and collateral.

  - ETH: For Gas fees (~0.01 ETH).

- RPC Provider: Alchemy or Infura URL for Arbitrum One.

## Installation

1. **Clone the repository**
```
git clone [https://github.com/yourusername/unihedge-bot.git](https://github.com/yourusername/unihedge-bot.git)
cd unihedge-bot
```

2. **Install Dependencies**
```
npm install
```

3. **Configuration**
Create a .env file in the root directory:
```
# Network Selection (MAINNET / SEPOLIA)
NETWORK="MAINNET"

## RPC Provider (Arbitrum One)
RPC_URL="[https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY](https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY)"

## Wallet Private Key (No 0x prefix needed)
PRIVATE_KEY="YOUR_PRIVATE_KEY"

## Email Alerts (Gmail App Password recommended)
EMAIL_SERVICE="gmail"
EMAIL_USER="your_email@gmail.com"
EMAIL_PASS="your_app_password"
EMAIL_TO="your_email@gmail.com"

## Risk Management
PRICE_SHOCK_THRESHOLD=10
```

## Usage

### Production (Docker)

This is the recommended way to run the bot 24/7 on a VPS.
```
# Build and Start in background
sudo docker compose up -d --build

# View Logs
sudo docker compose logs -f
```

### Local Development
```
### Run directly with TypeScript
npx ts-node main.ts
```

### Backtesting

Verify the strategy against historical data before deploying real capital.
```
## Run simulation using last 1 year of data
npx ts-node run_backtest_real.ts
```

## Disclaimer

This software is for educational and experimental purposes only.

- Smart Contract Risk: Uniswap V3 and Aave V3 protocols could be exploited.

- Liquidation Risk: If ETH price spikes significantly, your short position on Aave could face liquidation if not monitored (Health Factor).

- No Warranty: Use this bot at your own risk. The authors are not responsible for any financial losses.

License

MIT
