/**
 * Add Circle trustlines, print faucet link, re-seed pool liquidity.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
import { CIRCLE_TESTNET_ISSUERS } from "../../artifacts/stellar-dex/src/lib/circle-assets.ts";

async function main() {
  const secret = fs
    .readFileSync(path.join(root, ".env"), "utf8")
    .match(/DEPLOYER_SECRET_KEY=(.+)/)?.[1]
    ?.trim();
  if (!secret) throw new Error("DEPLOYER_SECRET_KEY missing");

  const kp = Keypair.fromSecret(secret);
  const pub = kp.publicKey();
  const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
  let account = await horizon.loadAccount(pub);

  for (const code of ["USDC", "EURC"] as const) {
    const asset = new Asset(code, CIRCLE_TESTNET_ISSUERS[code]);
    const has = account.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        b.asset_code === code &&
        b.asset_issuer === CIRCLE_TESTNET_ISSUERS[code],
    );
    if (!has) {
      console.log(`Adding ${code} trustline…`);
      const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.changeTrust({ asset, limit: "1000000" }))
        .setTimeout(300)
        .build();
      tx.sign(kp);
      await horizon.submitTransaction(tx);
      account = await horizon.loadAccount(pub);
      console.log(`  ✓ ${code} trustline`);
    } else {
      console.log(`${code} trustline already set`);
    }
  }

  console.log(`\nClaim test tokens: https://faucet.circle.com/`);
  console.log(`Wallet: ${pub}`);
  console.log(`Network: Stellar Testnet — request USDC + EURC`);
  console.log(`\nThen run: pnpm --filter @workspace/scripts run deploy-pools`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
