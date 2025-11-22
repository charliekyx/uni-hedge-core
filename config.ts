// config.ts
import { Token } from '@uniswap/sdk-core'
import { FeeAmount } from '@uniswap/v3-sdk'

export const ARB_CHAIN_ID = 42161;

// 1. 代币定义 (Arbitrum One)
// USDC (Native)
export const USDC_TOKEN = new Token(ARB_CHAIN_ID, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6, 'USDC', 'USD Coin');
// WETH
export const WETH_TOKEN = new Token(ARB_CHAIN_ID, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18, 'WETH', 'Wrapped Ether');

// 2. 池子配置
// 我们选择 0.05% (FeeAmount.MEDIUM 为 3000，LOW 为 500)
// 稳定币对通常用 0.05% (500)，主流币对用 0.3% (3000)
export const POOL_FEE = FeeAmount.MEDIUM; // 0.3%

// 3. 合约地址
export const NONFUNGIBLE_POSITION_MANAGER_ADDR = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"; // V3 NFT 管理器
export const V3_FACTORY_ADDR = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; 

// 4. ABI (应用程序二进制接口)
export const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function approve(address spender, uint256 amount) returns (bool)"
];

export const POOL_ABI = [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function tickSpacing() view returns (int24)"
];

// NFT 管理器是主要交互入口
export const NPM_ABI = [
    "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
    "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)"
];