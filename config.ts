// config.ts
import { Token } from '@uniswap/sdk-core';
import { FeeAmount } from '@uniswap/v3-sdk';
import * as dotenv from 'dotenv';

dotenv.config();

// 读取环境变量，默认为 SEPOLIA
const NETWORK = process.env.NETWORK || 'SEPOLIA';

console.log(`[Config] 当前运行网络: ${NETWORK}`);

// --- 公共 ABI ---
export const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

export const POOL_ABI = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function tickSpacing() view returns (int24)"
];

export const NPM_ABI = [
    "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
    "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
    "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
    "function burn(uint256 tokenId) payable"
];

// --- 网络差异化配置 ---

let CHAIN_ID: number;
let WETH_TOKEN_CONF: Token;
let USDC_TOKEN_CONF: Token;
let NPM_ADDR_CONF: string;
let V3_FACTORY_ADDR_CONF: string;
let SWAP_ROUTER_ADDR_CONF: string;

if (NETWORK === 'MAINNET') {
    // Arbitrum One 主网配置
    CHAIN_ID = 42161;
    WETH_TOKEN_CONF = new Token(CHAIN_ID, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18, 'WETH', 'Wrapped Ether');
    USDC_TOKEN_CONF = new Token(CHAIN_ID, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'USDC', 'USD Coin');
    NPM_ADDR_CONF = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
    V3_FACTORY_ADDR_CONF = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    SWAP_ROUTER_ADDR_CONF = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
} else {
    // Sepolia 测试网配置
    // 注意: Sepolia 上的 Token 地址可能因水龙头不同而异，这里使用较通用的地址
    CHAIN_ID = 11155111;
    
    // Sepolia WETH (常用)
    WETH_TOKEN_CONF = new Token(CHAIN_ID, '0xfFf9976782d46CC05630D1f6eB9Fe0630dfbA605', 18, 'WETH', 'Wrapped Ether');
    
    // Sepolia USDC (Circle 官方测试币)
    USDC_TOKEN_CONF = new Token(CHAIN_ID, '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 6, 'USDC', 'USD Coin');
    
    NPM_ADDR_CONF = "0x1238497C19cEa4fA099307dE38A7c756C5119760"; 
    V3_FACTORY_ADDR_CONF = "0x0227628f3F023bbB3B9898287fCD7638d73f6F28";
    SWAP_ROUTER_ADDR_CONF = "0x3bFA4769FB09e8893f006F12D45212349f9aE488"; // SwapRouter02 on Sepolia
}

export const CURRENT_CHAIN_ID = CHAIN_ID;
export const WETH_TOKEN = WETH_TOKEN_CONF;
export const USDC_TOKEN = USDC_TOKEN_CONF;
export const NONFUNGIBLE_POSITION_MANAGER_ADDR = NPM_ADDR_CONF;
export const V3_FACTORY_ADDR = V3_FACTORY_ADDR_CONF;
export const SWAP_ROUTER_ADDR = SWAP_ROUTER_ADDR_CONF;

// 费率 0.3% (Medium) - 测试网和主网通用
export const POOL_FEE = FeeAmount.MEDIUM;