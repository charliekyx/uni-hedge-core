import { ethers } from 'ethers';
import { Pool, Position } from '@uniswap/v3-sdk';
import { Token } from '@uniswap/sdk-core';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

import { 
    USDC_TOKEN, WETH_TOKEN, POOL_FEE, POOL_ABI, ERC20_ABI,
    NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, V3_FACTORY_ADDR, SWAP_ROUTER_ADDR
} from './config';

dotenv.config();

// ==========================================
// 1. 状态管理 (bot_state.json)
// ==========================================

const STATE_FILE = path.join(__dirname, 'bot_state.json');
const SWAP_ROUTER_ABI = [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)"
];

interface BotState {
    tokenId: string; 
    lastCheck: number;
}

function loadState(): BotState {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const data = fs.readFileSync(STATE_FILE, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            console.error("读取状态文件失败，重置状态。");
        }
    }
    return { tokenId: "0", lastCheck: 0 };
}

function saveState(tokenId: string) {
    const state: BotState = { tokenId, lastCheck: Date.now() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[系统] 状态已保存: Token ID ${tokenId}`);
}

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ==========================================
// 2. 核心工具函数
// ==========================================

async function getBalance(token: Token, wallet: ethers.Wallet): Promise<bigint> {
    const contract = new ethers.Contract(token.address, ERC20_ABI, wallet);
    return await contract.balanceOf(wallet.address);
}

// 检查并授权
async function checkAndApprove(token: Token, contract: ethers.Contract, spender: string, owner: string) {
    const allowance = await contract.allowance(owner, spender);
    // 简单判断: 如果授权额度为 0 则授权最大值
    if (allowance === 0n) {
        console.log(`[授权] 正在授权 ${token.symbol} 给 ${spender}...`);
        try {
            const tx = await contract.approve(spender, ethers.MaxUint256);
            await tx.wait();
            console.log(`[授权] ${token.symbol} 授权成功。`);
        } catch (e) {
            console.error(`[授权] 失败:`, e);
            throw e;
        }
    }
}

async function approveAll(wallet: ethers.Wallet) {
    const usdc = new ethers.Contract(USDC_TOKEN.address, ERC20_ABI, wallet);
    const weth = new ethers.Contract(WETH_TOKEN.address, ERC20_ABI, wallet);
    
    // 授权 NFT Manager (Mint)
    await checkAndApprove(USDC_TOKEN, usdc, NONFUNGIBLE_POSITION_MANAGER_ADDR, wallet.address);
    await checkAndApprove(WETH_TOKEN, weth, NONFUNGIBLE_POSITION_MANAGER_ADDR, wallet.address);

    // 授权 Swap Router (Rebalance)
    await checkAndApprove(USDC_TOKEN, usdc, SWAP_ROUTER_ADDR, wallet.address);
    await checkAndApprove(WETH_TOKEN, weth, SWAP_ROUTER_ADDR, wallet.address);
}

// ==========================================
// 3. 业务逻辑 (Rebalance, Mint)
// ==========================================

// 资产平衡: 卖出多余资产，使价值接近 50/50
async function rebalancePortfolio(wallet: ethers.Wallet, configuredPool: Pool) {
    console.log(`\n[调仓] 开始资产检查...`);

    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    const valUSDC = Number(ethers.formatUnits(balUSDC, 6));
    const valWETH = Number(ethers.formatUnits(balWETH, 18));
    
    // 以 USDC 计价
    // Token0 (WETH) price in terms of Token1 (USDC)
    const priceWETH = parseFloat(configuredPool.token0Price.toSignificant(6));
    const totalValueUSDC = valUSDC + (valWETH * priceWETH);
    
    console.log(`   持仓: ${valUSDC.toFixed(2)} USDC + ${valWETH.toFixed(4)} WETH`);
    console.log(`   总价值: ≈$${totalValueUSDC.toFixed(2)} (WETH价格: $${priceWETH})`);

    const targetValue = totalValueUSDC / 2;
    const usdcDiff = valUSDC - targetValue; // 正数=USDC多，负数=WETH多
    
    // 阈值: 偏差小于 2 USD 不操作 (测试网可调低)
    if (Math.abs(usdcDiff) < 2) {
        console.log(`   [调仓] 比例平衡，无需操作。`);
        return;
    }

    const router = new ethers.Contract(SWAP_ROUTER_ADDR, SWAP_ROUTER_ABI, wallet);
    
    if (usdcDiff > 0) {
        // 卖 USDC -> 买 WETH
        const amountToSell = ethers.parseUnits(usdcDiff.toFixed(6), 6);
        console.log(`   [Swap] 卖出 ${usdcDiff.toFixed(2)} USDC -> WETH`);
        
        const tx = await router.exactInputSingle({
            tokenIn: USDC_TOKEN.address,
            tokenOut: WETH_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountToSell,
            amountOutMinimum: 0, 
            sqrtPriceLimitX96: 0
        });
        await tx.wait();

    } else {
        // 卖 WETH -> 买 USDC
        const wethToSellVal = Math.abs(usdcDiff) / priceWETH;
        // 留一点点 Gas (虽然 Sepolia ETH 是 Gas，但如果卖太多可能导致 tx 失败)
        const amountToSell = ethers.parseUnits((wethToSellVal * 0.99).toFixed(18), 18);
        console.log(`   [Swap] 卖出 ${wethToSellVal.toFixed(4)} WETH -> USDC`);

        const tx = await router.exactInputSingle({
            tokenIn: WETH_TOKEN.address,
            tokenOut: USDC_TOKEN.address,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 120,
            amountIn: amountToSell,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        });
        await tx.wait();
    }
    console.log(`   [调仓] 完成。`);
}

// 铸造新头寸
async function mintMaxLiquidity(wallet: ethers.Wallet, configuredPool: Pool, tickLower: number, tickUpper: number): Promise<string> {
    const balUSDC = await getBalance(USDC_TOKEN, wallet);
    const balWETH = await getBalance(WETH_TOKEN, wallet);

    // 使用 fromAmounts 计算最大可能的流动性
    const position = Position.fromAmounts({
        pool: configuredPool,
        tickLower,
        tickUpper,
        amount0: balWETH.toString(), 
        amount1: balUSDC.toString(), 
        useFullPrecision: true
    });

    const mintParams = {
        token0: WETH_TOKEN.address,
        token1: USDC_TOKEN.address,
        fee: POOL_FEE,
        tickLower,
        tickUpper,
        amount0Desired: position.mintAmounts.amount0.toString(),
        amount1Desired: position.mintAmounts.amount1.toString(),
        amount0Min: 0, // 生产环境建议设置 0.5% 滑点
        amount1Min: 0,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 120
    };

    console.log(`\n[Mint] 准备铸造新头寸...`);
    console.log(`   投入: ${ethers.formatUnits(mintParams.amount1Desired, 6)} USDC + ${ethers.formatUnits(mintParams.amount0Desired, 18)} WETH`);

    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    const tx = await npm.mint(mintParams);
    const receipt = await tx.wait();

    // 解析 TokenID
    const event = receipt.logs.find((log: any) => log.topics[0] === ethers.id('Mint(uint256,address,address,uint24,int24,int24,uint128,uint256,uint256)'));
    const newTokenId = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], event.data)[0].toString();
    
    console.log(`[Mint] 成功! Token ID: ${newTokenId}`);
    return newTokenId;
}

// 完整的重平衡流程
async function executeFullRebalance(wallet: ethers.Wallet, configuredPool: Pool, oldTokenId: string) {
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);

    // 1. 销毁旧头寸 (如果有)
    if (oldTokenId !== "0") {
        console.log(`\n[重平衡] 处理旧头寸 ${oldTokenId}...`);
        try {
            const pos = await npm.positions(oldTokenId);
            const liquidity = pos.liquidity;
            
            if (liquidity > 0n) {
                console.log("   移除流动性...");
                const txDec = await npm.decreaseLiquidity({
                    tokenId: oldTokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: Math.floor(Date.now() / 1000) + 120
                });
                await txDec.wait();
            }

            console.log("   收取本金与收益...");
            const txCol = await npm.collect({
                tokenId: oldTokenId,
                recipient: wallet.address,
                amount0Max: ethers.MaxUint256,
                amount1Max: ethers.MaxUint256
            });
            await txCol.wait();

            console.log("   销毁 NFT...");
            await npm.burn(oldTokenId);
            
        } catch (e) {
            console.error(`   [警告] 处理旧头寸失败 (可能已不存在):`, e);
        }
    }

    // 2. 调仓
    await rebalancePortfolio(wallet, configuredPool);

    // 3. 计算新区间 (+/- 1000 ticks)
    const currentTick = configuredPool.tickCurrent;
    const tickSpace = configuredPool.tickSpacing;
    const WIDTH = 1000;
    
    let tickLower = Math.floor((currentTick - WIDTH) / tickSpace) * tickSpace;
    let tickUpper = Math.floor((currentTick + WIDTH) / tickSpace) * tickSpace;
    if (tickLower === tickUpper) tickUpper += tickSpace;
    if (tickLower > tickUpper) [tickLower, tickUpper] = [tickUpper, tickLower];

    console.log(`   新区间: [${tickLower}, ${tickUpper}]`);

    // 4. Mint
    const newTokenId = await mintMaxLiquidity(wallet, configuredPool, tickLower, tickUpper);

    // 5. 保存
    saveState(newTokenId);
}

// ==========================================
// 4. 主循环
// ==========================================

async function runLifeCycle() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
    
    // 初始化合约
    const poolAddr = Pool.getAddress(USDC_TOKEN, WETH_TOKEN, POOL_FEE, undefined, V3_FACTORY_ADDR);
    const poolContract = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const npm = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);

    console.log(`\n[系统] 唤醒检查 | 账户: ${wallet.address}`);
    await approveAll(wallet);

    // 读取数据
    const [slot0, liquidity] = await Promise.all([poolContract.slot0(), poolContract.liquidity()]);
    const configuredPool = new Pool(
        USDC_TOKEN, WETH_TOKEN, POOL_FEE, slot0.sqrtPriceX96.toString(), liquidity.toString(), Number(slot0.tick)
    );
    const currentTick = Number(slot0.tick);
    
    // 价格显示 (正确处理 Token0/1)
    const price0 = configuredPool.token0Price.toSignificant(6);
    const price1 = configuredPool.token1Price.toSignificant(6);
    console.log(`   当前价格: 1 WETH = ${price0} USDC | Tick: ${currentTick}`);

    let { tokenId } = loadState();

    // 场景 A: 首次运行
    if (tokenId === "0") {
        console.log(`   [状态] 无活跃头寸，开始初始化...`);
        await executeFullRebalance(wallet, configuredPool, "0");
        return;
    }

    // 场景 B: 检查现有头寸
    try {
        const pos = await npm.positions(tokenId);
        
        // 检查是否已被完全提取
        if (pos.liquidity === 0n && pos.tickLower === 0n) {
             console.log(`   [状态] 头寸 ${tokenId} 无效，重新建仓。`);
             await executeFullRebalance(wallet, configuredPool, "0");
             return;
        }

        const tickLower = Number(pos.tickLower);
        const tickUpper = Number(pos.tickUpper);
        
        const isOutOfRange = currentTick < tickLower || currentTick > tickUpper;
        
        if (isOutOfRange) {
            console.log(`   [警告] 价格出界! 当前 ${currentTick} 不在 [${tickLower}, ${tickUpper}]`);
            console.log(`   >>> 触发重平衡流程 <<<`);
            await executeFullRebalance(wallet, configuredPool, tokenId);
        } else {
            console.log(`   [状态] 正常运行中. 区间: [${tickLower}, ${tickUpper}]`);
            // 打印未提取收益
            const fees0 = ethers.formatUnits(pos.tokensOwed0, 18);
            const fees1 = ethers.formatUnits(pos.tokensOwed1, 6);
            console.log(`   待收收益: ${fees0} WETH / ${fees1} USDC`);
        }

    } catch (e) {
        console.error(`   [错误] 读取头寸信息失败:`, e);
    }
}

async function main() {
    while (true) {
        try {
            await runLifeCycle();
        } catch (e) {
            console.error("[致命错误] 主循环异常:", e);
        }
        console.log(`[系统] 休眠 5 分钟...`);
        await sleep(5 * 60 * 1000); 
    }
}

main();