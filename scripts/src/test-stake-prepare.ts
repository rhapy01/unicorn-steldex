/** Quick stake test using prepareTransaction + keypair sign (same as deploy scripts). */
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
  authorizeEntry,
  hash,
} from "@stellar/stellar-sdk";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = { ...loadEnv(path.join(root, ".env.contracts")), ...loadEnv(path.join(root, ".env")) };
const kp = Keypair.fromSecret(env.DEPLOYER_SECRET_KEY);
const server = new rpc.Server("https://soroban-testnet.stellar.org");

const account = await server.getAccount(kp.publicKey());
const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.TESTNET })
  .addOperation(
    new Contract(env.FARM_CONTRACT).call(
      "stake",
      new Address(kp.publicKey()).toScVal(),
      new Address(env.POOL_CONTRACT).toScVal(),
      nativeToScVal(-443580, { type: "i32" }),
      nativeToScVal(443580, { type: "i32" }),
      nativeToScVal(1000n, { type: "u128" }),
      nativeToScVal(52, { type: "u32" }),
      nativeToScVal(false, { type: "bool" }),
    ),
  )
  .setTimeout(300)
  .build();

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) {
  console.log("sim error:", sim.error);
  process.exit(1);
}
const ro = sim.transactionData?.build()?.resources()?.footprint()?.readOnly()?.length ?? 0;
const rw = sim.transactionData?.build()?.resources()?.footprint()?.readWrite()?.length ?? 0;
console.log("sim footprint:", ro + rw, `(ro=${ro} rw=${rw})`, "auth:", sim.result?.auth?.length ?? 0);

function countFootprint(envelope: ReturnType<typeof tx.toEnvelope>) {
  const ext = envelope.v1().tx().ext();
  if (ext._switch !== 1) return { total: 0, ro: 0, rw: 0 };
  const fp = ext._value.resources().footprint();
  const ro = fp.readOnly().length;
  const rw = fp.readWrite().length;
  return { total: ro + rw, ro, rw };
}

console.log("Preparing (API path)...");
const prepared = await server.prepareTransaction(tx);
console.log("prepared footprint:", countFootprint(prepared.toEnvelope()));
prepared.sign(kp);

console.log("Sending...");
const sent = await server.sendTransaction(prepared);
console.log("status:", sent.status, "hash:", sent.hash);

if (sent.status === "ERROR") {
  console.log("errorResultXdr:", sent.errorResultXdr);
  for (const ev of sent.diagnosticEvents ?? []) {
    console.log("event:", JSON.stringify(ev));
  }
  process.exit(1);
}

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const r = await server.getTransaction(sent.hash!);
  console.log("poll:", r.status);
  if (r.status === "SUCCESS") {
    console.log("SUCCESS", sent.hash);
    process.exit(0);
  }
  if (r.status === "FAILED") {
    console.log("FAILED", sent.hash);
    process.exit(1);
  }
}
console.log("timeout");
