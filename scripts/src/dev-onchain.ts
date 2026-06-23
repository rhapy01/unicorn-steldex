/**
 * On-chain dev: API + frontend only — no PostgreSQL.
 * Soroban routes build unsigned XDR; market data comes from contract config.
 *
 * Usage: npx tsx scripts/src/dev-onchain.ts
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  loadEnvFile(path.join(root, ".env.contracts"));
  loadEnvFile(path.join(root, ".env"));

  delete process.env.DATABASE_URL;

  console.log("On-chain dev mode (no PostgreSQL)");
  if (process.env.FACTORY_CONTRACT) {
    console.log("Contracts loaded from .env.contracts");
  } else {
    console.log("No .env.contracts — deploy with: pnpm --filter @workspace/scripts run deploy");
  }
  if (process.env.DEPLOYER_SECRET_KEY) {
    console.log("DEPLOYER_SECRET_KEY loaded — pool USDC auto-mint + order keeper enabled");
  }

  console.log("\nBuilding API…");
  const build = spawn("npx", ["pnpm", "--filter", "@workspace/api-server", "run", "build"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: true,
  });
  await new Promise<void>((resolve, reject) => {
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build exited ${code}`))));
  });

  const contractsEnv: Record<string, string> = {};
  const contractsFile = path.join(root, ".env.contracts");
  if (fs.existsSync(contractsFile)) {
    for (const line of fs.readFileSync(contractsFile, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m) contractsEnv[m[1]] = m[2].trim();
    }
  }

  const apiEnv = {
    ...process.env,
    PORT: "8080",
    NODE_ENV: "development",
    ...contractsEnv,
    ...(process.env.DEPLOYER_SECRET_KEY
      ? { DEPLOYER_SECRET_KEY: process.env.DEPLOYER_SECRET_KEY }
      : {}),
  };
  delete apiEnv.DATABASE_URL;

  console.log("\nAPI  → http://localhost:8080");
  console.log("UI   → http://localhost:5000\n");

  const api = spawn("node", ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"], {
    cwd: root,
    env: apiEnv,
    stdio: "inherit",
    shell: true,
  });

  const ui = spawn("npx", ["pnpm", "--filter", "@workspace/stellar-dex", "run", "dev"], {
    cwd: root,
    env: { ...process.env, PORT: "5000", BASE_PATH: "/", API_URL: "http://localhost:8080" },
    stdio: "inherit",
    shell: true,
  });

  const shutdown = () => {
    api.kill();
    ui.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
