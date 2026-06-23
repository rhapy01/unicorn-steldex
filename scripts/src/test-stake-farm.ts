/**
 * Stake deployer LP in the farm (1-year lock).
 * Scans all pools for an LP position, stakes unstaked liquidity.
 * Usage: npx tsx scripts/src/test-stake-farm.ts
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
  scValToBigInt,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  authorizeEntry,
  hash,
} from "@stellar/stellar-sdk";
import { fullRangeTicks } from "../../artifacts/api-server/src/lib/pool-ticks.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSPHRASE = Networks.TESTNET;
const RPC = "https://soroban-testnet.stellar.org";
const SIM_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const LOCK_WEEKS = 52; // 1 year

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function scMapField(val: xdr.ScVal, key: string): bigint {
  const entries = val.map() ?? [];
  for (const e of entries) {
    if (e.key().sym().toString() === key) {
      return scValToBigInt(e.val());
    }
  }
  return 0n;
}

async function simulate(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<xdr.ScVal | null> {
  const account = await server.getAccount(SIM_SOURCE);
  const c = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(c.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
  return sim.result.retval;
}

async function readPoolPositionLiquidity(
  server: rpc.Server,
  poolId: string,
  owner: string,
  tickLower: number,
  tickUpper: number,
): Promise<bigint> {
  const val = await simulate(server, poolId, "get_position", [
    new Address(owner).toScVal(),
    nativeToScVal(tickLower, { type: "i32" }),
    nativeToScVal(tickUpper, { type: "i32" }),
  ]);
  if (!val) return 0n;
  if (val.switch().name === "scvMap") return scMapField(val, "liquidity");
  const vec = val.vec() ?? [];
  if (vec.length >= 1) return scValToBigInt(vec[0]);
  return 0n;
}

async function readFarmStakeLiquidity(
  server: rpc.Server,
  farmId: string,
  owner: string,
  poolId: string,
  tickLower: number,
  tickUpper: number,
): Promise<bigint> {
  const val = await simulate(server, farmId, "get_stake", [
    new Address(owner).toScVal(),
    new Address(poolId).toScVal(),
    nativeToScVal(tickLower, { type: "i32" }),
    nativeToScVal(tickUpper, { type: "i32" }),
  ]);
  if (!val || val.switch().name === "scvVoid") return 0n;
  if (val.switch().name === "scvMap") return scMapField(val, "liquidity");
  return 0n;
}

async function submit(server: rpc.Server, kp: Keypair, tx: TransactionBuilder): Promise<string> {
  const built = tx.setTimeout(300).build();
  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`simulate failed: ${sim.error}`);
  }

  const signedAuth = await Promise.all(
    (sim.result?.auth ?? []).map((entry) =>
      authorizeEntry(
        entry,
        kp.publicKey(),
        async (preimage) => kp.sign(hash(preimage)),
        sim.latestLedger,
        PASSPHRASE,
      ),
    ),
  );

  const assembled = rpc.assembleTransaction(built, sim).build();
  const op = assembled.operations[0];
  if (op.type === "invokeHostFunction") {
    op.auth = signedAuth;
  }
  assembled.sign(kp);

  const sent = await server.sendTransaction(assembled);
  console.log("  send status:", sent.status, sent.hash ?? "(no hash)");
  if (sent.status === "ERROR") {
    let msg = sent.status;
    for (const ev of sent.diagnosticEvents ?? []) {
      const data = ev.event?.body?.v0?.data ?? [];
      for (const d of data) {
        if (d.str) msg = Buffer.from(d.str()).toString();
      }
    }
    throw new Error(`send failed: ${msg}`);
  }
  if (!sent.hash) throw new Error(`send returned no hash (status=${sent.status})`);

  console.log(`  submitted ${sent.hash}`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return sent.hash;
    if (result.status === "FAILED") throw new Error(`tx failed on-chain: ${sent.hash}`);
  }
  throw new Error("confirmation timeout");
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
  const owner = kp.publicKey();
  const { tickLower, tickUpper } = fullRangeTicks();
  const server = new rpc.Server(RPC);

  console.log("Deployer:", owner);
  console.log("Farm:", farmId);
  console.log(`Ticks: ${tickLower} … ${tickUpper}`);
  console.log(`Lock: ${LOCK_WEEKS} weeks (1 year)\n`);

  let chosen: { pair: string; poolId: string; lpLiq: bigint; staked: bigint; stakeAmount: bigint } | null = null;

  for (const [pair, poolId] of pools) {
    const lpLiq = await readPoolPositionLiquidity(server, poolId, owner, tickLower, tickUpper);
    if (lpLiq === 0n) {
      console.log(`  ${pair}: no LP`);
      continue;
    }
    const staked = await readFarmStakeLiquidity(server, farmId, owner, poolId, tickLower, tickUpper);
    const available = lpLiq > staked ? lpLiq - staked : 0n;
    console.log(`  ${pair}: LP=${lpLiq} staked=${staked} available=${available}`);
    if (available > 0n && !chosen) {
      chosen = { pair, poolId, lpLiq, staked, stakeAmount: available };
    }
  }

  if (!chosen) {
    throw new Error("No unstaked LP found on deployer. Run test-add-liquidity or add liquidity on Pools first.");
  }

  console.log(`\nStaking ${chosen.stakeAmount} liquidity in ${chosen.pair} (${chosen.poolId})`);

  // Try full-range ticks first; fall back to a narrow range if footprint limit hit.
  const tickRanges = [
    { tickLower, tickUpper, label: "full-range" },
    { tickLower: -1200, tickUpper: 1200, label: "narrow" },
  ];

  let lastErr = "";
  for (const range of tickRanges) {
    try {
      const account = await server.getAccount(owner);
      const farm = new Contract(farmId);
      const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
        .addOperation(
          farm.call(
            "stake",
            new Address(owner).toScVal(),
            new Address(chosen.poolId).toScVal(),
            nativeToScVal(range.tickLower, { type: "i32" }),
            nativeToScVal(range.tickUpper, { type: "i32" }),
            nativeToScVal(chosen.stakeAmount, { type: "u128" }),
            nativeToScVal(LOCK_WEEKS, { type: "u32" }),
            nativeToScVal(false, { type: "bool" }),
          ),
        );
      console.log(`  Attempt (${range.label}) ticks ${range.tickLower}…${range.tickUpper}`);
      const hash = await submit(server, kp, tx);
      const stakedAfter = await readFarmStakeLiquidity(
        server,
        farmId,
        owner,
        chosen.poolId,
        range.tickLower,
        range.tickUpper,
      );
      console.log("\nSuccess — farm stake confirmed");
      console.log("  Tx:", hash);
      console.log("  Pool:", chosen.pair);
      console.log("  Ticks:", range.tickLower, range.tickUpper);
      console.log("  Staked liquidity:", stakedAfter.toString());
      return;
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : String(e);
      console.log("  Failed:", lastErr);
    }
  }
  throw new Error(lastErr || "stake failed");
}

main().catch((e) => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});
