/**
 * Create all token pair pools on the existing factory + seed liquidity.
 * Usage: npx tsx scripts/src/setup-all-pools.ts
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
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function initialSqrtPrice(contractA: string, contractB: string, priceA: number, priceB: number): bigint {
  const [p0, p1] = contractA < contractB ? [priceA, priceB] : [priceB, priceA];
  const ratio = p1 / p0;
  return BigInt(Math.floor(Math.sqrt(ratio) * 2 ** 32));
}

function unitAmount(symbol: string): bigint {
  if (symbol === "pUSDC") return 1_000_000n;
  return 10_000_000n;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function submit(server: rpc.Server, kp: Keypair, tx: TransactionBuilder): Promise<string> {
  const built = tx.build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR" || !sent.hash) throw new Error(sent.errorResultXdr || "send failed");
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") return sent.hash;
    if (result.status === "FAILED") throw new Error(`tx failed: ${sent.hash}`);
  }
  throw new Error("timeout");
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

async function getPoolFromFactory(
  server: rpc.Server,
  factory: string,
  tokenA: string,
  tokenB: string,
): Promise<string | null> {
  const simSource = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const account = await server.getAccount(simSource);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(
      new Contract(factory).call(
        "get_pool",
        new Address(tokenA).toScVal(),
        new Address(tokenB).toScVal(),
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Medium")]),
      ),
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result?.retval) return null;
  const val = sim.result.retval;
  if (val.switch().name === "scvVoid") return null;
  const hex = val.address().contractId().toString("hex");
  return StrKey.encodeContract(Buffer.from(hex, "hex"));
}

async function poolLiquidity(server: rpc.Server, poolId: string): Promise<bigint> {
  const simSource = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const account = await server.getAccount(simSource);
  const pool = new Contract(poolId);
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(pool.call("liquidity"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return 0n;
  return sim.result?.retval ? scValToBigInt(sim.result.retval) : 0n;
}

function contractIdFromResult(result: rpc.Api.GetTransactionResponse): string {
  const retval = (result as { returnValue?: xdr.ScVal }).returnValue;
  if (!retval) throw new Error("no return value");
  const hex = retval.address().contractId().toString("hex");
  return StrKey.encodeContract(Buffer.from(hex, "hex"));
}

async function callContract(
  server: rpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<rpc.Api.GetTransactionResponse> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(300);
  const hash = await submit(server, kp, tx);
  return server.getTransaction(hash) as Promise<rpc.Api.GetTransactionResponse>;
}

async function ensureMintable(
  server: rpc.Server,
  kp: Keypair,
  contract: string,
  owner: string,
  need: bigint,
): Promise<void> {
  const bal = await balance(server, contract, owner);
  if (bal >= need) return;
  console.log(`  mint ${need - bal + unitAmount("pUSDC")} to deployer`);
  const account = await server.getAccount(owner);
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE }).addOperation(
    new Contract(contract).call(
      "mint",
      new Address(owner).toScVal(),
      nativeToScVal(need - bal + unitAmount("pUSDC"), { type: "i128" }),
    ),
  );
  await submit(server, kp, tx);
}

async function ensureWrappedXlm(
  server: rpc.Server,
  kp: Keypair,
  xlmContract: string,
  owner: string,
  need: bigint,
  nativeXlm: number,
): Promise<void> {
  const bal = await balance(server, xlmContract, owner);
  if (bal >= need) return;
  const wrap = need - bal + 10_000_000n;
  if (nativeXlm * 1e7 < Number(wrap) + 50_000_000) {
    throw new Error(`Need more native XLM for wrap (have ${nativeXlm})`);
  }
  console.log(`  wrap XLM ${wrap}`);
  const account = await server.getAccount(owner);
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE }).addOperation(
    new Contract(xlmContract).call(
      "transfer",
      new Address(owner).toScVal(),
      new Address(owner).toScVal(),
      nativeToScVal(wrap, { type: "i128" }),
    ),
  );
  await submit(server, kp, tx);
}

async function addLiquidity(
  server: rpc.Server,
  kp: Keypair,
  poolId: string,
  token0: string,
  token1: string,
  amount0: bigint,
  amount1: bigint,
): Promise<void> {
  const owner = kp.publicKey();
  const lower = Math.ceil(-443636 / 60) * 60;
  const upper = Math.floor(443636 / 60) * 60;
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + 100_000;
  const maxApprove = BigInt("9223372036854775807");
  const poolAddr = new Address(poolId);
  const ownerAddr = new Address(owner);

  for (const [token, label] of [
    [token0, "token0"],
    [token1, "token1"],
  ] as const) {
    const account = await server.getAccount(owner);
    const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: PASSPHRASE }).addOperation(
      new Contract(token).call(
        "approve",
        ownerAddr.toScVal(),
        poolAddr.toScVal(),
        nativeToScVal(maxApprove, { type: "i128" }),
        nativeToScVal(expiration, { type: "u32" }),
      ),
    );
    await submit(server, kp, tx);
  }

  const simSource = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  const account = await server.getAccount(simSource);
  const pool = new Contract(poolId);
  const spTx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(pool.call("sqrt_price"))
    .setTimeout(30)
    .build();
  const spSim = await server.simulateTransaction(spTx);
  if (rpc.Api.isSimulationError(spSim)) throw new Error("sqrt_price failed");
  const sp = scValToBigInt(spSim.result!.retval!);
  const liquidity = computeLiquidity(sp, tickToSqrtQ32(lower), tickToSqrtQ32(upper), amount0, amount1);
  if (liquidity === 0n) throw new Error("zero liquidity");

  const ownerAccount = await server.getAccount(owner);
  const mintTx = new TransactionBuilder(ownerAccount, { fee: "10000000", networkPassphrase: PASSPHRASE }).addOperation(
    pool.call(
      "mint",
      ownerAddr.toScVal(),
      nativeToScVal(lower, { type: "i32" }),
      nativeToScVal(upper, { type: "i32" }),
      nativeToScVal(liquidity, { type: "u128" }),
    ),
  );
  await submit(server, kp, mintTx);
}

async function main() {
  const env = { ...loadEnv(path.join(root, ".env.contracts")), ...loadEnv(path.join(root, ".env")) };
  const secret = env.DEPLOYER_SECRET_KEY;
  if (!secret) throw new Error("DEPLOYER_SECRET_KEY missing");

  const factory = env.FACTORY_CONTRACT!;
  const tokens: Record<string, string> = {
    XLM: env.XLM_TOKEN_CONTRACT!,
    pUSDC: env.USDC_TOKEN_CONTRACT!,
    cUSDC: env.CIRCLE_USDC_TOKEN_CONTRACT!,
    EURC: env.EURC_TOKEN_CONTRACT!,
    STELLAR: env.STELLAR_TOKEN_CONTRACT!,
  };

  const kp = Keypair.fromSecret(secret);
  const owner = kp.publicKey();
  const server = new rpc.Server(RPC);
  const horizon = new Horizon.Server(HORIZON);
  const acct = await horizon.loadAccount(owner);
  const nativeXlm = parseFloat(acct.balances.find((b) => b.asset_type === "native")?.balance ?? "0");

  console.log("Deployer:", owner);
  console.log("Native XLM:", nativeXlm);

  const symbols = Object.keys(tokens);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) pairs.push([symbols[i], symbols[j]]);
  }

  const existingPool = env.POOL_CONTRACT;
  const created: Array<{ pair: string; pool: string }> = [];

  for (const [symA, symB] of pairs) {
    const contractA = tokens[symA];
    const contractB = tokens[symB];
    const pairLabel = [symA, symB].sort().join("/");
    console.log(`\n━━━ ${pairLabel} ━━━`);

    let poolId = existingPool && pairLabel === "XLM/pUSDC" ? existingPool : "";

    if (!poolId) {
      try {
        const sqrt = initialSqrtPrice(contractA, contractB, PRICES[symA], PRICES[symB]);
        console.log("  create_pool…");
        const result = await callContract(server, kp, factory, "create_pool", [
          new Address(contractA).toScVal(),
          new Address(contractB).toScVal(),
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Medium")]),
          nativeToScVal(sqrt, { type: "u128" }),
        ]);
        poolId = contractIdFromResult(result);
        console.log("  pool:", poolId);
        created.push({ pair: pairLabel, pool: poolId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("pool already exists") || msg.includes("ExistingValue")) {
          poolId = (await getPoolFromFactory(server, factory, contractA, contractB)) ?? "";
          if (!poolId) {
            console.error(
              "  create failed (factory can only deploy one pool until redeployed with fixed salt).",
            );
            console.error("  Run: contracts/build.sh && pnpm --filter @workspace/scripts run redeploy-factory");
            continue;
          }
          console.log("  pool already registered:", poolId);
        } else {
          console.error("  create failed:", msg.slice(0, 200));
          continue;
        }
      }
    } else {
      console.log("  using existing pool:", poolId);
    }

    const liq = await poolLiquidity(server, poolId);
    if (liq > 0n) {
      console.log("  liquidity already seeded:", liq.toString());
      continue;
    }

    const amountA = unitAmount(symA);
    const amountB = unitAmount(symB);
    const { token0, token1, amount0, amount1 } = canonicalizeTokenPair(
      contractA,
      contractB,
      amountA.toString(),
      amountB.toString(),
    );
    const amount0Bn = BigInt(amount0);
    const amount1Bn = BigInt(amount1);

    try {
      if (symA === "pUSDC" || symB === "pUSDC") {
        await ensureMintable(server, kp, tokens.pUSDC, owner, tokens.pUSDC === token0 ? amount0Bn : amount1Bn);
      }
      if (symA === "STELLAR" || symB === "STELLAR") {
        await ensureMintable(server, kp, tokens.STELLAR, owner, tokens.STELLAR === token0 ? amount0Bn : amount1Bn);
      }
      if (symA === "XLM" || symB === "XLM") {
        await ensureWrappedXlm(
          server,
          kp,
          tokens.XLM,
          owner,
          tokens.XLM === token0 ? amount0Bn : amount1Bn,
          nativeXlm,
        );
      }

      const bal0 = await balance(server, token0, owner);
      const bal1 = await balance(server, token1, owner);
      if (bal0 < amount0Bn || bal1 < amount1Bn) {
        console.log(
          `  skip liquidity — insufficient balance (token0 ${bal0}/${amount0Bn}, token1 ${bal1}/${amount1Bn}). ` +
            "For cUSDC/EURC enable trustlines + Circle faucet.",
        );
        continue;
      }

      console.log("  add liquidity…");
      await addLiquidity(server, kp, poolId, token0, token1, amount0Bn, amount1Bn);
      console.log("  ✓ liquidity added");
    } catch (e) {
      console.error("  liquidity failed:", e instanceof Error ? e.message : e);
    }
  }

  if (created.length > 0) {
    const lines = fs.readFileSync(path.join(root, ".env.contracts"), "utf8").split("\n");
    const extra = created.map((c) => `# POOL_${c.pair.replace("/", "_")}=${c.pool}`);
    if (!lines.some((l) => l.startsWith("# Additional pools"))) {
      lines.push("", "# Additional pools (setup-all-pools)", ...extra);
      fs.writeFileSync(path.join(root, ".env.contracts"), lines.join("\n"));
    }
  }

  console.log("\nDone. Restart API and try swaps for any pair with liquidity.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
