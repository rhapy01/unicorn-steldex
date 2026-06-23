/**
 * Deploy one pool contract per token pair (bypasses broken factory salt).
 * Writes POOLS_JSON into .env.contracts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";
import {
  Address,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  rpc,
  scValToBigInt,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { computeLiquidity, tickToSqrtQ32 } from "../../artifacts/api-server/src/lib/clmm-math.ts";
import { canonicalizeTokenPair } from "../../artifacts/api-server/src/lib/token-order.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSPHRASE = Networks.TESTNET;
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const WASM = path.join(root, "contracts/target/wasm32v1-none/release/stellar_swap_pool.wasm");
const ENV_FILE = path.join(root, ".env.contracts");

const PRICES: Record<string, number> = {
  XLM: 0.13,
  pUSDC: 1,
  cUSDC: 1,
  EURC: 1.08,
  STELLAR: 0.05,
};

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function pairKey(a: string, b: string) {
  return [a, b].sort().join("/");
}

function initialSqrtPrice(a: string, b: string, priceA: number, priceB: number): bigint {
  const [p0, p1] = a < b ? [priceA, priceB] : [priceB, priceA];
  return BigInt(Math.floor(Math.sqrt(p1 / p0) * 2 ** 32));
}

function unit(sym: string): bigint {
  return sym === "pUSDC" ? 1_000_000n : 10_000_000n;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function submit(server: rpc.Server, kp: Keypair, tx: TransactionBuilder): Promise<string> {
  const built = tx.setTimeout(300).build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || !sent.hash) throw new Error(sent.errorResultXdr || "send failed");
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const r = await server.getTransaction(sent.hash);
    if (r.status === "SUCCESS") return sent.hash;
    if (r.status === "FAILED") throw new Error(`failed ${sent.hash}`);
  }
  throw new Error("timeout");
}

async function poolLiquidity(server: rpc.Server, poolId: string): Promise<bigint> {
  const sim = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const account = await server.getAccount(sim);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(poolId).call("liquidity"))
    .setTimeout(30)
    .build();
  const simR = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simR)) return 0n;
  return simR.result?.retval ? scValToBigInt(simR.result.retval) : 0n;
}

async function balance(server: rpc.Server, token: string, owner: string): Promise<bigint> {
  const sim = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const account = await server.getAccount(sim);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(token).call("balance", new Address(owner).toScVal()))
    .setTimeout(30)
    .build();
  const simR = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simR)) return 0n;
  return simR.result?.retval ? scValToBigInt(simR.result.retval) : 0n;
}

async function main() {
  if (!fs.existsSync(WASM)) throw new Error(`Missing ${WASM}`);
  const env = { ...loadEnv(ENV_FILE), ...loadEnv(path.join(root, ".env")) };
  const secret = env.DEPLOYER_SECRET_KEY;
  if (!secret) throw new Error("DEPLOYER_SECRET_KEY missing");

  const tokens: Record<string, string> = {
    XLM: env.XLM_TOKEN_CONTRACT!,
    pUSDC: env.USDC_TOKEN_CONTRACT!,
    cUSDC: env.CIRCLE_USDC_TOKEN_CONTRACT!,
    EURC: env.EURC_TOKEN_CONTRACT!,
    STELLAR: env.STELLAR_TOKEN_CONTRACT!,
  };
  const factory = env.FACTORY_CONTRACT!;
  const kp = Keypair.fromSecret(secret);
  const owner = kp.publicKey();
  const server = new rpc.Server(RPC);
  const horizon = new Horizon.Server(HORIZON);
  const nativeXlm = parseFloat(
    (await horizon.loadAccount(owner)).balances.find((b) => b.asset_type === "native")?.balance ?? "0",
  );

  let pools: Record<string, string> = {};
  if (env.POOLS_JSON) {
    try {
      pools = JSON.parse(env.POOLS_JSON);
    } catch {
      /* ignore */
    }
  }
  if (env.POOL_CONTRACT && !pools["XLM/pUSDC"] && !pools["pUSDC/XLM"]) {
    pools[pairKey("XLM", "pUSDC")] = env.POOL_CONTRACT;
  }

  const wasm = fs.readFileSync(WASM);
  const wasmHash = createHash("sha256").update(wasm).digest();

  console.log("Deployer:", owner);
  const symbols = Object.keys(tokens);

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const symA = symbols[i];
      const symB = symbols[j];
      const pk = pairKey(symA, symB);
      const a = tokens[symA];
      const b = tokens[symB];
      const [t0, t1] = a < b ? [a, b] : [b, a];

      let poolId: string;
      if (pools[pk]) {
        poolId = pools[pk];
        console.log(`\n${pk}: exists ${poolId}`);
      } else {
        console.log(`\n${pk}: deploying pool…`);
        const sqrt = initialSqrtPrice(a, b, PRICES[symA], PRICES[symB]);
        const salt = randomBytes(32);
        const account = await server.getAccount(owner);
        const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: PASSPHRASE })
          .addOperation(
            Operation.createCustomContract({
              address: new Address(owner),
              wasmHash,
              salt,
              constructorArgs: [
                new Address(t0).toScVal(),
                new Address(t1).toScVal(),
                nativeToScVal(30, { type: "u32" }),
                nativeToScVal(sqrt, { type: "u128" }),
                new Address(factory).toScVal(),
              ],
            }),
          );
        const hash = await submit(server, kp, tx);
        const result = await server.getTransaction(hash);
        const retval = (result as { returnValue?: xdr.ScVal }).returnValue;
        if (!retval) throw new Error("no pool address returned");
        poolId = StrKey.encodeContract(
          Buffer.from(retval.address().contractId().toString("hex"), "hex"),
        );
        pools[pk] = poolId;
        console.log("  pool:", poolId);
      }

      const liq = await poolLiquidity(server, poolId);
      if (liq > 0n) {
        console.log("  liquidity already seeded:", liq.toString());
        continue;
      }
      console.log("  seeding liquidity…");

      const amountA = unit(symA);
      const amountB = unit(symB);
      const { token0, token1, amount0, amount1 } = canonicalizeTokenPair(
        a,
        b,
        amountA.toString(),
        amountB.toString(),
      );
      const amount0Bn = BigInt(amount0);
      const amount1Bn = BigInt(amount1);

      if (symA === "pUSDC" || symB === "pUSDC") {
        const need = tokens.pUSDC === token0 ? amount0Bn : amount1Bn;
        const bal = await balance(server, tokens.pUSDC, owner);
        if (bal < need) {
          const acct = await server.getAccount(owner);
          await submit(
            server,
            kp,
            new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASSPHRASE }).addOperation(
              new Contract(tokens.pUSDC).call(
                "mint",
                new Address(owner).toScVal(),
                nativeToScVal(need - bal + unit("pUSDC"), { type: "i128" }),
              ),
            ),
          );
        }
      }
      if (symA === "STELLAR" || symB === "STELLAR") {
        const need = tokens.STELLAR === token0 ? amount0Bn : amount1Bn;
        const bal = await balance(server, tokens.STELLAR, owner);
        if (bal < need) {
          const acct = await server.getAccount(owner);
          await submit(
            server,
            kp,
            new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASSPHRASE }).addOperation(
              new Contract(tokens.STELLAR).call(
                "mint",
                new Address(owner).toScVal(),
                nativeToScVal(need - bal + unit("STELLAR"), { type: "i128" }),
              ),
            ),
          );
        }
      }
      if (symA === "XLM" || symB === "XLM") {
        const need = tokens.XLM === token0 ? amount0Bn : amount1Bn;
        const bal = await balance(server, tokens.XLM, owner);
        if (bal < need) {
          const wrap = need - bal + 10_000_000n;
          if (nativeXlm * 1e7 < Number(wrap) + 5e7) throw new Error("need more native XLM");
          const acct = await server.getAccount(owner);
          await submit(
            server,
            kp,
            new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASSPHRASE }).addOperation(
              new Contract(tokens.XLM).call(
                "transfer",
                new Address(owner).toScVal(),
                new Address(owner).toScVal(),
                nativeToScVal(wrap, { type: "i128" }),
              ),
            ),
          );
        }
      }

      const bal0 = await balance(server, token0, owner);
      const bal1 = await balance(server, token1, owner);
      if (bal0 < amount0Bn || bal1 < amount1Bn) {
        console.log(`  skip liquidity — need token0=${amount0Bn} (${bal0}) token1=${amount1Bn} (${bal1})`);
        if (pk.includes("cUSDC") || pk.includes("EURC")) {
          console.log("  → enable trustlines + https://faucet.circle.com/ then re-run");
        }
        continue;
      }

      const lower = Math.ceil(-443636 / 60) * 60;
      const upper = Math.floor(443636 / 60) * 60;
      const latest = await server.getLatestLedger();
      const exp = latest.sequence + 100_000;
      const max = BigInt("9223372036854775807");
      const poolAddr = new Address(poolId);
      const ownerAddr = new Address(owner);

      for (const token of [token0, token1]) {
        const acct = await server.getAccount(owner);
        await submit(
          server,
          kp,
          new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASSPHRASE }).addOperation(
            new Contract(token).call(
              "approve",
              ownerAddr.toScVal(),
              poolAddr.toScVal(),
              nativeToScVal(max, { type: "i128" }),
              nativeToScVal(exp, { type: "u32" }),
            ),
          ),
        );
      }

      const sim = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
      const simAcct = await server.getAccount(sim);
      const spSim = await server.simulateTransaction(
        new TransactionBuilder(simAcct, { fee: "100", networkPassphrase: PASSPHRASE })
          .addOperation(new Contract(poolId).call("sqrt_price"))
          .setTimeout(30)
          .build(),
      );
      const sp = scValToBigInt(spSim.result!.retval!);
      const liquidity = computeLiquidity(
        sp,
        tickToSqrtQ32(lower),
        tickToSqrtQ32(upper),
        amount0Bn,
        amount1Bn,
      );
      const acct = await server.getAccount(owner);
      await submit(
        server,
        kp,
        new TransactionBuilder(acct, { fee: "10000000", networkPassphrase: PASSPHRASE }).addOperation(
          new Contract(poolId).call(
            "mint",
            ownerAddr.toScVal(),
            nativeToScVal(lower, { type: "i32" }),
            nativeToScVal(upper, { type: "i32" }),
            nativeToScVal(liquidity, { type: "u128" }),
          ),
        ),
      );
      console.log("  ✓ liquidity added");
    }
  }

  const lines = fs.readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => !l.startsWith("POOLS_JSON="));
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  lines.push(`POOLS_JSON=${JSON.stringify(pools)}`, "");
  fs.writeFileSync(ENV_FILE, lines.join("\n"));
  console.log("\n✅ All pools:", Object.keys(pools).length);
  console.log("POOLS_JSON written to .env.contracts");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
