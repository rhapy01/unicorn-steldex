import type { ContractConfig } from "./contract-config.js";
import { feeTierScVal } from "./soroban-scval.js";
import { symbolForContract } from "./swap-route.js";

type StellarSdk = typeof import("@stellar/stellar-sdk");
type RpcServer = InstanceType<StellarSdk["rpc"]["Server"]>;

const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export type OnChainPool = {
  address: string;
  token0: string;
  token1: string;
  symbol0: string | null;
  symbol1: string | null;
  pair: string;
};

let cache: { at: number; pools: OnChainPool[] } | null = null;
const CACHE_MS = 30_000;

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("/");
}

async function simulateContract(
  StellarSdk: StellarSdk,
  server: RpcServer,
  contractId: string,
  fn: string,
  ...args: StellarSdk["xdr"]["ScVal"][]
): Promise<unknown> {
  const contract = new StellarSdk.Contract(contractId);
  const source = await server.getAccount(SIM_SOURCE);
  const tx = new StellarSdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    throw new Error(typeof sim.error === "string" ? sim.error : JSON.stringify(sim));
  }
  return sim.result?.retval;
}

function scAddressToStr(StellarSdk: StellarSdk, val: unknown): string {
  const sc = val as StellarSdk["xdr"]["ScVal"];
  const addr = sc.address();
  const hex = Buffer.from(addr.contractId()).toString("hex");
  return StellarSdk.StrKey.encodeContract(Buffer.from(hex, "hex"));
}

function poolsFromEnv(config: ContractConfig): OnChainPool[] {
  const raw = process.env.POOLS_JSON || "";
  if (!raw) return [];
  let map: Record<string, string>;
  try {
    map = JSON.parse(raw) as Record<string, string>;
  } catch {
    return [];
  }
  const pools: OnChainPool[] = [];
  for (const [pair, address] of Object.entries(map)) {
    const parts = pair.split("/");
    if (parts.length !== 2) continue;
    const [symA, symB] = parts;
    const cA = config.tokens[symA];
    const cB = config.tokens[symB];
    if (!cA || !cB || !address) continue;
    const [token0, token1, symbol0, symbol1] =
      cA < cB ? [cA, cB, symA, symB] : [cB, cA, symB, symA];
    pools.push({ address, token0, token1, symbol0, symbol1, pair: pairKey(symbol0, symbol1) });
  }
  return pools;
}

export async function listFactoryPools(
  StellarSdk: StellarSdk,
  server: RpcServer,
  config: ContractConfig,
): Promise<OnChainPool[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.pools;

  const pools: OnChainPool[] = [...poolsFromEnv(config)];
  const seen = new Set(pools.map((p) => p.address));

  if (config.factory) {
  const retval = await simulateContract(StellarSdk, server, config.factory, "all_pools");

  if (retval && (retval as StellarSdk["xdr"]["ScVal"]).switch().name === "scvVec") {
    const vec = (retval as StellarSdk["xdr"]["ScVal"]).vec() ?? [];
    for (const entry of vec) {
      const map = entry.map() ?? [];
      let address = "";
      let token0 = "";
      let token1 = "";
      for (const field of map) {
        const key = field.key().sym().toString();
        const val = field.val();
        if (key === "address") address = scAddressToStr(StellarSdk, val);
        if (key === "token_a") token0 = scAddressToStr(StellarSdk, val);
        if (key === "token_b") token1 = scAddressToStr(StellarSdk, val);
      }
      if (!address || !token0 || !token1 || seen.has(address)) continue;
      const symbol0 = symbolForContract(token0, config);
      const symbol1 = symbolForContract(token1, config);
      pools.push({
        address,
        token0,
        token1,
        symbol0,
        symbol1,
        pair: symbol0 && symbol1 ? pairKey(symbol0, symbol1) : pairKey(token0, token1),
      });
      seen.add(address);
    }
  }
  }

  if (!pools.some((p) => p.pair === "pUSDC/XLM" || p.pair === "XLM/pUSDC") && config.pool) {
    const xlm = config.tokens.XLM;
    const pUsdc = config.poolUsdc || config.tokens.pUSDC;
    if (xlm && pUsdc) {
      pools.push({
        address: config.pool,
        token0: pUsdc < xlm ? pUsdc : xlm,
        token1: pUsdc < xlm ? xlm : pUsdc,
        symbol0: pUsdc < xlm ? "pUSDC" : "XLM",
        symbol1: pUsdc < xlm ? "XLM" : "pUSDC",
        pair: "pUSDC/XLM",
      });
    }
  }

  cache = { at: now, pools };
  return pools;
}

export async function resolvePoolForTokens(
  StellarSdk: StellarSdk,
  server: RpcServer,
  config: ContractConfig,
  tokenA: string,
  tokenB: string,
): Promise<OnChainPool | null> {
  const pools = await listFactoryPools(StellarSdk, server, config);
  const hit = pools.find(
    (p) =>
      (p.token0 === tokenA && p.token1 === tokenB) ||
      (p.token0 === tokenB && p.token1 === tokenA),
  );
  if (hit) return hit;

  const retval = await simulateContract(
    StellarSdk,
    server,
    config.factory,
    "get_pool",
    new StellarSdk.Address(tokenA).toScVal(),
    new StellarSdk.Address(tokenB).toScVal(),
    feeTierScVal(StellarSdk, "Medium"),
  );
  if (!retval || (retval as StellarSdk["xdr"]["ScVal"]).switch().name === "scvVoid") return null;
  const address = scAddressToStr(StellarSdk, retval);
  const [token0, token1] = tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
  return {
    address,
    token0,
    token1,
    symbol0: symbolForContract(token0, config),
    symbol1: symbolForContract(token1, config),
    pair:
      symbolForContract(token0, config) && symbolForContract(token1, config)
        ? pairKey(symbolForContract(token0, config)!, symbolForContract(token1, config)!)
        : pairKey(token0, token1),
  };
}

export function invalidatePoolCache(): void {
  cache = null;
}
