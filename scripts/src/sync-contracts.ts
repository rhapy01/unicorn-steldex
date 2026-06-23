/**
 * Sync deployed contract addresses from .env.contracts into the database.
 *
 * Usage: npx tsx scripts/src/sync-contracts.ts
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { db, tokensTable } from "../../lib/db/src/index.ts";
import { eq } from "drizzle-orm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");
const contractsFile = path.join(root, ".env.contracts");

function loadContractsEnv(): Record<string, string> {
  if (!fs.existsSync(contractsFile)) {
    console.log("No .env.contracts file found — nothing to sync.");
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(contractsFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const SYMBOL_MAP: Record<string, string> = {
  XLM_TOKEN_CONTRACT: "XLM",
  USDC_TOKEN_CONTRACT: "USDC",
  STELLAR_TOKEN_CONTRACT: "STELLAR",
};

async function main() {
  const env = loadContractsEnv();
  let updated = 0;

  for (const [envKey, symbol] of Object.entries(SYMBOL_MAP)) {
    const address = env[envKey];
    if (!address) continue;

    const result = await db
      .update(tokensTable)
      .set({ contractAddress: address })
      .where(eq(tokensTable.symbol, symbol))
      .returning({ id: tokensTable.id });

    if (result.length > 0) {
      console.log(`  ${symbol} → ${address}`);
      updated += 1;
    } else {
      console.log(`  ${symbol}: no matching token row (run seed first)`);
    }
  }

  console.log(updated > 0 ? `\nSynced ${updated} token contract address(es).` : "\nNo token rows updated.");
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
