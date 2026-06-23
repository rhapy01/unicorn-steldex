import { getContractConfig } from "./contract-config.js";
import { logger } from "./logger.js";
import {
  listRawOpenOrders,
  orderIsExpired,
  orderShouldFill,
} from "./on-chain-orders.js";
import { poolSqrtPrice } from "./swap-sim.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const RPC = "https://soroban-testnet.stellar.org";
const DEFAULT_INTERVAL_MS = 30_000;

type KeeperResult = { filled: number; expired: number; skipped: number; errors: number };

let keeperTimer: ReturnType<typeof setInterval> | null = null;
let keeperRunning = false;

async function submitFillOrder(orderId: bigint, secret: string): Promise<boolean> {
  const StellarSdk = await import("@stellar/stellar-sdk");
  const config = getContractConfig();
  if (!config.orders) return false;

  const kp = StellarSdk.Keypair.fromSecret(secret);
  const server = new StellarSdk.rpc.Server(RPC);
  const account = await server.getAccount(kp.publicKey());
  const orders = new StellarSdk.Contract(config.orders);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(
      orders.call(
        "fill_order",
        StellarSdk.nativeToScVal(orderId, { type: "u64" }),
      ),
    )
    .setTimeout(300)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const sim = await server.simulateTransaction(prepared);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) {
    return false;
  }

  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || !sent.hash) {
    throw new Error(`fill_order send failed: ${JSON.stringify(sent.errorResult)}`);
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return true;
    if (result.status === "FAILED") return false;
  }
  return false;
}

export async function runOrderKeeperOnce(): Promise<KeeperResult> {
  const secret = process.env.KEEPER_SECRET_KEY ?? process.env.DEPLOYER_SECRET_KEY;
  const result: KeeperResult = { filled: 0, expired: 0, skipped: 0, errors: 0 };

  if (!secret) return result;

  const config = getContractConfig();
  if (!config.orders) return result;

  const StellarSdk = await import("@stellar/stellar-sdk");
  const server = new StellarSdk.rpc.Server(RPC);
  const { sequence: currentLedger } = await server.getLatestLedger();
  const orders = await listRawOpenOrders();
  const sqrtByPool = new Map<string, bigint>();

  for (const order of orders) {
    try {
      const expired = orderIsExpired(order.expiryLedger, currentLedger);
      if (!sqrtByPool.has(order.pool)) {
        sqrtByPool.set(order.pool, await poolSqrtPrice(StellarSdk, server, order.pool));
      }
      const currentSqrt = sqrtByPool.get(order.pool) ?? 0n;
      const shouldFill = orderShouldFill(
        order.orderType,
        order.zeroForOne,
        order.triggerSqrt,
        currentSqrt,
      );

      if (!expired && !shouldFill) {
        result.skipped += 1;
        continue;
      }

      const ok = await submitFillOrder(order.id, secret);
      if (ok) {
        if (expired) result.expired += 1;
        else result.filled += 1;
        logger.info({ orderId: order.id.toString(), expired, shouldFill }, "order keeper processed");
      } else {
        result.skipped += 1;
      }
    } catch (err) {
      result.errors += 1;
      logger.warn({ err, orderId: order.id.toString() }, "order keeper failed");
    }
  }

  return result;
}

export function startOrderKeeper(): void {
  if (keeperTimer) return;
  const secret = process.env.KEEPER_SECRET_KEY ?? process.env.DEPLOYER_SECRET_KEY;
  if (!secret) {
    logger.info("order keeper disabled (set KEEPER_SECRET_KEY or DEPLOYER_SECRET_KEY)");
    return;
  }

  const intervalMs = Number(process.env.ORDER_KEEPER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  logger.info({ intervalMs }, "order keeper started");

  const tick = async () => {
    if (keeperRunning) return;
    keeperRunning = true;
    try {
      const result = await runOrderKeeperOnce();
      if (result.filled || result.expired || result.errors) {
        logger.info(result, "order keeper tick");
      }
    } catch (err) {
      logger.error({ err }, "order keeper tick failed");
    } finally {
      keeperRunning = false;
    }
  };

  void tick();
  keeperTimer = setInterval(() => void tick(), intervalMs);
}

export function stopOrderKeeper(): void {
  if (keeperTimer) {
    clearInterval(keeperTimer);
    keeperTimer = null;
  }
}
