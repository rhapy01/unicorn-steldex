/** Place a resting limit sell above market on XLM/pUSDC. */
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
const pool = env.POOL_CONTRACT!;
const orders = env.ORDERS_CONTRACT!;
const xlm = env.XLM_TOKEN_CONTRACT!;
const usdc = env.USDC_TOKEN_CONTRACT!;

const account = await server.getAccount(kp.publicKey());
const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
  .addOperation(
    new Contract(orders).call(
      "place_order",
      new Address(kp.publicKey()).toScVal(),
      new Address(pool).toScVal(),
      new Address(xlm).toScVal(),
      nativeToScVal(true, { type: "bool" }),
      nativeToScVal(1_000_000n, { type: "u128" }),
      nativeToScVal(100_000n, { type: "u128" }),
      nativeToScVal(5000000000n, { type: "u128" }),
      nativeToScVal(2, { type: "u32" }),
      nativeToScVal(0, { type: "u32" }),
    ),
  )
  .setTimeout(300)
  .build();

const prepared = await server.prepareTransaction(tx);
prepared.sign(kp);
const sent = await server.sendTransaction(prepared);
console.log("status:", sent.status, sent.hash);
if (sent.status === "ERROR") process.exit(1);

for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const r = await server.getTransaction(sent.hash!);
  if (r.status === "SUCCESS") {
    console.log("SUCCESS");
    const open = await server.simulateTransaction(
      new TransactionBuilder(await server.getAccount("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"), {
        fee: "100",
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(new Contract(orders).call("open_orders"))
        .setTimeout(30)
        .build(),
    );
    console.log("open_orders sim ok");
    break;
  }
}
