import type { xdr } from "@stellar/stellar-sdk";
import { getContractConfig } from "./contract-config.js";
import { displayPriceToPoolSqrt, poolSqrtToDisplayPrice } from "./clmm-math.js";
import { decimalsForContract } from "./token-decimals.js";
import { poolSqrtPrice, poolToken0, poolToken1, quotePoolSwapOutput } from "./swap-sim.js";

type StellarSdk = typeof import("@stellar/stellar-sdk");
type RpcServer = InstanceType<StellarSdk["rpc"]["Server"]>;
type ScVal = xdr.ScVal;

const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC = "https://soroban-testnet.stellar.org";

const STATUS_OPEN = 0;
const STATUS_FILLED = 1;
const STATUS_CANCELLED = 2;
const STATUS_EXPIRED = 3;

const ORDER_TYPE_LABELS = ["Limit", "Stop-Loss", "Take-Profit"] as const;

async function sdk() {
  return import("@stellar/stellar-sdk");
}

function server(sdk: StellarSdk): RpcServer {
  return new sdk.rpc.Server(RPC);
}

function scMapField(sdk: StellarSdk, val: ScVal, key: string): bigint {
  const entries = val.map() ?? [];
  for (const e of entries) {
    if (e.key().sym().toString() === key) {
      return sdk.scValToBigInt(e.val());
    }
  }
  return 0n;
}

function scMapU32(sdk: StellarSdk, val: ScVal, key: string): number {
  return Number(scMapField(sdk, val, key));
}

function scMapBool(val: ScVal, key: string): boolean {
  for (const e of val.map() ?? []) {
    if (e.key().sym().toString() === key) {
      return e.val().b() ?? false;
    }
  }
  return false;
}

function scMapAddressStr(sdk: StellarSdk, val: ScVal, key: string): string | null {
  for (const e of val.map() ?? []) {
    if (e.key().sym().toString() !== key) continue;
    const addr = e.val().address();
    switch (addr.switch().name) {
      case "scAddressTypeContract": {
        const hex = Buffer.from(addr.contractId()).toString("hex");
        return sdk.StrKey.encodeContract(Buffer.from(hex, "hex"));
      }
      case "scAddressTypeAccount": {
        const ed = addr.accountId().ed25519();
        if (!ed) return null;
        return sdk.StrKey.encodeEd25519PublicKey(ed);
      }
      default:
        return null;
    }
  }
  return null;
}

function symbolForContract(config: ReturnType<typeof getContractConfig>, contract: string): string {
  for (const [sym, addr] of Object.entries(config.tokens)) {
    if (addr === contract) return sym;
  }
  return contract.slice(0, 8);
}

async function simulateOrders(
  sdk: StellarSdk,
  srv: RpcServer,
  ordersAddress: string,
  method: string,
  args: ScVal[] = [],
): Promise<ScVal | null> {
  const source = await srv.getAccount(SIM_SOURCE);
  const c = new sdk.Contract(ordersAddress);
  const tx = new sdk.TransactionBuilder(source, {
    fee: "100000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(c.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await srv.simulateTransaction(tx);
  if (sdk.rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
  return sim.result.retval;
}

export type OnChainOrder = {
  id: string;
  owner: string;
  poolContract: string;
  fromSymbol: string;
  toSymbol: string;
  fromAmount: string;
  toAmountMin: string;
  limitPrice: number;
  currentPrice: number;
  orderType: string;
  status: "pending" | "filled" | "expired" | "cancelled";
  createdAt: string;
  expiryLedger: number;
  expiresInLedgers: number;
  fillPercent: number;
  zeroForOne: boolean;
};

export type OrderBookLevel = {
  price: number;
  amount: number;
  total: number;
  orderId: string;
  orderCount: number;
  cumulative: number;
};

export type RawOpenOrder = {
  id: bigint;
  pool: string;
  orderType: number;
  zeroForOne: boolean;
  triggerSqrt: bigint;
  expiryLedger: number;
  status: number;
};

function statusLabel(status: number): OnChainOrder["status"] {
  if (status === STATUS_OPEN) return "pending";
  if (status === STATUS_FILLED) return "filled";
  if (status === STATUS_CANCELLED) return "cancelled";
  return "expired";
}

export function orderShouldFill(
  orderType: number,
  zeroForOne: boolean,
  triggerSqrt: bigint,
  currentSqrt: bigint,
): boolean {
  switch (orderType) {
    case 0:
      if (zeroForOne) return currentSqrt >= triggerSqrt;
      return currentSqrt <= triggerSqrt;
    case 1:
      return zeroForOne && currentSqrt <= triggerSqrt;
    case 2:
      return zeroForOne && currentSqrt >= triggerSqrt;
    default:
      return false;
  }
}

export function orderIsExpired(expiryLedger: number, currentLedger: number): boolean {
  return expiryLedger > 0 && currentLedger > expiryLedger;
}

async function parseOrder(
  sdk: StellarSdk,
  srv: RpcServer,
  config: ReturnType<typeof getContractConfig>,
  id: bigint,
  val: ScVal,
  token0ByPool: Map<string, string>,
  token1ByPool: Map<string, string>,
  currentLedger: number,
): Promise<OnChainOrder | null> {
  if (val.switch().name === "scvVoid") return null;

  const owner = scMapAddressStr(sdk, val, "owner");
  const poolContract = scMapAddressStr(sdk, val, "pool");
  const tokenIn = scMapAddressStr(sdk, val, "token_in");
  if (!owner || !poolContract || !tokenIn) return null;
  const zeroForOne = scMapBool(val, "zero_for_one");
  const amountIn = scMapField(sdk, val, "amount_in");
  const minOut = scMapField(sdk, val, "min_amount_out");
  const triggerSqrt = scMapField(sdk, val, "trigger_sqrt_price");
  const orderType = scMapU32(sdk, val, "order_type");
  const expiryLedger = scMapU32(sdk, val, "expiry_ledger");
  const status = scMapU32(sdk, val, "status");
  const createdAt = Number(scMapField(sdk, val, "created_at"));

  const token0 = token0ByPool.get(poolContract) ?? "";
  const token1 = token1ByPool.get(poolContract) ?? "";
  const toContract = zeroForOne ? token1 : token0;

  const fromSymbol = symbolForContract(config, tokenIn);
  const toSymbol = symbolForContract(config, toContract);
  const fromDecimals = decimalsForContract(tokenIn, config);
  const toDecimals = decimalsForContract(toContract || tokenIn, config);
  const fromHuman = Number(amountIn) / 10 ** fromDecimals;
  const toHumanMin = Number(minOut) / 10 ** toDecimals;
  const limitPrice =
    fromHuman > 0
      ? toHumanMin / fromHuman
      : poolSqrtToDisplayPrice(triggerSqrt, tokenIn, token0);

  const currentPrice =
    toContract && poolContract
      ? await quotedDisplayPrice(sdk, srv, poolContract, tokenIn, toContract)
      : 0;

  let displayStatus = statusLabel(status);
  if (status === STATUS_OPEN && orderIsExpired(expiryLedger, currentLedger)) {
    displayStatus = "expired";
  }

  const dist =
    currentPrice > 0 ? Math.abs((limitPrice - currentPrice) / currentPrice) * 100 : 100;
  const fillPercent =
    displayStatus === "filled" ? 100 : Math.max(0, 100 - Math.min(dist, 100));

  return {
    id: id.toString(),
    owner,
    poolContract,
    fromSymbol,
    toSymbol,
    fromAmount: fromHuman.toString(),
    toAmountMin: toHumanMin.toString(),
    limitPrice,
    currentPrice,
    orderType: ORDER_TYPE_LABELS[orderType] ?? "Limit",
    status: displayStatus,
    createdAt: createdAt ? new Date(createdAt * 1000).toISOString().slice(0, 10) : "",
    expiryLedger,
    expiresInLedgers:
      expiryLedger > 0 && currentLedger <= expiryLedger ? expiryLedger - currentLedger : 0,
    fillPercent,
    zeroForOne,
  };
}

function aggregateLevels(levels: OrderBookLevel[]): OrderBookLevel[] {
  const byPrice = new Map<number, OrderBookLevel>();
  for (const level of levels) {
    const price = Math.round(level.price * 1e8) / 1e8;
    const prev = byPrice.get(price);
    if (prev) {
      prev.amount += level.amount;
      prev.total += level.total;
      prev.orderCount += 1;
      prev.orderId = `${prev.orderId},${level.orderId}`;
    } else {
      byPrice.set(price, { ...level, price, orderCount: 1, cumulative: 0 });
    }
  }
  return [...byPrice.values()];
}

function withCumulative(levels: OrderBookLevel[]): OrderBookLevel[] {
  let cumulative = 0;
  return levels.map((level) => {
    cumulative += level.amount;
    return { ...level, cumulative };
  });
}

async function loadPoolMeta(
  StellarSdk: StellarSdk,
  srv: RpcServer,
  pool: string,
  token0ByPool: Map<string, string>,
  token1ByPool: Map<string, string>,
): Promise<void> {
  if (token0ByPool.has(pool)) return;
  token0ByPool.set(pool, await poolToken0(StellarSdk, srv, pool));
  token1ByPool.set(pool, await poolToken1(StellarSdk, srv, pool));
}

async function quotedDisplayPrice(
  StellarSdk: StellarSdk,
  srv: RpcServer,
  pool: string,
  fromContract: string,
  toContract: string,
): Promise<number> {
  const fromDecimals = decimalsForContract(fromContract, getContractConfig());
  const toDecimals = decimalsForContract(toContract, getContractConfig());
  const oneUnit = 10n ** BigInt(fromDecimals);
  const quoted = await quotePoolSwapOutput(StellarSdk, srv, pool, fromContract, oneUnit);
  if (quoted <= 0n) return 0;
  return Number(quoted) / 10 ** toDecimals;
}

export async function listOpenOrderIds(ordersAddress: string): Promise<bigint[]> {
  const StellarSdk = await sdk();
  const srv = server(StellarSdk);
  const val = await simulateOrders(StellarSdk, srv, ordersAddress, "open_orders");
  if (!val?.vec()) return [];
  return (val.vec() ?? []).map((v) => StellarSdk.scValToBigInt(v));
}

export async function listRawOpenOrders(): Promise<RawOpenOrder[]> {
  const config = getContractConfig();
  if (!config.orders) return [];
  const StellarSdk = await sdk();
  const srv = server(StellarSdk);
  const ids = await listOpenOrderIds(config.orders);
  const rows: RawOpenOrder[] = [];

  for (const id of ids) {
    const val = await simulateOrders(
      StellarSdk,
      srv,
      config.orders,
      "get_order",
      [StellarSdk.nativeToScVal(id, { type: "u64" })],
    );
    if (!val) continue;
    const status = scMapU32(StellarSdk, val, "status");
    if (status !== STATUS_OPEN) continue;
    const pool = scMapAddressStr(StellarSdk, val, "pool");
    if (!pool) continue;
    rows.push({
      id,
      pool,
      orderType: scMapU32(StellarSdk, val, "order_type"),
      zeroForOne: scMapBool(val, "zero_for_one"),
      triggerSqrt: scMapField(StellarSdk, val, "trigger_sqrt_price"),
      expiryLedger: scMapU32(StellarSdk, val, "expiry_ledger"),
      status,
    });
  }
  return rows;
}

export async function readOrder(orderId: string): Promise<OnChainOrder | null> {
  const config = getContractConfig();
  if (!config.orders) return null;
  const StellarSdk = await sdk();
  const srv = server(StellarSdk);
  const val = await simulateOrders(
    StellarSdk,
    srv,
    config.orders,
    "get_order",
    [StellarSdk.nativeToScVal(BigInt(orderId), { type: "u64" })],
  );
  if (!val) return null;
  const pool = scMapAddressStr(StellarSdk, val, "pool");
  const token0ByPool = new Map<string, string>();
  const token1ByPool = new Map<string, string>();
  if (pool) await loadPoolMeta(StellarSdk, srv, pool, token0ByPool, token1ByPool);
  const { sequence } = await srv.getLatestLedger();
  return parseOrder(
    StellarSdk,
    srv,
    config,
    BigInt(orderId),
    val,
    token0ByPool,
    token1ByPool,
    sequence,
  );
}

export async function listWalletOrders(walletAddress: string): Promise<OnChainOrder[]> {
  const config = getContractConfig();
  if (!config.orders) return [];
  const StellarSdk = await sdk();
  const srv = server(StellarSdk);
  const { sequence } = await srv.getLatestLedger();
  const ids = await listOpenOrderIds(config.orders);
  const token0ByPool = new Map<string, string>();
  const token1ByPool = new Map<string, string>();
  const rows: OnChainOrder[] = [];

  for (const id of ids) {
    const val = await simulateOrders(
      StellarSdk,
      srv,
      config.orders,
      "get_order",
      [StellarSdk.nativeToScVal(id, { type: "u64" })],
    );
    if (!val) continue;
    const pool = scMapAddressStr(StellarSdk, val, "pool");
    if (pool) await loadPoolMeta(StellarSdk, srv, pool, token0ByPool, token1ByPool);
    const row = await parseOrder(
      StellarSdk,
      srv,
      config,
      id,
      val,
      token0ByPool,
      token1ByPool,
      sequence,
    );
    if (!row) continue;
    if (row.owner !== walletAddress) continue;
    if (row.status === "filled" || row.status === "cancelled") continue;
    rows.push(row);
  }
  return rows;
}

export async function buildOrderBook(
  poolContract: string,
  fromSymbol: string,
  _toSymbol: string,
): Promise<{
  sells: OrderBookLevel[];
  buys: OrderBookLevel[];
  spread: number;
  currentPrice: number;
  sellDepth: number;
  buyDepth: number;
}> {
  const config = getContractConfig();
  if (!config.orders) {
    return { sells: [], buys: [], spread: 0, currentPrice: 0, sellDepth: 0, buyDepth: 0 };
  }

  const StellarSdk = await sdk();
  const srv = server(StellarSdk);
  const { sequence } = await srv.getLatestLedger();
  const token0 = await poolToken0(StellarSdk, srv, poolContract);
  const token1 = await poolToken1(StellarSdk, srv, poolContract);
  const token0ByPool = new Map([[poolContract, token0]]);
  const token1ByPool = new Map([[poolContract, token1]]);

  const ids = await listOpenOrderIds(config.orders);
  const sells: OrderBookLevel[] = [];
  const buys: OrderBookLevel[] = [];

  for (const id of ids) {
    const val = await simulateOrders(
      StellarSdk,
      srv,
      config.orders,
      "get_order",
      [StellarSdk.nativeToScVal(id, { type: "u64" })],
    );
    if (!val) continue;
    const row = await parseOrder(
      StellarSdk,
      srv,
      config,
      id,
      val,
      token0ByPool,
      token1ByPool,
      sequence,
    );
    if (!row || row.status !== "pending" || row.poolContract !== poolContract) continue;

    const amount = parseFloat(row.fromAmount);
    const level: OrderBookLevel = {
      price: row.limitPrice,
      amount,
      total: amount * row.limitPrice,
      orderId: row.id,
      orderCount: 1,
      cumulative: 0,
    };

    if (row.zeroForOne) {
      sells.push(level);
    } else {
      buys.push(level);
    }
  }

  const sellsAgg = withCumulative(aggregateLevels(sells).sort((a, b) => a.price - b.price));
  const buysAgg = withCumulative(aggregateLevels(buys).sort((a, b) => b.price - a.price));

  const bestAsk = sellsAgg.length ? sellsAgg[0]!.price : 0;
  const bestBid = buysAgg.length ? buysAgg[0]!.price : 0;
  const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;

  const fromContract = config.tokens[fromSymbol] ?? token0;
  const toContract = config.tokens[_toSymbol] ?? token1;
  const currentPrice = await quotedDisplayPrice(StellarSdk, srv, poolContract, fromContract, toContract);
  const sellDepth = sellsAgg.reduce((sum, level) => sum + level.amount, 0);
  const buyDepth = buysAgg.reduce((sum, level) => sum + level.amount, 0);

  return { sells: sellsAgg, buys: buysAgg, spread, currentPrice, sellDepth, buyDepth };
}

export function orderTypeToCode(type: string): number {
  if (type === "Stop-Loss" || type === "StopLoss") return 1;
  if (type === "Take-Profit" || type === "TakeProfit") return 2;
  return 0;
}

export function expiryLedgerFromHours(hours: number, latestLedger: number): number {
  if (hours <= 0) return 0;
  const ledgersPerHour = 300;
  return latestLedger + hours * ledgersPerHour;
}

export { displayPriceToPoolSqrt };
