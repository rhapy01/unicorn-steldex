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

export type SwapHop = {
  pool: OnChainPool;
  tokenIn: string;
  tokenOut: string;
};

export type SwapRoute = {
  hops: SwapHop[];
  /** Token contracts along the path, length = hops + 1 */
  path: string[];
};

function poolConnects(pool: OnChainPool, a: string, b: string): boolean {
  return (
    (pool.token0 === a && pool.token1 === b) ||
    (pool.token0 === b && pool.token1 === a)
  );
}

function otherToken(pool: OnChainPool, token: string): string | null {
  if (pool.token0 === token) return pool.token1;
  if (pool.token1 === token) return pool.token0;
  return null;
}

/** Direct pool if one exists. */
export function findDirectPool(
  fromContract: string,
  toContract: string,
  pools: OnChainPool[],
): OnChainPool | null {
  return (
    pools.find((p) => poolConnects(p, fromContract, toContract)) ?? null
  );
}

/**
 * Shortest path through factory pools (BFS, max 3 hops).
 * Prefers a direct pool when available.
 */
export function findSwapRoute(
  fromContract: string,
  toContract: string,
  pools: OnChainPool[],
): SwapRoute | null {
  if (fromContract === toContract) return null;

  const direct = findDirectPool(fromContract, toContract, pools);
  if (direct) {
    return {
      hops: [{ pool: direct, tokenIn: fromContract, tokenOut: toContract }],
      path: [fromContract, toContract],
    };
  }

  // adjacency: token -> [{ pool, next }]
  const adj = new Map<string, Array<{ pool: OnChainPool; next: string }>>();
  for (const pool of pools) {
    const a = pool.token0;
    const b = pool.token1;
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ pool, next: b });
    adj.get(b)!.push({ pool, next: a });
  }

  type Node = { token: string; hops: SwapHop[] };
  const queue: Node[] = [{ token: fromContract, hops: [] }];
  const visited = new Set<string>([fromContract]);
  const maxHops = 3;

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.hops.length >= maxHops) continue;
    const edges = adj.get(cur.token) ?? [];
    for (const { pool, next } of edges) {
      if (visited.has(next)) continue;
      const hop: SwapHop = { pool, tokenIn: cur.token, tokenOut: next };
      const hops = [...cur.hops, hop];
      if (next === toContract) {
        return {
          hops,
          path: [fromContract, ...hops.map((h) => h.tokenOut)],
        };
      }
      visited.add(next);
      queue.push({ token: next, hops });
    }
  }

  return null;
}

export function isRoutableSwap(
  fromContract: string,
  toContract: string,
  pools: OnChainPool[],
): boolean {
  return findSwapRoute(fromContract, toContract, pools) !== null;
}

export function routeSymbols(
  pathOrFrom: string | string[],
  toOrConfig?: string | ContractConfig,
  configMaybe?: ContractConfig,
): string[] {
  // New: routeSymbols(path, config)
  if (Array.isArray(pathOrFrom)) {
    const config = toOrConfig as ContractConfig;
    return pathOrFrom.map(
      (c) => symbolForContract(c, config) ?? c.slice(0, 6),
    );
  }
  // Legacy: routeSymbols(from, to, config)
  const fromContract = pathOrFrom;
  const toContract = toOrConfig as string;
  const config = configMaybe!;
  const from = symbolForContract(fromContract, config) ?? fromContract.slice(0, 6);
  const to = symbolForContract(toContract, config) ?? toContract.slice(0, 6);
  return [from, to];
}

/** Prefer hubs for display / debugging. */
export function otherTokenOnPool(pool: OnChainPool, token: string): string | null {
  return otherToken(pool, token);
}
