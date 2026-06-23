/**
 * StellarSwap Contract Deployment Script
 *
 * Deploys all 5 Soroban contracts to Stellar Testnet in the correct order:
 *   token × 2 → factory → router → farm → create XLM/USDC pool
 *
 * Usage:
 *   DEPLOYER_SECRET_KEY=S... pnpm --filter @workspace/scripts run deploy
 *
 * Prerequisites:
 *   1. Build contracts first:  ./contracts/build.sh
 *   2. A funded testnet keypair — create one at:
 *      https://laboratory.stellar.org/#account-creator?network=testnet
 */

import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  rpc,
  Contract,
  nativeToScVal,
  Address,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createHash, randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TESTNET_PASSPHRASE = Networks.TESTNET;
const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
const WASM_DIRS = [
  path.join(__dirname, "../../contracts/target/wasm32v1-none/release"),
  path.join(__dirname, "../../contracts/target/wasm32-unknown-unknown/release"),
];
const OUTPUT_FILE = path.join(__dirname, "../../.env.contracts");

const server = new rpc.Server(SOROBAN_RPC_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readWasm(name: string): Buffer {
  for (const dir of WASM_DIRS) {
    const p = path.join(dir, `${name}.wasm`);
    if (fs.existsSync(p)) return fs.readFileSync(p);
  }
  throw new Error(`WASM not found for ${name}. Run cargo build --target wasm32v1-none --release`);
}

async function sendAndWait(
  deployer: InstanceType<typeof Keypair>,
  build: (account: rpc.Api.GetAccountResponse) => TransactionBuilder
): Promise<rpc.Api.GetTransactionResponse> {
  const account = await server.getAccount(deployer.publicKey());
  const tx = build(account as unknown as rpc.Api.GetAccountResponse).build();
  const prepared = await server.prepareTransaction(tx);
  (prepared as ReturnType<TransactionBuilder["build"]> & { sign: (kp: typeof deployer) => void }).sign(deployer);

  const submission = await server.sendTransaction(prepared);
  if (submission.status === "ERROR") {
    throw new Error(`Transaction error: ${JSON.stringify(submission.errorResult)}`);
  }
  console.log(`  Submitted: ${submission.hash}`);

  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const result = await server.getTransaction(submission.hash);
    if (result.status === "SUCCESS") {
      console.log(`  ✓ Confirmed: ${submission.hash}`);
      return result;
    }
    if (result.status === "FAILED") {
      throw new Error(`Transaction FAILED: ${submission.hash}`);
    }
  }
  throw new Error(`Transaction timed out: ${submission.hash}`);
}

async function uploadWasm(deployer: InstanceType<typeof Keypair>, wasm: Buffer): Promise<string> {
  const result = await sendAndWait(deployer, (account) =>
    new TransactionBuilder(account as Parameters<typeof TransactionBuilder>[0], {
      fee: "1000000",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(Operation.uploadContractWasm({ wasm: new Uint8Array(wasm) }))
      .setTimeout(300)
  );
  void result;
  return createHash("sha256").update(wasm).digest("hex");
}

async function createContract(
  deployer: InstanceType<typeof Keypair>,
  wasmHash: string
): Promise<string> {
  const salt = randomBytes(32);
  const result = await sendAndWait(deployer, (account) =>
    new TransactionBuilder(account as Parameters<typeof TransactionBuilder>[0], {
      fee: "1000000",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(
        Operation.createCustomContract({
          address: new Address(deployer.publicKey()),
          wasmHash: Buffer.from(wasmHash, "hex"),
          salt,
        })
      )
      .setTimeout(300)
  );
  const contractIdHex =
    (result as { returnValue?: xdr.ScVal }).returnValue?.address()?.contractId().toString("hex") ?? "";
  return toContractStrkey(contractIdHex);
}

async function callContract(
  deployer: InstanceType<typeof Keypair>,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<rpc.Api.GetTransactionResponse> {
  const contract = new Contract(contractId);
  return sendAndWait(deployer, (account) =>
    new TransactionBuilder(account as Parameters<typeof TransactionBuilder>[0], {
      fee: "1000000",
      networkPassphrase: TESTNET_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(300)
  );
}

function contractIdFromResult(result: rpc.Api.GetTransactionResponse): string {
  const retval = (result as { returnValue?: xdr.ScVal }).returnValue;
  if (!retval) {
    throw new Error("Transaction succeeded but returned no contract address");
  }
  return toContractStrkey(retval.address().contractId().toString("hex"));
}

async function fundAccount(address: string): Promise<void> {
  try {
    const res = await fetch(`https://friendbot.stellar.org?addr=${address}`);
    if (res.ok) console.log(`  Funded via Friendbot: ${address}`);
    else console.log(`  Friendbot: ${res.status} (account may already be funded)`);
  } catch {
    console.log("  Friendbot unavailable — account should already be funded");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toContractStrkey(id: string): string {
  if (!id) return "";
  if (id.startsWith("C")) return id;
  return StrKey.encodeContract(Buffer.from(id, "hex"));
}

// ---------------------------------------------------------------------------
// Main deployment flow
// ---------------------------------------------------------------------------

async function main() {
  const secretKey = process.env.DEPLOYER_SECRET_KEY;
  if (!secretKey) {
    console.error("\nMissing DEPLOYER_SECRET_KEY environment variable.");
    console.error("Get a funded testnet key at: https://laboratory.stellar.org/#account-creator?network=testnet");
    process.exit(1);
  }

  const deployer = Keypair.fromSecret(secretKey);
  console.log(`\nDeployer: ${deployer.publicKey()}`);
  console.log(`Network:  Testnet (${TESTNET_PASSPHRASE})`);

  console.log("\n━━━ Step 1: Funding deployer ━━━");
  await fundAccount(deployer.publicKey());
  await sleep(2000);

  console.log("\n━━━ Step 2: Uploading WASMs ━━━");
  const tokenWasm = readWasm("stellar_swap_token");
  const factoryWasm = readWasm("stellar_swap_factory");
  const poolWasm = readWasm("stellar_swap_pool");
  const routerWasm = readWasm("stellar_swap_router");
  const farmWasm = readWasm("stellar_swap_farm");

  console.log("  Uploading token.wasm...");
  const tokenHash = await uploadWasm(deployer, tokenWasm);

  console.log("  Uploading factory.wasm...");
  const factoryHash = await uploadWasm(deployer, factoryWasm);

  console.log("  Uploading pool.wasm...");
  const poolHash = await uploadWasm(deployer, poolWasm);

  console.log("  Uploading router.wasm...");
  const routerHash = await uploadWasm(deployer, routerWasm);

  console.log("  Uploading farm.wasm...");
  const farmHash = await uploadWasm(deployer, farmWasm);

  console.log("\n━━━ Step 3: Deploying STELLAR governance token ━━━");
  const stellarTokenId = await createContract(deployer, tokenHash);
  await callContract(deployer, stellarTokenId, "initialize", [
    new Address(deployer.publicKey()).toScVal(),
    nativeToScVal(7, { type: "u32" }),
    nativeToScVal("StellarSwap Token"),
    nativeToScVal("STELLAR"),
  ]);
  console.log(`  STELLAR token: ${stellarTokenId}`);

  const CIRCLE_USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  const CIRCLE_EURC_SAC = "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ";

  console.log("\n━━━ Step 4: Deploying custom USDC (pool token) ━━━");
  const usdcTokenId = await createContract(deployer, tokenHash);
  await callContract(deployer, usdcTokenId, "initialize", [
    new Address(deployer.publicKey()).toScVal(),
    nativeToScVal(6, { type: "u32" }),
    nativeToScVal("USD Coin"),
    nativeToScVal("USDC"),
  ]);
  console.log(`  Custom USDC (pool): ${usdcTokenId}`);
  console.log(`  Circle USDC SAC:    ${CIRCLE_USDC_SAC}`);
  console.log(`  Circle EURC SAC:    ${CIRCLE_EURC_SAC}`);

  console.log("\n━━━ Step 5: Deploying Factory ━━━");
  const factoryId = await createContract(deployer, factoryHash);
  await callContract(deployer, factoryId, "initialize", [
    new Address(deployer.publicKey()).toScVal(),
    nativeToScVal(Buffer.from(poolHash, "hex"), { type: "bytes" }),
  ]);
  console.log(`  Factory: ${factoryId}`);

  console.log("\n━━━ Step 6: Deploying Router ━━━");
  const routerId = await createContract(deployer, routerHash);
  await callContract(deployer, routerId, "initialize", [
    new Address(factoryId).toScVal(),
    new Address(deployer.publicKey()).toScVal(),
  ]);
  console.log(`  Router: ${routerId}`);

  console.log("\n━━━ Step 7: Deploying Farm ━━━");
  const farmId = await createContract(deployer, farmHash);
  await callContract(deployer, farmId, "initialize", [
    new Address(deployer.publicKey()).toScVal(),
    new Address(stellarTokenId).toScVal(),
  ]);
  console.log(`  Farm: ${farmId}`);

  console.log("\n━━━ Step 8: Creating XLM/USDC pool via Factory ━━━");
  const XLM_WRAPPED = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const poolResult = await callContract(deployer, factoryId, "create_pool", [
    new Address(usdcTokenId).toScVal(),
    new Address(XLM_WRAPPED).toScVal(),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Medium")]),
    nativeToScVal(BigInt(Math.floor(Math.sqrt(0.13) * 2 ** 32)), { type: "u128" }),
  ]);
  const poolId = contractIdFromResult(poolResult);
  console.log(`  XLM/USDC pool: ${poolId}`);

  console.log("\n━━━ Step 9: Minting initial test tokens ━━━");
  await callContract(deployer, stellarTokenId, "mint", [
    new Address(deployer.publicKey()).toScVal(),
    nativeToScVal(BigInt("10000000000000"), { type: "i128" }),
  ]);
  await callContract(deployer, usdcTokenId, "mint", [
    new Address(deployer.publicKey()).toScVal(),
    nativeToScVal(BigInt("1000000000000"), { type: "i128" }),
  ]);
  console.log("  Circle USDC/EURC: use trustlines + https://faucet.circle.com/");

  console.log("\n━━━ Step 10: Funding farm rewards ━━━");
  await callContract(deployer, farmId, "set_reward_rate", [
    new Address(poolId).toScVal(),
    nativeToScVal(BigInt("1000000000"), { type: "u128" }),
  ]);
  await callContract(deployer, farmId, "fund", [
    new Address(deployer.publicKey()).toScVal(),
    nativeToScVal(BigInt("1000000000000"), { type: "u128" }),
  ]);

  const factoryAddr = factoryId;
  const routerAddr = routerId;
  const farmAddr = farmId;
  const poolAddr = poolId;
  const stellarAddr = stellarTokenId;
  const usdcAddr = usdcTokenId;

  // Write contract addresses to env file (C... strkey format for API + Freighter)
  const envContent = [
    `# StellarSwap Deployed Contract Addresses (Testnet)`,
    `# Generated: ${new Date().toISOString()}`,
    `FACTORY_CONTRACT=${factoryAddr}`,
    `ROUTER_CONTRACT=${routerAddr}`,
    `FARM_CONTRACT=${farmAddr}`,
    `POOL_CONTRACT=${poolAddr}`,
    `XLM_TOKEN_CONTRACT=${XLM_WRAPPED}`,
    `STELLAR_TOKEN_CONTRACT=${stellarAddr}`,
    `USDC_TOKEN_CONTRACT=${usdcAddr}`,
    `CIRCLE_USDC_TOKEN_CONTRACT=${CIRCLE_USDC_SAC}`,
    `EURC_TOKEN_CONTRACT=${CIRCLE_EURC_SAC}`,
    ``,
  ].join("\n");

  fs.writeFileSync(OUTPUT_FILE, envContent);

  console.log("\n✅ Deployment complete!");
  console.log("Contract addresses:");
  console.log(`  Factory:        ${factoryId}`);
  console.log(`  Router:         ${routerId}`);
  console.log(`  Farm:           ${farmId}`);
  console.log(`  XLM/USDC pool:  ${poolId}`);
  console.log(`  STELLAR token:  ${stellarTokenId}`);
  console.log(`  USDC token:     ${usdcTokenId}`);
  console.log(`\nAddresses written to: ${OUTPUT_FILE}`);
  console.log("Set these as environment variables in the API server to enable live transactions.");
}

main().catch((e: Error) => {
  console.error("\n❌ Deployment failed:", e.message);
  process.exit(1);
});
