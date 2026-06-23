import type { ContractConfig } from "./contract-config.js";

const DECIMALS: Record<string, number> = {
  XLM: 7,
  pUSDC: 6,
  cUSDC: 7,
  EURC: 7,
  STELLAR: 7,
};

export function decimalsForSymbol(symbol: string): number {
  return DECIMALS[symbol] ?? 7;
}

export function decimalsForContract(contract: string, config: ContractConfig): number {
  if (contract === config.poolUsdc || contract === config.tokens.pUSDC) return 6;
  return 7;
}
