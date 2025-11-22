// main.ts
import { ethers } from "ethers";
import {
  Pool,
  Position,
  nearestUsableTick,
  priceToClosestTick, // 必须导入这个
} from "@uniswap/v3-sdk";
import { Token, CurrencyAmount, Percent } from "@uniswap/sdk-core";
import * as dotenv from "dotenv";
import {
  USDC_TOKEN,
  WETH_TOKEN,
  POOL_FEE,
  POOL_ABI,
  ERC20_ABI,
  NONFUNGIBLE_POSITION_MANAGER_ADDR,
  NPM_ABI,
  V3_FACTORY_ADDR,
} from "./config";
import JSBI from 'jsbi';

dotenv.config();

async function main() {
  // ==========================================
  // 1. 初始化连接
  // ==========================================
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  // 即使只是读取，创建钱包也是个好习惯，为后续交易做准备
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);
  console.log(`🤖 机器人启动，操作账户: ${wallet.address}`);

  // ==========================================
  // 2. 连接池子并读取数据
  // ==========================================
  // 计算 Pool 地址
  const poolAddress = Pool.getAddress(
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    undefined,
    V3_FACTORY_ADDR,
  );
  console.log(`🏊 目标池子 (USDC/WETH): ${poolAddress}`);

  const poolContract = new ethers.Contract(poolAddress, POOL_ABI, provider);

  // 读取链上 Slot0 (包含 sqrtPriceX96 和 tick) 和 Liquidity
  const [slot0, liquidity] = await Promise.all([
    poolContract.slot0(),
    poolContract.liquidity(),
  ]);

  // ==========================================
  // 3. 构建 SDK Pool 对象
  // ==========================================
  const configuredPool = new Pool(
    USDC_TOKEN,
    WETH_TOKEN,
    POOL_FEE,
    slot0.sqrtPriceX96.toString(),
    liquidity.toString(),
    Number(slot0.tick),
  );

  console.log(`\n📊 当前市场状态:`);
  console.log(`   当前 Tick: ${slot0.tick}`);
  // toSignificant(6) 保留6位有效数字
  console.log(
    `   当前价格: 1 WETH ≈ ${configuredPool.token1Price.toSignificant(6)} USDC`,
  );
 // ==========================================
    // 4. 策略逻辑：设定价格区间 (已修复 BigInt 报错)
    // ==========================================
    
    // 🚨 修复 1: 价格显示修正
    // 在 Arbitrum 上，WETH (0x82...) 地址小于 USDC (0xaf...)
    // 所以 Token0 = WETH, Token1 = USDC
    // pool.token0Price = WETH 的价格 (以 USDC 计价) -> 这才是我们要的 3000+
    // pool.token1Price = USDC 的价格 (以 WETH 计价) -> 所以你之前看到了 0.0003
    
    const marketPrice = configuredPool.token0Price; 
    console.log(`   ✅ 修正价格: 1 WETH ≈ ${marketPrice.toSignificant(6)} USDC`);

    // 🚨 修复 2: 类型转换 BigInt -> Number
    // slot0.tick 是 BigInt (例如 -197201n)，必须转成 Number 才能计算
    const currentTick = Number(slot0.tick);
    
    const TICK_RANGE_WIDTH = 1000; // 设定区间宽度

    let tickLower = currentTick - TICK_RANGE_WIDTH;
    let tickUpper = currentTick + TICK_RANGE_WIDTH;

    // ==========================================
    // 5. 对齐 Tick
    // ==========================================
    const tickSpace = configuredPool.tickSpacing;

    // 对齐算法 (保持整数运算)
    tickLower = Math.floor(tickLower / tickSpace) * tickSpace;
    tickUpper = Math.floor(tickUpper / tickSpace) * tickSpace;

    // 防止重叠和顺序错误
    if (tickLower === tickUpper) {
        tickUpper += tickSpace;
    }
    if (tickLower > tickUpper) {
        [tickLower, tickUpper] = [tickUpper, tickLower];
    }
  console.log(`   Tick 区间: [${tickLower}, ${tickUpper}]`);

  // ==========================================
  // 6. 资金准备：计算需要多少币
  // ==========================================
  // 假设你要投入 500 USDC (Token0)
  const amount1Input = "500";

const position = Position.fromAmount1({
        pool: configuredPool,
        tickLower: tickLower,
        tickUpper: tickUpper,
        amount1: ethers.parseUnits(amount1Input, 6).toString(), // USDC 精度 6
        // useFullPrecision: true 
    });

  // 获取计算结果
  const amount0Required = position.mintAmounts.amount0;
  const amount1Required = position.mintAmounts.amount1;

  const usdcReadable = ethers.formatUnits(amount0Required.toString(), 6);
  const wethReadable = ethers.formatUnits(amount1Required.toString(), 18);

  console.log(`\n💰 资金配对计算:`);
  console.log(`   为了投入: ${usdcReadable} USDC`);
  console.log(`   你需要配对: ${wethReadable} WETH`);

  // ==========================================
  // 7. 准备交易参数 (模拟模式)
  // ==========================================

  // 设置滑点保护: 0.5% (50 / 10000)
  const slippageTolerance = new Percent(50, 10_000);

  // 计算包含滑点保护的最小输出量
  const { amount0: amount0Min, amount1: amount1Min } =
    position.mintAmountsWithSlippage(slippageTolerance);

  const mintParams = {
    token0: USDC_TOKEN.address,
    token1: WETH_TOKEN.address,
    fee: POOL_FEE,
    tickLower: tickLower,
    tickUpper: tickUpper,
    amount0Desired: amount0Required.toString(),
    amount1Desired: amount1Required.toString(),
    amount0Min: amount0Min.toString(), // 关键防夹保护
    amount1Min: amount1Min.toString(), // 关键防夹保护
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 10, // 10分钟有效
  };

  console.log(`\n📝 交易参数构建完成 (模拟):`);
  console.log(mintParams);

  console.log(`\n⚠️ 此时尚未发送交易。`);
  console.log(
    `   若要执行，请确保已对 NFT Manager (${NONFUNGIBLE_POSITION_MANAGER_ADDR}) 进行 Approve 授权。`,
  );

  /* // --- 解锁以下代码以真正发送交易 ---
    
    // 1. 实例化 NFT Manager 合约
    const npmContract = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER_ADDR, NPM_ABI, wallet);
    
    // 2. (可选) 可以在这里加一段代码自动检查 Approve 状态并授权...

    // 3. 发送 Mint 交易
    // const tx = await npmContract.mint(mintParams);
    // console.log(`🚀 交易已发送! Hash: ${tx.hash}`);
    // await tx.wait();
    // console.log(`✅ 流动性添加成功!`);
    */
}

main().catch((e) => console.error(e));
