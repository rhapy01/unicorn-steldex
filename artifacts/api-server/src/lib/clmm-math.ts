/** Q32.32 fixed-point helpers (matches on-chain pool/router math). */
const Q32 = 1n << 32n;

const SQRT_RATIOS = [
  4294967510n,
  4295182081n,
  4295611251n,
  4296469654n,
  4298186610n,
  4301624122n,
  4308510505n,
  4322345397n,
  4350303842n,
  4407276366n,
  4525352677n,
  4775269659n,
  5326259950n,
  6634987051n,
  10285119115n,
  24733587905n,
  143126956685n,
  4810775551248n,
  545383428507040n,
  7047666939293130n,
];

/** token1 per token0 human price → Q32.32 sqrt price (matches pool). */
export function humanPriceToSqrtQ32(priceHuman: number): bigint {
  if (!Number.isFinite(priceHuman) || priceHuman <= 0) return 0n;
  const sqrt = Math.sqrt(priceHuman);
  return BigInt(Math.floor(sqrt * Number(Q32)));
}

export function sqrtQ32ToHumanPrice(sqrtQ32: bigint): number {
  const ratio = Number(sqrtQ32) / Number(Q32);
  return ratio * ratio;
}

/** Convert pool sqrt (token1/token0) to a human "to per from" display price. */
export function poolSqrtToDisplayPrice(
  sqrtQ32: bigint,
  fromContract: string,
  token0: string,
): number {
  const token1PerToken0 = sqrtQ32ToHumanPrice(sqrtQ32);
  if (token1PerToken0 <= 0) return 0;
  return fromContract === token0 ? token1PerToken0 : 1 / token1PerToken0;
}

/** Convert human "to per from" limit price to pool sqrt (token1/token0). */
export function displayPriceToPoolSqrt(
  priceToPerFrom: number,
  fromContract: string,
  token0: string,
): bigint {
  if (!Number.isFinite(priceToPerFrom) || priceToPerFrom <= 0) return 0n;
  const token1PerToken0 =
    fromContract === token0 ? priceToPerFrom : 1 / priceToPerFrom;
  return humanPriceToSqrtQ32(token1PerToken0);
}

export function tickToSqrtQ32(tick: number): bigint {
  const absTick = tick < 0 ? BigInt(-tick) : BigInt(tick);
  let result = Q32;
  for (let i = 0; i < 19; i++) {
    if (absTick & (1n << BigInt(i))) {
      result = (result * SQRT_RATIOS[i]!) / Q32;
    }
  }
  if (tick < 0) {
    result = (Q32 * Q32) / result;
  }
  return result;
}

export function liquidityFromAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  const lo = sqrtA < sqrtB ? sqrtA : sqrtB;
  const hi = sqrtA < sqrtB ? sqrtB : sqrtA;
  if (lo === 0n || hi === 0n || amount0 === 0n) return 0n;
  const delta = hi - lo;
  const denom = (lo * hi) / Q32;
  if (denom === 0n || delta === 0n) return 0n;
  return (amount0 * denom) / delta;
}

export function liquidityFromAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  const lo = sqrtA < sqrtB ? sqrtA : sqrtB;
  const hi = sqrtA < sqrtB ? sqrtB : sqrtA;
  if (amount1 === 0n) return 0n;
  const delta = hi - lo;
  if (delta === 0n) return 0n;
  return (amount1 * Q32) / delta;
}

export function computeLiquidity(
  sqrtPrice: bigint,
  sqrtPa: bigint,
  sqrtPb: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtPb <= sqrtPa) return 0n;
  if (sqrtPrice <= sqrtPa) {
    return liquidityFromAmount0(sqrtPa, sqrtPb, amount0);
  }
  if (sqrtPrice >= sqrtPb) {
    return liquidityFromAmount1(sqrtPa, sqrtPb, amount1);
  }
  const liq0 = liquidityFromAmount0(sqrtPrice, sqrtPb, amount0);
  const liq1 = liquidityFromAmount1(sqrtPa, sqrtPrice, amount1);
  return liq0 < liq1 ? liq0 : liq1;
}
