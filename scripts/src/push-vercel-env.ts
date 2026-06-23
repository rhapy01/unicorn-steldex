/**
 * Push contract addresses from .env.contracts to Vercel (production).
 * Usage: npx tsx scripts/src/push-vercel-env.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnv(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const contracts = loadEnv(path.join(root, ".env.contracts"));
const local = loadEnv(path.join(root, ".env"));
const keys = [
  "FACTORY_CONTRACT",
  "ROUTER_CONTRACT",
  "FARM_CONTRACT",
  "ORDERS_CONTRACT",
  "POOL_CONTRACT",
  "XLM_TOKEN_CONTRACT",
  "USDC_TOKEN_CONTRACT",
  "CIRCLE_USDC_TOKEN_CONTRACT",
  "EURC_TOKEN_CONTRACT",
  "STELLAR_TOKEN_CONTRACT",
  "POOLS_JSON",
  "DEPLOYER_SECRET_KEY",
];

console.log("Pushing env vars to Vercel (production)…\n");

for (const key of keys) {
  const value = contracts[key] ?? local[key];
  if (!value) continue;
  const result = spawnSync(
    "npx",
    ["vercel", "env", "add", key, "production", "--force"],
    {
      cwd: root,
      input: value,
      encoding: "utf8",
      shell: true,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (result.status !== 0) {
    console.error(`Failed to set ${key}`);
    process.exit(1);
  }
  console.log(`  ✓ ${key}`);
}

console.log("\nDone. Redeploy for changes to take effect.");
