import { getContractConfig } from "./contract-config.js";
import { buildOnChainCatalog, type CatalogPool } from "./market-catalog.js";
import { listFactoryPools } from "./pool-registry.js";
import { simulateContractBalance } from "./soroban-balance.js";
import { decimalsForSymbol } from "./token-decimals.js";

type StellarSdk = typeof import("@stellar/stellar-sdk");
type RpcServer = InstanceType<StellarSdk["rpc"]["Server"]>;

const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const CACHE_MS = 30_000;

let poolsCache: { at: number; pools: CatalogPool[] } | null = null;

async function stellar() {
  return import("@stellar/stellar-sdk");
}

async function readPoolLiquidity(
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
    .addOperation(pool.call("liquidity"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) return 0n;
  return sim.result?.retval ? StellarSdk.scValToBigInt(sim.result.retval) : 0n;
}

async function readPoolFeeBps(
  StellarSdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
): Promise<number> {
  const source = await server.getAccount(SIM_SOURCE);
  const pool = new StellarSdk.Contract(poolAddress);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(pool.call("fee_bps"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) return 30;
  const val = sim.result?.retval;
  return val ? Number(StellarSdk.scValToBigInt(val)) : 30;
}

function toHuman(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Estimate 24h swap volume for a pool by counting Soroban invoke_host_function
 * operations on the pool contract address in the last 24 hours via Horizon.
 * We use the contract's event/transaction count as a proxy since Horizon doesn't
 * expose Soroban internal token flows directly.
 */
async function estimatePoolVolume24h(
  poolAddress: string,
  totalLiquidity: number,
  feeBps: number,
): Promise<{ volume24h: number; fees24h: number; apy: number }> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const url = `${HORIZON_URL}/accounts/${poolAddress}/transactions?limit=200&order=desc`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { volume24h: 0, fees24h: 0, apy: 0 };
    const data = await res.json() as {
      _embedded?: { records?: Array<{ created_at: string; operation_count: number }> }
    };
    const records = data._embedded?.records ?? [];
    // Count transactions in last 24h (each op_count > 1 likely a Soroban multi-step)
    const recent = records.filter((r) => new Date(r.created_at) >= new Date(since));
    const opCount = recent.reduce((s, r) => s + (r.operation_count ?? 1), 0);

    if (opCount === 0 || totalLiquidity === 0) return { volume24h: 0, fees24h: 0, apy: 0 };

    // Rough estimate: each swap op moves ~5% of pool TVL on average
    const volume24h = opCount * totalLiquidity * 0.05;
    const feeRate = feeBps / 10_000;
    const fees24h = volume24h * feeRate;
    // APY = annualized fee yield on TVL
    const apy = totalLiquidity > 0 ? (fees24h * 365) / totalLiquidity : 0;
    return { volume24h, fees24h, apy };
  } catch {
    return { volume24h: 0, fees24h: 0, apy: 0 };
  }
}

/** All deployed pools with live Soroban reserves and liquidity. */
export async function listOnChainPools(): Promise<CatalogPool[]> {
  const now = Date.now();
  if (poolsCache && now - poolsCache.at < CACHE_MS) {
    return poolsCache.pools;
  }

  const config = getContractConfig();
  const catalog = buildOnChainCatalog();
  const tokenBySymbol = Object.fromEntries(catalog.tokens.map((t) => [t.symbol, t]));

  const StellarSdk = await stellar();
  const server = new StellarSdk.rpc.Server(RPC);
  const onChain = await listFactoryPools(StellarSdk, server, config);

  const pools: CatalogPool[] = [];
  let id = 1;

  for (const p of onChain) {
    if (!p.symbol0 || !p.symbol1) continue;
    const [symA, symB] = [p.symbol0, p.symbol1].sort();
    const tokenA = tokenBySymbol[symA];
    const tokenB = tokenBySymbol[symB];
    if (!tokenA || !tokenB) continue;

    const [bal0, bal1, liquidity, feeBps] = await Promise.all([
      simulateContractBalance(StellarSdk, server, p.token0, p.address),
      simulateContractBalance(StellarSdk, server, p.token1, p.address),
      readPoolLiquidity(StellarSdk, server, p.address),
      readPoolFeeBps(StellarSdk, server, p.address),
    ]);

    const reserve0 = toHuman(bal0, decimalsForSymbol(p.symbol0));
    const reserve1 = toHuman(bal1, decimalsForSymbol(p.symbol1));
    const reserveA = symA === p.symbol0 ? reserve0 : reserve1;
    const reserveB = symB === p.symbol0 ? reserve0 : reserve1;

    const totalLiquidity = reserveA * tokenA.price + reserveB * tokenB.price;
    const liqNum = Number(liquidity);
    const lpTokenSupply = Number.isFinite(liqNum) ? liqNum : 0;

    const { volume24h, fees24h, apy } = await estimatePoolVolume24h(p.address, totalLiquidity, feeBps);

    pools.push({
      id: id++,
      tokenAId: tokenA.id,
      tokenBId: tokenB.id,
      tokenA,
      tokenB,
      reserveA,
      reserveB,
      totalLiquidity,
      volume24h,
      fees24h,
      apy,
      fee: feeBps / 10_000,
      lpTokenSupply,
      createdAt: new Date().toISOString(),
      poolContract: p.address,
      pair: p.pair,
    });
  }

  poolsCache = { at: now, pools };
  return pools;
}
