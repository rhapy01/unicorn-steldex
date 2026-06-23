/**
 * Test swap via API (quote + multi-step sign/submit as deployer).
 * Usage: npx tsx scripts/src/test-swap.ts [amountXlm]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair, Networks, rpc, TransactionBuilder } from "@stellar/stellar-sdk";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PASSPHRASE = Networks.TESTNET;
const RPC = "https://soroban-testnet.stellar.org";
const API = "http://localhost:8080/api/stellar";

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

async function poll(server: rpc.Server, hash: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const tx = await server.getTransaction(hash);
    if (tx.status === "SUCCESS") return;
    if (tx.status === "FAILED") throw new Error(`tx failed: ${hash}`);
  }
  throw new Error("confirmation timeout");
}

async function main() {
  const env = { ...loadEnv(path.join(root, ".env.contracts")), ...loadEnv(path.join(root, ".env")) };
  const secret = env.DEPLOYER_SECRET_KEY;
  if (!secret) throw new Error("DEPLOYER_SECRET_KEY missing");

  const pUsdc = env.USDC_TOKEN_CONTRACT!;
  const xlm = env.XLM_TOKEN_CONTRACT!;
  const kp = Keypair.fromSecret(secret);
  const wallet = kp.publicKey();
  const amountXlm = process.argv[2] ?? "0.1";
  const amountIn = String(Math.floor(parseFloat(amountXlm) * 1e7));

  console.log("Wallet:", wallet);
  console.log(`Swap: ${amountXlm} XLM -> pUSDC (${amountIn} stroops)`);

  const quoteRes = await fetch(`${API}/swap/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      walletAddress: wallet,
      fromTokenContract: xlm,
      toTokenContract: pUsdc,
      amountIn,
      slippageBps: 50,
    }),
  });
  const quoteText = await quoteRes.text();
  console.log("\nQuote status:", quoteRes.status);
  console.log("Quote:", quoteText.slice(0, 500));
  if (!quoteRes.ok) process.exit(1);

  const swapRes = await fetch(`${API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      walletAddress: wallet,
      fromTokenContract: xlm,
      toTokenContract: pUsdc,
      amountIn,
      slippageBps: 50,
    }),
  });
  const swapText = await swapRes.text();
  console.log("\nSwap build status:", swapRes.status);
  console.log("Swap body:", swapText.slice(0, 1200));
  if (!swapRes.ok) process.exit(1);

  const swapData = JSON.parse(swapText) as {
    steps: Array<{ id: string; label: string }>;
    sequential?: boolean;
    minAmountOut?: string;
  };
  const server = new rpc.Server(RPC);

  for (const step of swapData.steps) {
    console.log(`\nSubmitting step: ${step.id} — ${step.label}`);
    const stepRes = await fetch(`${API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet,
        fromTokenContract: xlm,
        toTokenContract: pUsdc,
        amountIn,
        slippageBps: 50,
        stepId: step.id,
      }),
    });
    const stepText = await stepRes.text();
    if (!stepRes.ok) {
      console.error("Step build failed:", stepText);
      process.exit(1);
    }
    const { xdr } = JSON.parse(stepText) as { xdr: string };
    const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
    tx.sign(kp);
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR" || !sent.hash) {
      throw new Error(sent.errorResultXdr || `send failed for ${step.id}`);
    }
    console.log("  hash:", sent.hash);
    await poll(server, sent.hash);
    console.log("  confirmed");
  }

  console.log("\nSwap complete. minAmountOut:", swapData.minAmountOut);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
