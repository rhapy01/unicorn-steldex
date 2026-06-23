/**
 * Redeploy factory + router (fixed multi-pool salt) and create all token pair pools.
 * Keeps existing token contracts from .env.contracts.
 *
 * Prereq: contracts/build.sh
 * Usage: pnpm --filter @workspace/scripts run redeploy-factory
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Address,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { createHash, randomBytes } from "crypto";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSPHRASE = Networks.TESTNET;
const RPC = "https://soroban-testnet.stellar.org";
const WASM_DIRS = [
  path.join(root, "contracts/target/wasm32v1-none/release"),
  path.join(root, "contracts/target/wasm32-unknown-unknown/release"),
];
const OUTPUT = path.join(root, ".env.contracts");

const PRICES: Record<string, number> = {
  XLM: 0.13,
  pUSDC: 1,
  cUSDC: 1,
  EURC: 1.08,
  STELLAR: 0.05,
};

const server = new rpc.Server(RPC);

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function readWasm(name: string): Buffer {
  for (const dir of WASM_DIRS) {
    const p = path.join(dir, `${name}.wasm`);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  throw new Error(`Missing ${name}.wasm. Run: cargo build --target wasm32v1-none --release`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendAndWait(kp: Keypair, build: (account: rpc.Api.GetAccountResponse) => TransactionBuilder) {
  const account = await server.getAccount(kp.publicKey());
  const tx = build(account as Parameters<typeof TransactionBuilder>[0]).build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || !sent.hash) throw new Error(sent.errorResultXdr || "send failed");
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return result;
    if (result.status === "FAILED") throw new Error(`failed: ${sent.hash}`);
  }
  throw new Error("timeout");
}

async function uploadWasm(kp: Keypair, wasm: Buffer): Promise<string> {
  await sendAndWait(kp, (account) =>
    new TransactionBuilder(account as Parameters<typeof TransactionBuilder>[0], {
      fee: "1000000",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(Operation.uploadContractWasm({ wasm: new Uint8Array(wasm) }))
      .setTimeout(300),
  );
  return createHash("sha256").update(wasm).digest("hex");
}

async function createContract(kp: Keypair, wasmHash: string): Promise<string> {
  const salt = randomBytes(32);
  const result = await sendAndWait(kp, (account) =>
    new TransactionBuilder(account as Parameters<typeof TransactionBuilder>[0], {
      fee: "1000000",
      networkPassphrase: PASSPHRASE,
    }).addOperation(
      Operation.createCustomContract({
        address: new Address(kp.publicKey()),
        wasmHash: Buffer.from(wasmHash, "hex"),
        salt,
      }),
    ).setTimeout(300),
  );
  const retval = (result as { returnValue?: xdr.ScVal }).returnValue;
  if (!retval) throw new Error("no contract id");
  const { StrKey } = await import("@stellar/stellar-sdk");
  return StrKey.encodeContract(Buffer.from(retval.address().contractId().toString("hex"), "hex"));
}

async function callContract(kp: Keypair, contractId: string, method: string, args: xdr.ScVal[]) {
  return sendAndWait(kp, (account) =>
    new TransactionBuilder(account as Parameters<typeof TransactionBuilder>[0], {
      fee: "10000000",
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(new (await import("@stellar/stellar-sdk")).Contract(contractId).call(method, ...args))
      .setTimeout(300),
  );
}

function initialSqrtPrice(a: string, b: string, priceA: number, priceB: number): bigint {
  const [p0, p1] = a < b ? [priceA, priceB] : [priceB, priceA];
  return BigInt(Math.floor(Math.sqrt(p1 / p0) * 2 ** 32));
}

async function main() {
  const env = { ...loadEnv(OUTPUT), ...loadEnv(path.join(root, ".env")) };
  const secret = env.DEPLOYER_SECRET_KEY;
  if (!secret) throw new Error("DEPLOYER_SECRET_KEY missing");

  const tokens: Record<string, string> = {
    XLM: env.XLM_TOKEN_CONTRACT!,
    pUSDC: env.USDC_TOKEN_CONTRACT!,
    cUSDC: env.CIRCLE_USDC_TOKEN_CONTRACT!,
    EURC: env.EURC_TOKEN_CONTRACT!,
    STELLAR: env.STELLAR_TOKEN_CONTRACT!,
  };
  for (const [k, v] of Object.entries(tokens)) {
    if (!v) throw new Error(`Missing ${k} in .env.contracts`);
  }

  const kp = Keypair.fromSecret(secret);
  console.log("Deployer:", kp.publicKey());

  const factoryHash = await uploadWasm(kp, readWasm("stellar_swap_factory"));
  const poolHash = await uploadWasm(kp, readWasm("stellar_swap_pool"));
  const routerHash = await uploadWasm(kp, readWasm("stellar_swap_router"));

  const factoryId = await createContract(kp, factoryHash);
  await callContract(kp, factoryId, "initialize", [
    new Address(kp.publicKey()).toScVal(),
    nativeToScVal(Buffer.from(poolHash, "hex"), { type: "bytes" }),
  ]);
  console.log("Factory:", factoryId);

  const routerId = await createContract(kp, routerHash);
  await callContract(kp, routerId, "initialize", [
    new Address(factoryId).toScVal(),
    new Address(kp.publicKey()).toScVal(),
  ]);
  console.log("Router:", routerId);

  const symbols = Object.keys(tokens);
  const pools: Record<string, string> = {};
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const symA = symbols[i];
      const symB = symbols[j];
      const pair = [symA, symB].sort().join("/");
      const a = tokens[symA];
      const b = tokens[symB];
      const sqrt = initialSqrtPrice(a, b, PRICES[symA], PRICES[symB]);
      console.log(`Creating pool ${pair}…`);
      const result = await callContract(kp, factoryId, "create_pool", [
        new Address(a).toScVal(),
        new Address(b).toScVal(),
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Medium")]),
        nativeToScVal(sqrt, { type: "u128" }),
      ]);
      const retval = (result as { returnValue?: xdr.ScVal }).returnValue;
      const { StrKey } = await import("@stellar/stellar-sdk");
      const poolId = StrKey.encodeContract(
        Buffer.from(retval!.address().contractId().toString("hex"), "hex"),
      );
      pools[pair] = poolId;
      console.log(`  ${pair}: ${poolId}`);
    }
  }

  const primaryPool = pools["XLM/pUSDC"] ?? Object.values(pools)[0];
  const lines = [
    `# StellarSwap Deployed Contract Addresses (Testnet)`,
    `# Redeployed: ${new Date().toISOString()}`,
    `FACTORY_CONTRACT=${factoryId}`,
    `ROUTER_CONTRACT=${routerId}`,
    `FARM_CONTRACT=${env.FARM_CONTRACT ?? ""}`,
    `POOL_CONTRACT=${primaryPool}`,
    `XLM_TOKEN_CONTRACT=${tokens.XLM}`,
    `STELLAR_TOKEN_CONTRACT=${tokens.STELLAR}`,
    `USDC_TOKEN_CONTRACT=${tokens.pUSDC}`,
    `CIRCLE_USDC_TOKEN_CONTRACT=${tokens.cUSDC}`,
    `EURC_TOKEN_CONTRACT=${tokens.EURC}`,
    "",
    "# All pools",
    ...Object.entries(pools).map(([pair, id]) => `# POOL_${pair.replace("/", "_")}=${id}`),
    "",
  ];
  fs.writeFileSync(OUTPUT, lines.join("\n"));

  console.log("\nRedeploy complete. Next: pnpm --filter @workspace/scripts run setup-pools");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
