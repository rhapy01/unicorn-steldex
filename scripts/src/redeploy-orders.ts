/**
 * Deploy orders (limit order book) contract and update .env.contracts ORDERS_CONTRACT.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSPHRASE = Networks.TESTNET;
const RPC = "https://soroban-testnet.stellar.org";
const WASM_DIRS = [
  path.join(root, "contracts/target/wasm32v1-none/release"),
  path.join(root, "contracts/target/wasm32-unknown-unknown/release"),
];

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
  throw new Error(`WASM not found: ${name}`);
}

function toContractStrkey(hex: string): string {
  return StrKey.encodeContract(Buffer.from(hex, "hex"));
}

async function send(server: rpc.Server, kp: Keypair, build: (acc: rpc.Api.GetAccountResponse) => TransactionBuilder) {
  const account = await server.getAccount(kp.publicKey());
  const prepared = await server.prepareTransaction(build(account).setTimeout(300).build());
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || !sent.hash) throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return r;
    if (r.status === "FAILED") throw new Error(`failed: ${sent.hash}`);
  }
  throw new Error("timeout");
}

async function main() {
  const env = { ...loadEnv(path.join(root, ".env.contracts")), ...loadEnv(path.join(root, ".env")) };
  const kp = Keypair.fromSecret(env.DEPLOYER_SECRET_KEY);
  const server = new rpc.Server(RPC);

  console.log("Uploading orders wasm...");
  const wasm = readWasm("stellar_swap_orders");
  const wasmHash = createHash("sha256").update(wasm).digest("hex");
  await send(server, kp, (account) =>
    new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(Operation.uploadContractWasm({ wasm: new Uint8Array(wasm) })),
  );

  console.log("Creating orders contract...");
  const salt = randomBytes(32);
  const createResult = await send(server, kp, (account) =>
    new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.createCustomContract({
          address: new Address(kp.publicKey()),
          wasmHash: Buffer.from(wasmHash, "hex"),
          salt,
        }),
      ),
  );
  const hex = (createResult as { returnValue?: xdr.ScVal }).returnValue?.address()?.contractId().toString("hex");
  if (!hex) throw new Error("no contract id from create");
  const ordersId = toContractStrkey(hex);
  console.log("New orders:", ordersId);

  await send(server, kp, (account) =>
    new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(ordersId).call("initialize", new Address(kp.publicKey()).toScVal()),
      ),
  );
  console.log("Initialized");

  const contractsPath = path.join(root, ".env.contracts");
  let text = fs.readFileSync(contractsPath, "utf8");
  if (/^ORDERS_CONTRACT=/m.test(text)) {
    text = text.replace(/^ORDERS_CONTRACT=.*$/m, `ORDERS_CONTRACT=${ordersId}`);
  } else {
    text = text.trimEnd() + `\nORDERS_CONTRACT=${ordersId}\n`;
  }
  fs.writeFileSync(contractsPath, text);
  console.log("Updated .env.contracts");
}

main().catch((e) => {
  console.error("FAILED:", e.message || e);
  process.exit(1);
});
