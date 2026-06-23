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
const env = { ...Object.fromEntries(
  fs.readFileSync(path.join(root, ".env.contracts"), "utf8").split("\n")
    .map((l) => l.match(/^([A-Z_]+)=(.+)$/)?.slice(1) ?? [])
    .filter((x) => x.length === 2)
), ...Object.fromEntries(
  fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")
    .map((l) => l.match(/^([A-Z_]+)=(.+)$/)?.slice(1) ?? [])
    .filter((x) => x.length === 2)
) };

const kp = Keypair.fromSecret(env.DEPLOYER_SECRET_KEY);
const owner = kp.publicKey();
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const account = await server.getAccount(owner);
const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.TESTNET })
  .addOperation(
    new Contract(env.FARM_CONTRACT).call(
      "stake",
      new Address(owner).toScVal(),
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

console.log("Simulating (unsigned)...");
const sim = await server.simulateTransaction(tx);
console.log("sim error?", rpc.Api.isSimulationError(sim));
const simEnforce = await server.simulateTransaction(tx, undefined, "enforce");
console.log("enforce sim error?", rpc.Api.isSimulationError(simEnforce));
if (rpc.Api.isSimulationError(simEnforce)) {
  console.log("enforce error:", (simEnforce as { error?: string }).error);
}
if (rpc.Api.isSimulationError(sim)) {
  console.log(JSON.stringify(sim, null, 2));
  process.exit(1);
}
const ro = sim.transactionData?.build()?.resources()?.footprint()?.readOnly()?.length ?? "?";
const rw = sim.transactionData?.build()?.resources()?.footprint()?.readWrite()?.length ?? "?";
console.log("footprint readOnly:", ro, "readWrite:", rw);
console.log("needsRestore?", rpc.Api.isSimulationRestore(sim));
console.log("auth entries:", sim.result?.auth?.length ?? 0);

console.log("Assembling from sim (skip prepare)...");
const assembled = rpc.assembleTransaction(tx, sim).build();
const ext = assembled.toEnvelope().v1().tx().ext();
const sorobanData = ext._switch === 1 ? ext._value : null;
if (sorobanData) {
  const fp = sorobanData.resources().footprint();
  console.log(
    "assembled footprint keys:",
    fp.readOnly().length + fp.readWrite().length,
    `(ro=${fp.readOnly().length} rw=${fp.readWrite().length})`,
  );
}
assembled.sign(kp);
console.log("Sending assembled...");
const sent = await server.sendTransaction(assembled);
console.log("status:", sent.status, "hash:", sent.hash);
if (sent.status === "ERROR") {
  const msg = sent.diagnosticEvents?.[0]?.event?.body?.v0?.data?.[0] ?? sent.errorResult;
  console.log("error:", msg);
  process.exit(1);
}
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const result = await server.getTransaction(sent.hash!);
  if (result.status === "SUCCESS") {
    console.log("SUCCESS", sent.hash);
    process.exit(0);
  }
  if (result.status === "FAILED") {
    console.log("FAILED on-chain", sent.hash);
    process.exit(1);
  }
}
console.log("timeout");
