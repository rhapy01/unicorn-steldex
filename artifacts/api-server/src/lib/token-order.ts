/** Canonical Soroban token order (matches factory pool token0/token1). */
export function canonicalizeTokenPair(
  tokenA: string,
  tokenB: string,
  amountA: string,
  amountB: string,
): { token0: string; token1: string; amount0: string; amount1: string } {
  if (tokenA < tokenB) {
    return { token0: tokenA, token1: tokenB, amount0: amountA, amount1: amountB };
  }
  return { token0: tokenB, token1: tokenA, amount0: amountB, amount1: amountA };
}
