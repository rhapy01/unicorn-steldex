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
const load = (f: string) => {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(path.join(root, f), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
};
const env = { ...load(".env.contracts"), ...load(".env") };
const kp = Keypair.fromSecret(env.DEPLOYER_SECRET_KEY);
const server = new rpc.Server("https://soroban-testnet.stellar.org");
const account = await server.getAccount(kp.publicKey());

function fpCount(sim: rpc.Api.SimulateTransactionResponse) {
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
  const fp = sim.transactionData?.build()?.resources()?.footprint();
  const ro = fp?.readOnly()?.length ?? 0;
  const rw = fp?.readWrite()?.length ?? 0;
  return { total: ro + rw, ro, rw, auth: sim.result?.auth?.length ?? 0 };
}

async function trySend(label: string, tx: ReturnType<TransactionBuilder["build"]>) {
  const sim = await server.simulateTransaction(tx);
  console.log(`\n${label} sim:`, fpCount(sim));
  if (rpc.Api.isSimulationError(sim)) return;

  const signedAuth = await Promise.all(
    (sim.result?.auth ?? []).map((entry) =>
      authorizeEntry(
        entry,
        kp.publicKey(),
        async (preimage) => kp.sign(hash(preimage)),
        sim.latestLedger + 100_000,
        Networks.TESTNET,
      ),
    ),
  );
  const assembled = rpc.assembleTransaction(tx, sim).build();
  const op = assembled.operations[0];
  if (op.type === "invokeHostFunction") op.auth = signedAuth;
  assembled.sign(kp);
  const sent = await server.sendTransaction(assembled);
  console.log(`${label} send:`, sent.status);
  if (sent.status === "ERROR") {
    for (const ev of sent.diagnosticEvents ?? []) {
      const data = ev.event?.body?.v0?.data ?? [];
      for (const d of data) {
        if (d.str) console.log(" ", Buffer.from(d.str()).toString());
      }
    }
  }
}

const farm = env.FARM_CONTRACT;
const pool = env.POOL_CONTRACT;

await trySend(
  "fund",
  new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(
      new Contract(farm).call("fund", new Address(kp.publicKey()).toScVal(), nativeToScVal(1n, { type: "u128" })),
    )
    .setTimeout(300)
    .build(),
);

await trySend(
  "stake",
  new TransactionBuilder(account, { fee: "1000000", networkPassphrase: Networks.TESTNET })
    .addOperation(
      new Contract(farm).call(
        "stake",
        new Address(kp.publicKey()).toScVal(),
        new Address(pool).toScVal(),
        nativeToScVal(-443580, { type: "i32" }),
        nativeToScVal(443580, { type: "i32" }),
        nativeToScVal(1000n, { type: "u128" }),
        nativeToScVal(52, { type: "u32" }),
        nativeToScVal(false, { type: "bool" }),
      ),
    )
    .setTimeout(300)
    .build(),
);
