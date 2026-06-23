/**
 * Add liquidity as deployer — one Soroban op per tx (same as Freighter requires).
 * Usage: npx tsx scripts/src/test-add-liquidity.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  Address,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  rpc,
  scValToBigInt,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { computeLiquidity, tickToSqrtQ32 } from "../../artifacts/api-server/src/lib/clmm-math.ts";
import { canonicalizeTokenPair } from "../../artifacts/api-server/src/lib/token-order.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSPHRASE = Networks.TESTNET;
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function balance(server: rpc.Server, contractId: string, owner: string): Promise<bigint> {
  const simSource = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const account = await server.getAccount(simSource);
  const c = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(c.call("balance", new Address(owner).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return 0n;
  return sim.result?.retval ? scValToBigInt(sim.result.retval) : 0n;
}

async function sqrtPrice(server: rpc.Server, poolId: string): Promise<bigint> {
  const simSource = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const account = await server.getAccount(simSource);
  const pool = new Contract(poolId);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(pool.call("sqrt_price"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`sqrt_price sim failed: ${sim.error}`);
  return scValToBigInt(sim.result!.retval!);
}

async function submit(server: rpc.Server, kp: Keypair, tx: TransactionBuilder): Promise<string> {
  const built = tx.setTimeout(300).build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || !sent.hash) {
    throw new Error(sent.errorResultXdr || "sendTransaction failed");
  }
  console.log(`  submitted ${sent.hash}`);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return sent.hash;
    if (result.status === "FAILED") {
      throw new Error(`tx failed: ${sent.hash}`);
    }
  }
  throw new Error("confirmation timeout");
}

async function main() {
  const env = { ...loadEnv(path.join(root, ".env.contracts")), ...loadEnv(path.join(root, ".env")) };
  const secret = env.DEPLOYER_SECRET_KEY;
  if (!secret) throw new Error("DEPLOYER_SECRET_KEY missing in .env");

  const pool = env.POOL_CONTRACT!;
  const usdc = env.USDC_TOKEN_CONTRACT!;
  const xlm = env.XLM_TOKEN_CONTRACT!;
  const kp = Keypair.fromSecret(secret);
  const owner = kp.publicKey();
  console.log("Deployer:", owner);

  const horizon = new Horizon.Server(HORIZON);
  const acct = await horizon.loadAccount(owner);
  const nativeXlm = parseFloat(acct.balances.find((b) => b.asset_type === "native")?.balance ?? "0");
  console.log("Native XLM:", nativeXlm);

  const server = new rpc.Server(RPC);
  const { token0, token1, amount0, amount1 } = canonicalizeTokenPair(
    usdc,
    xlm,
    "1000000",
    "10000000",
  );
  const amount0Bn = BigInt(amount0);
  const amount1Bn = BigInt(amount1);
  const lower = Math.ceil(-443636 / 60) * 60;
  const upper = Math.floor(443636 / 60) * 60;

  const bal0 = await balance(server, token0, owner);
  const bal1 = await balance(server, token1, owner);
  console.log("Soroban token0:", bal0.toString(), "token1:", bal1.toString());

  if (bal0 < amount0Bn) {
    console.log("\nStep: mint USDC to deployer");
    const account = await server.getAccount(owner);
    const mintTx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(token0).call(
          "mint",
          new Address(owner).toScVal(),
          nativeToScVal(amount0Bn * 2n, { type: "i128" }),
        ),
      );
    await submit(server, kp, mintTx);
  }

  const bal1After = await balance(server, token1, owner);
  if (bal1After < amount1Bn) {
    const wrap = amount1Bn - bal1After + 10_000_000n;
    if (nativeXlm * 1e7 < Number(wrap) + 50_000_000) {
      throw new Error(`Need ~${Number(wrap) / 1e7 + 5} native XLM on deployer for wrap. Current: ${nativeXlm}`);
    }
    console.log("\nStep: wrap XLM", wrap.toString());
    const account = await server.getAccount(owner);
    const wrapTx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(token1).call(
          "transfer",
          new Address(owner).toScVal(),
          new Address(owner).toScVal(),
          nativeToScVal(wrap, { type: "i128" }),
        ),
      );
    await submit(server, kp, wrapTx);
  }

  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 100_000;
  const maxApprove = BigInt("9223372036854775807");
  const poolAddr = new Address(pool);
  const ownerAddr = new Address(owner);

  console.log("\nStep: approve token0");
  {
    const account = await server.getAccount(owner);
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(token0).call(
          "approve",
          ownerAddr.toScVal(),
          poolAddr.toScVal(),
          nativeToScVal(maxApprove, { type: "i128" }),
          nativeToScVal(expiration, { type: "u32" }),
        ),
      );
    await submit(server, kp, tx);
  }

  console.log("\nStep: approve token1");
  {
    const account = await server.getAccount(owner);
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(token1).call(
          "approve",
          ownerAddr.toScVal(),
          poolAddr.toScVal(),
          nativeToScVal(maxApprove, { type: "i128" }),
          nativeToScVal(expiration, { type: "u32" }),
        ),
      );
    await submit(server, kp, tx);
  }

  const sp = await sqrtPrice(server, pool);
  const liquidity = computeLiquidity(sp, tickToSqrtQ32(lower), tickToSqrtQ32(upper), amount0Bn, amount1Bn);
  console.log("\nLiquidity:", liquidity.toString(), "sqrtPrice:", sp.toString());
  if (liquidity === 0n) throw new Error("zero liquidity — check amounts / pool price");

  console.log("\nStep: pool.mint");
  {
    const account = await server.getAccount(owner);
    const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: PASSPHRASE })
      .addOperation(
        new Contract(pool).call(
          "mint",
          ownerAddr.toScVal(),
          nativeToScVal(lower, { type: "i32" }),
          nativeToScVal(upper, { type: "i32" }),
          nativeToScVal(liquidity, { type: "u128" }),
        ),
      );
    const hash = await submit(server, kp, tx);
    console.log("\nSuccess — liquidity added:", hash);
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e.message || e);
  process.exit(1);
});
