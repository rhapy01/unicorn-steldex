import { parseTokenAmount } from "./format";

export const TOKEN_DECIMALS: Record<string, number> = {
  XLM: 7,
  /** Custom pool USDC (deployed token, 6 decimals). */
  pUSDC: 6,
  /** Circle official USDC SAC (7 decimals). */
  cUSDC: 7,
  EURC: 7,
  BTC: 8,
  ETH: 18,
  STELLAR: 7,
};

export function tokenDecimals(symbol: string): number {
  return TOKEN_DECIMALS[symbol] ?? 7;
}

export type ContractsShape = {
  pool?: string | null;
  tokens?: Record<string, string>;
  pools?: Array<{ pair: string; contract: string }>;
};

export function resolveTokenContract(
  symbol: string,
  contracts: ContractsShape | undefined
): string | null {
  if (!contracts?.tokens) return null;
  const direct = contracts.tokens[symbol];
  if (direct) return direct;
  if (symbol === "pUSDC") return contracts.tokens.pUSDC ?? contracts.tokens.USDC ?? null;
  if (symbol === "cUSDC") return contracts.tokens.cUSDC ?? contracts.tokens.USDC_CIRCLE ?? null;
  return null;
}

/** Sort token contracts and amounts to match on-chain pool token0/token1. */
export function canonicalizeTokenPair(
  contractA: string,
  contractB: string,
  amountA: string,
  amountB: string,
): { token0: string; token1: string; amount0: string; amount1: string } {
  if (contractA < contractB) {
    return { token0: contractA, token1: contractB, amount0: amountA, amount1: amountB };
  }
  return { token0: contractB, token1: contractA, amount0: amountB, amount1: amountA };
}

export function resolvePoolContract(
  symbolA: string,
  symbolB: string,
  contracts: ContractsShape | undefined
): string | null {
  if (!contracts) return null;
  const pair = [symbolA, symbolB].sort().join("/");
  const listed = contracts.pools?.find((p) => p.pair === pair)?.contract;
  if (listed) return listed;
  if (contracts.pool && (pair === "pUSDC/XLM" || pair === "USDC/XLM")) return contracts.pool;
  return null;
}

export { parseTokenAmount };
