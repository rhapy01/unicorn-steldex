/**
 * Set weekly STELLAR reward rates for every pool in POOLS_JSON on the current farm.
 * Usage: npx tsx scripts/src/configure-farm-pools.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  rpc,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSPHRASE = Networks.TESTNET;
const RPC = "https://soroban-testnet.stellar.org";
/** 10,000 STELLAR/week (7 decimals) — matches redeploy-farm main pool */
const WEEKLY_STELLAR = 100_000_000_000n;

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function send(server: rpc.Server, kp: Keypair, build: (acc: rpc.Api.GetAccountResponse) => TransactionBuilder) {
  const account = await server.getAccount(kp.publicKey());
  const prepared = await server.prepareTransaction(build(account).setTimeout(300).build());
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || !sent.hash) {
    throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return sent.hash;
    if (r.status === "FAILED") throw new Error(`failed: ${sent.hash}`);
  }
  throw new Error("timeout");
}

async function main() {
  const env = { ...loadEnv(path.join(root, ".env.contracts")), ...loadEnv(path.join(root, ".env")) };
  const secret = env.DEPLOYER_SECRET_KEY;
  if (!secret) throw new Error("DEPLOYER_SECRET_KEY missing in .env");

  const farmId = env.FARM_CONTRACT;
  if (!farmId) throw new Error("FARM_CONTRACT missing in .env.contracts");

  const poolsJson = env.POOLS_JSON;
  if (!poolsJson) throw new Error("POOLS_JSON missing in .env.contracts");
  const pools = Object.entries(JSON.parse(poolsJson) as Record<string, string>);

  const kp = Keypair.fromSecret(secret);
  const server = new rpc.Server(RPC);

  console.log("Farm:", farmId);
  console.log(`Setting ${WEEKLY_STELLAR} weekly STELLAR per pool (${pools.length} pools)\n`);

  for (const [pair, poolId] of pools) {
    const hash = await send(server, kp, (account) =>
      new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
        .addOperation(
          new Contract(farmId).call(
            "set_reward_rate",
            new Address(poolId).toScVal(),
            nativeToScVal(WEEKLY_STELLAR, { type: "u128" }),
          ),
        ),
    );
    console.log(`  ✓ ${pair}: ${hash.slice(0, 16)}…`);
  }

  console.log("\nDone — all pools configured.");
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
