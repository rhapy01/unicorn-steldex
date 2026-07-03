import { addressScVal } from "./soroban-scval.js";
import { toI128String } from "./stellar-errors.js";

type StellarSdk = typeof import("@stellar/stellar-sdk");
type RpcServer = InstanceType<StellarSdk["rpc"]["Server"]>;

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const Q32 = 1n << 32n;

function getAmount0Delta(sqrtPa: bigint, sqrtPb: bigint, liquidity: bigint): bigint {
  const lo = sqrtPa <= sqrtPb ? sqrtPa : sqrtPb;
  const hi = sqrtPa <= sqrtPb ? sqrtPb : sqrtPa;
  if (lo === 0n || hi === 0n || liquidity === 0n) return 0n;
  const denom = (lo * hi) / Q32;
  if (denom === 0n) return 0n;
  return (liquidity * (hi - lo)) / denom;
}

function getAmount1Delta(sqrtPa: bigint, sqrtPb: bigint, liquidity: bigint): bigint {
  const lo = sqrtPa <= sqrtPb ? sqrtPa : sqrtPb;
  const hi = sqrtPa <= sqrtPb ? sqrtPb : sqrtPa;
  if (liquidity === 0n) return 0n;
  return (liquidity * (hi - lo)) / Q32;
}

function getNextSqrtPriceFromAmount0Input(
  sqrtPrice: bigint,
  liquidity: bigint,
  amountIn: bigint,
): bigint {
  if (amountIn === 0n) return sqrtPrice;
  const numerator = liquidity * sqrtPrice;
  const product = (amountIn * sqrtPrice) / Q32;
  return numerator / (liquidity + product);
}

function getNextSqrtPriceFromAmount1Input(
  sqrtPrice: bigint,
  liquidity: bigint,
  amountIn: bigint,
): bigint {
  return sqrtPrice + (amountIn * Q32) / liquidity;
}

async function simulatePoolView(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
  fn: string,
): Promise<bigint> {
  const source = await server.getAccount(SIM_SOURCE);
  const pool = new StellarSdk.Contract(poolAddress);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(pool.call(fn))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(String(sim.error));
  return StellarSdk.scValToBigInt(sim.result!.retval!);
}

export async function poolSqrtPrice(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
): Promise<bigint> {
  const source = await server.getAccount(SIM_SOURCE);
  const pool = new StellarSdk.Contract(poolAddress);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(pool.call("sqrt_price"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(String(sim.error));
  return StellarSdk.scValToBigInt(sim.result!.retval!);
}

async function poolToken(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
  method: "token0" | "token1",
): Promise<string> {
  const source = await server.getAccount(SIM_SOURCE);
  const pool = new StellarSdk.Contract(poolAddress);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(pool.call(method))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(String(sim.error));
  const hex = Buffer.from(sim.result!.retval!.address().contractId()).toString("hex");
  return StellarSdk.StrKey.encodeContract(Buffer.from(hex, "hex"));
}

export async function poolToken0(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
): Promise<string> {
  return poolToken(StellarSdk, server, poolAddress, "token0");
}

export async function poolToken1(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
): Promise<string> {
  return poolToken(StellarSdk, server, poolAddress, "token1");
}

/**
 * Quote swap output from pool state (no wallet balance / allowance required).
 * Matches on-chain single-step swap math in `contracts/pool`.
 */
export async function quotePoolSwapOutput(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
  fromTokenContract: string,
  amountIn: bigint,
): Promise<bigint> {
  const token0 = await poolToken0(StellarSdk, server, poolAddress);
  const zeroForOne = fromTokenContract === token0;
  const sqrtPrice = await poolSqrtPrice(StellarSdk, server, poolAddress);
  const liquidity = await simulatePoolView(StellarSdk, server, poolAddress, "liquidity");
  const feeBps = await simulatePoolView(StellarSdk, server, poolAddress, "fee_bps");

  if (liquidity === 0n || amountIn <= 0n) return 0n;

  const feeAmount = (amountIn * feeBps) / 10000n;
  const amountInAfterFee = amountIn - feeAmount;

  // Quote uses pool math only — do not clamp to swap price limits (that caused flat ~0.14 USDC).
  if (zeroForOne) {
    const nextSqrt = getNextSqrtPriceFromAmount0Input(sqrtPrice, liquidity, amountInAfterFee);
    return getAmount1Delta(nextSqrt, sqrtPrice, liquidity);
  }

  const nextSqrt = getNextSqrtPriceFromAmount1Input(sqrtPrice, liquidity, amountInAfterFee);
  return getAmount0Delta(sqrtPrice, nextSqrt, liquidity);
}

/** Wide execution limit so swaps are not capped at ~2× spot on low-liquidity testnet pools. */
export function swapExecutionPriceLimit(sqrtPrice: bigint, zeroForOne: boolean): bigint {
  return zeroForOne ? sqrtPrice / 100n : sqrtPrice * 100n;
}

/** Simulate pool.swap exact-input; returns output token amount. */
export async function simulatePoolSwapOutput(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
  walletAddress: string,
  fromTokenContract: string,
  amountIn: bigint,
): Promise<bigint> {
  const token0 = await poolToken0(StellarSdk, server, poolAddress);
  const zeroForOne = fromTokenContract === token0;
  const sqrtPrice = await poolSqrtPrice(StellarSdk, server, poolAddress);
  const priceLimit = swapExecutionPriceLimit(sqrtPrice, zeroForOne);

  const account = await server.getAccount(walletAddress);
  const pool = new StellarSdk.Contract(poolAddress);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      pool.call(
        "swap",
        addressScVal(StellarSdk, walletAddress),
        StellarSdk.nativeToScVal(zeroForOne, { type: "bool" }),
        StellarSdk.nativeToScVal(amountIn, { type: "i128" }),
        StellarSdk.nativeToScVal(priceLimit, { type: "u128" }),
      ),
    )
    .setTimeout(300)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(typeof sim.error === "string" ? sim.error : JSON.stringify(sim));
  }
  const val = sim.result?.retval;
  if (!val) return 0n;

  // pool.swap returns (amount0, amount1); output is negative leg
  if (val.switch().name === "scvVec") {
    const vec = val.vec() ?? [];
    if (vec.length >= 2) {
      const d0 = StellarSdk.scValToBigInt(vec[0]);
      const d1 = StellarSdk.scValToBigInt(vec[1]);
      const out = zeroForOne ? -d1 : -d0;
      return out > 0n ? out : 0n;
    }
  }
  const single = StellarSdk.scValToBigInt(val);
  return single > 0n ? single : 0n;
}

/** @deprecated use simulatePoolSwapOutput with pool address */
export async function simulateSwapExactOutput(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolOrRouter: string,
  walletAddress: string,
  fromTokenContract: string,
  _toTokenContract: string,
  amountIn: bigint,
): Promise<bigint> {
  return simulatePoolSwapOutput(
    StellarSdk,
    server,
    poolOrRouter,
    walletAddress,
    fromTokenContract,
    amountIn,
  );
}

export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.min(Math.max(slippageBps, 0), 5000));
  return (amountOut * (10000n - bps)) / 10000n;
}

export function parseAmountIn(amountIn: string | undefined): bigint {
  return toI128String(amountIn);
}

export async function buildPoolSwapOperation(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
  walletAddress: string,
  fromTokenContract: string,
  amountIn: bigint,
) {
  const token0 = await poolToken0(StellarSdk, server, poolAddress);
  const zeroForOne = fromTokenContract === token0;
  const sqrtPrice = await poolSqrtPrice(StellarSdk, server, poolAddress);
  const priceLimit = swapExecutionPriceLimit(sqrtPrice, zeroForOne);
  const pool = new StellarSdk.Contract(poolAddress);
  return pool.call(
    "swap",
    addressScVal(StellarSdk, walletAddress),
    StellarSdk.nativeToScVal(zeroForOne, { type: "bool" }),
    StellarSdk.nativeToScVal(amountIn, { type: "i128" }),
    StellarSdk.nativeToScVal(priceLimit, { type: "u128" }),
  );
}
