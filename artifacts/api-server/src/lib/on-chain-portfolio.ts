import type { xdr } from "@stellar/stellar-sdk";
import { buildOnChainCatalog, type CatalogPool, type CatalogToken } from "./market-catalog.js";
import { listOnChainPools } from "./on-chain-pools.js";
import { fullRangeTicks } from "./pool-ticks.js";
import { decimalsForSymbol } from "./token-decimals.js";
import { resolveWalletBalances } from "./wallet-balances.js";

type StellarSdk = typeof import("@stellar/stellar-sdk");
type RpcServer = InstanceType<StellarSdk["rpc"]["Server"]>;

const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

export type RecentTransaction = {
  id: number;
  type: "swap" | "add_liquidity" | "remove_liquidity";
  walletAddress: string;
  tokenASymbol: string;
  tokenBSymbol: string;
  amountA: number;
  amountB: number;
  txHash: string;
  timestamp: string;
  status: "pending" | "confirmed" | "failed";
  valueUsd: number | null;
};

export type PortfolioPayload = {
  walletAddress: string;
  totalValueUsd: number;
  tokenBalances: Array<{ token: CatalogToken; balance: number; valueUsd: number }>;
  lpPositions: Array<{
    pool: CatalogPool;
    lpTokenBalance: number;
    sharePercent: number;
    valueUsd: number;
    feesEarned: number;
  }>;
  recentTransactions: RecentTransaction[];
};

async function stellar() {
  return import("@stellar/stellar-sdk");
}

/** Fetch recent Stellar Horizon transactions for the wallet (swaps, liquidity ops). */
async function fetchHorizonTransactions(walletAddress: string): Promise<RecentTransaction[]> {
  try {
    const url = `${HORIZON_URL}/accounts/${walletAddress}/operations?limit=30&order=desc&include_failed=false`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json() as {
      _embedded?: { records?: Array<{
        type: string;
        type_i: number;
        id: string;
        transaction_hash: string;
        created_at: string;
        from?: string;
        to?: string;
        asset_code?: string;
        asset_type?: string;
        amount?: string;
        source_amount?: string;
        source_asset_code?: string;
        destination_asset_code?: string;
      }> }
    };
    const records = data._embedded?.records ?? [];

    const txs: RecentTransaction[] = [];
    let idCounter = 1;

    for (const op of records) {
      // path payments = swaps
      if (op.type === "path_payment_strict_send" || op.type === "path_payment_strict_receive") {
        const fromSymbol = op.source_asset_code ?? (op.type === "path_payment_strict_send" ? "XLM" : "XLM");
        const toSymbol = op.asset_code ?? op.destination_asset_code ?? "XLM";
        txs.push({
          id: idCounter++,
          type: "swap",
          walletAddress,
          tokenASymbol: fromSymbol,
          tokenBSymbol: toSymbol,
          amountA: parseFloat(op.source_amount ?? "0"),
          amountB: parseFloat(op.amount ?? "0"),
          txHash: op.transaction_hash,
          timestamp: op.created_at,
          status: "confirmed",
          valueUsd: null,
        });
      }
      // manage_offer / create_passive_offer = AMM liquidity changes (Stellar classic DEX)
      // invoke_host_function = Soroban contract calls (swaps, add/remove liquidity)
      else if (op.type === "invoke_host_function") {
        // Soroban ops don't expose token details in Horizon ops, so show as generic
        txs.push({
          id: idCounter++,
          type: "swap",
          walletAddress,
          tokenASymbol: "—",
          tokenBSymbol: "—",
          amountA: 0,
          amountB: 0,
          txHash: op.transaction_hash,
          timestamp: op.created_at,
          status: "confirmed",
          valueUsd: null,
        });
      }
      if (txs.length >= 20) break;
    }
    return txs;
  } catch {
    return [];
  }
}

function scMapField(
  sdk: StellarSdk,
  val: xdr.ScVal,
  key: string,
): bigint {
  const entries = val.map() ?? [];
  for (const e of entries) {
    if (e.key().sym().toString() === key) {
      return sdk.scValToBigInt(e.val());
    }
  }
  return 0n;
}

async function readPoolPosition(
  sdk: StellarSdk,
  server: RpcServer,
  poolAddress: string,
  owner: string,
  tickLower: number,
  tickUpper: number,
): Promise<{ liquidity: bigint; owed0: bigint; owed1: bigint }> {
  const source = await server.getAccount(SIM_SOURCE);
  const pool = new sdk.Contract(poolAddress);
  const tx = new sdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      pool.call(
        "get_position",
        new sdk.Address(owner).toScVal(),
        sdk.nativeToScVal(tickLower, { type: "i32" }),
        sdk.nativeToScVal(tickUpper, { type: "i32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sdk.rpc.Api.isSimulationError(sim) || !sim.result?.retval) {
    return { liquidity: 0n, owed0: 0n, owed1: 0n };
  }

  const val = sim.result.retval;
  if (val.switch().name === "scvMap") {
    return {
      liquidity: scMapField(sdk, val, "liquidity"),
      owed0: scMapField(sdk, val, "tokens_owed_0"),
      owed1: scMapField(sdk, val, "tokens_owed_1"),
    };
  }

  const vec = val.vec() ?? [];
  if (vec.length >= 5) {
    return {
      liquidity: sdk.scValToBigInt(vec[0]),
      owed0: sdk.scValToBigInt(vec[3]),
      owed1: sdk.scValToBigInt(vec[4]),
    };
  }

  return { liquidity: 0n, owed0: 0n, owed1: 0n };
}

export async function getOnChainPortfolio(walletAddress: string): Promise<PortfolioPayload> {
  const StellarSdk = await stellar();
  const server = new StellarSdk.rpc.Server(RPC);
  const catalog = buildOnChainCatalog();
  const [balances, pools, recentTransactions] = await Promise.all([
    resolveWalletBalances(walletAddress),
    listOnChainPools(),
    fetchHorizonTransactions(walletAddress),
  ]);
  const { tickLower, tickUpper } = fullRangeTicks();

  const tokenBalances = catalog.tokens
    .map((token) => {
      const balance = balances[token.symbol] ?? 0;
      const valueUsd = balance * token.price;
      return { token, balance, valueUsd };
    })
    .filter((tb) => tb.balance > 0);

  const lpResults = await Promise.all(
    pools.map(async (catalogPool) => {
      if (!catalogPool.poolContract || !catalogPool.pair) return null;
      const pos = await readPoolPosition(
        StellarSdk,
        server,
        catalogPool.poolContract,
        walletAddress,
        tickLower,
        tickUpper,
      );
      if (pos.liquidity === 0n) return null;

      const poolLiq = catalogPool.lpTokenSupply;
      const sharePercent = poolLiq > 0 ? Number(pos.liquidity) / poolLiq : 0;
      const valueUsd = catalogPool.totalLiquidity * sharePercent;

      const [sym0, sym1] = catalogPool.pair.split("/");
      if (!sym0 || !sym1) return null;
      const owed0Human = Number(pos.owed0) / 10 ** decimalsForSymbol(sym0);
      const owed1Human = Number(pos.owed1) / 10 ** decimalsForSymbol(sym1);
      const token0 = catalog.tokens.find((t) => t.symbol === sym0);
      const token1 = catalog.tokens.find((t) => t.symbol === sym1);
      const feesEarned =
        owed0Human * (token0?.price ?? 0) + owed1Human * (token1?.price ?? 0);

      return {
        pool: catalogPool,
        lpTokenBalance: Number(pos.liquidity),
        sharePercent,
        valueUsd,
        feesEarned,
      };
    }),
  );
  const lpPositions = lpResults.filter((p): p is NonNullable<typeof p> => p !== null);

  const totalValueUsd =
    tokenBalances.reduce((s, t) => s + t.valueUsd, 0) +
    lpPositions.reduce((s, p) => s + p.valueUsd, 0);

  return {
    walletAddress,
    totalValueUsd,
    tokenBalances,
    lpPositions,
    recentTransactions,
  };
}
