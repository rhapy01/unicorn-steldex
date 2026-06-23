import type { ContractConfig } from "./contract-config.js";
import type { OnChainPool } from "./pool-registry.js";

export function symbolForContract(
  contract: string,
  config: ContractConfig,
): string | null {
  for (const [symbol, addr] of Object.entries(config.tokens)) {
    if (addr === contract) return symbol;
  }
  return null;
}

export function isRoutableSwap(
  fromContract: string,
  toContract: string,
  pools: OnChainPool[],
): boolean {
  if (fromContract === toContract) return false;
  return pools.some(
    (p) =>
      (p.token0 === fromContract && p.token1 === toContract) ||
      (p.token0 === toContract && p.token1 === fromContract),
  );
}

export function routeSymbols(
  fromContract: string,
  toContract: string,
  config: ContractConfig,
): string[] {
  const from = symbolForContract(fromContract, config) ?? fromContract.slice(0, 6);
  const to = symbolForContract(toContract, config) ?? toContract.slice(0, 6);
  return [from, to];
}
