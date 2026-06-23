/**
 * Stake with a fresh wallet (friendbot + minimal LP) to isolate footprint issues.
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
} from "@stellar/stellar-sdk";
import { fullRangeTicks } from "../../artifacts/api-server/src/lib/pool-ticks.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSPHRASE = Networks.TESTNET;
const RPC = "https://soroban-testnet.stellar.org";
const LOCK_WEEKS = 52;

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function submit(server: rpc.Server, kp: Keypair, tx: TransactionBuilder): Promise<string> {
  const built = tx.setTimeout(300).build();
  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`sim failed: ${JSON.stringify(sim)}`);
  const assembled = rpc.assembleTransaction(built, sim).build();
  assembled.sign(kp);
  const sent = await server.sendTransaction(assembled);
  if (sent.status === "ERROR" || !sent.hash) {
    throw new Error(`send failed: ${sent.status}`);
  }
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return sent.hash;
    if (r.status === "FAILED") throw new Error(`on-chain failed: ${sent.hash}`);
  }
  throw new Error("timeout");
}

async function main() {
  const env = { ...loadEnv(path.join(root, ".env.contracts")), ...loadEnv(path.join(root, ".env")) };
  const deployer = Keypair.fromSecret(env.DEPLOYER_SECRET_KEY);
  const staker = Keypair.random();
  const farmId = env.FARM_CONTRACT!;
  const poolId = env.POOL_CONTRACT!;
  const usdc = env.USDC_TOKEN_CONTRACT!;
  const xlm = env.XLM_TOKEN_CONTRACT!;
  const { tickLower, tickUpper } = fullRangeTicks();
  const server = new rpc.Server(RPC);

  console.log("Fresh staker:", staker.publicKey());
  const fb = await fetch(`https://friendbot.stellar.org?addr=${staker.publicKey()}`);
  if (!fb.ok) throw new Error("friendbot failed");
  console.log("Funded via friendbot");

  // Mint pUSDC from deployer to staker
  {
    const account = await server.getAccount(deployer.publicKey());
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(usdc).call(
          "mint",
          new Address(staker.publicKey()).toScVal(),
          nativeToScVal(5_000_000n, { type: "i128" }),
        ),
      );
    await submit(server, deployer, tx);
    console.log("Minted 5 pUSDC to staker");
  }

  // Wrap XLM for staker (self-transfer)
  {
    const account = await server.getAccount(staker.publicKey());
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(xlm).call(
          "transfer",
          new Address(staker.publicKey()).toScVal(),
          new Address(staker.publicKey()).toScVal(),
          nativeToScVal(50_000_000n, { type: "i128" }),
        ),
      );
    await submit(server, staker, tx);
    console.log("Wrapped 5 XLM for staker");
  }

  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 100_000;
  const maxApprove = BigInt("9223372036854775807");
  const poolAddr = new Address(poolId);
  const stakerAddr = new Address(staker.publicKey());

  for (const [label, token] of [["token0", usdc], ["token1", xlm]] as const) {
    const account = await server.getAccount(staker.publicKey());
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(token).call(
          "approve",
          stakerAddr.toScVal(),
          poolAddr.toScVal(),
          nativeToScVal(maxApprove, { type: "i128" }),
          nativeToScVal(expiration, { type: "u32" }),
        ),
      );
    await submit(server, staker, tx);
    console.log(`Approved ${label}`);
  }

  // Mint small LP (use fixed liquidity from small amounts - read sqrt price and compute or use small mint)
  {
    const account = await server.getAccount(staker.publicKey());
    const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(poolId).call(
          "mint",
          stakerAddr.toScVal(),
          nativeToScVal(tickLower, { type: "i32" }),
          nativeToScVal(tickUpper, { type: "i32" }),
          nativeToScVal(10_000n, { type: "u128" }),
        ),
      );
    try {
      await submit(server, staker, tx);
      console.log("Minted LP liquidity=10000");
    } catch (e) {
      console.log("Mint with 10000 failed, trying 1000:", (e as Error).message);
      const account2 = await server.getAccount(staker.publicKey());
      const tx2 = new TransactionBuilder(account2, { fee: "10000000", networkPassphrase: PASSPHRASE })
        .addOperation(
          new Contract(poolId).call(
            "mint",
            stakerAddr.toScVal(),
            nativeToScVal(tickLower, { type: "i32" }),
            nativeToScVal(tickUpper, { type: "i32" }),
            nativeToScVal(1_000n, { type: "u128" }),
          ),
        );
      await submit(server, staker, tx2);
      console.log("Minted LP liquidity=1000");
    }
  }

  // Stake
  {
    const account = await server.getAccount(staker.publicKey());
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(farmId).call(
          "stake",
          stakerAddr.toScVal(),
          poolAddr.toScVal(),
          nativeToScVal(tickLower, { type: "i32" }),
          nativeToScVal(tickUpper, { type: "i32" }),
          nativeToScVal(1_000n, { type: "u128" }),
          nativeToScVal(LOCK_WEEKS, { type: "u32" }),
          nativeToScVal(false, { type: "bool" }),
        ),
      );
    const hash = await submit(server, staker, tx);
    console.log("\nStake SUCCESS:", hash);
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});
