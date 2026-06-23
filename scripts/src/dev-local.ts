/**
 * One-command local dev: embedded Postgres → schema push → seed → API + frontend.
 *
 * Usage: npx tsx scripts/src/dev-local.ts
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "../..");

function loadContractsEnv(): Record<string, string> {
  const file = path.join(root, ".env.contracts");
  if (!fs.existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: true,
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function main() {
  let databaseUrl = process.env.DATABASE_URL;
  let pg: { stop: () => Promise<void>; cleanup: () => Promise<void> } | null = null;

  if (!databaseUrl) {
    console.log("No DATABASE_URL set — starting embedded PostgreSQL…");
    const { PostgresInstance } = await import("pg-embedded");
    const instance = new PostgresInstance({
      port: 5433,
      username: "postgres",
      password: "postgres",
      database: "stellarswap",
      persistent: true,
      dataDir: path.join(root, ".local-postgres"),
    });
    await instance.start();
    databaseUrl = instance.connectionInfo.connectionString;
    pg = instance;
    console.log(`Embedded Postgres ready: ${databaseUrl}`);
  }

  process.env.DATABASE_URL = databaseUrl;

  console.log("\nPushing database schema…");
  await run("npx", ["pnpm", "--filter", "@workspace/db", "run", "push"], { DATABASE_URL: databaseUrl });

  const contractsEnv = loadContractsEnv();
  if (Object.keys(contractsEnv).length > 0) {
    console.log("Loaded contract addresses from .env.contracts");
  }

  const envFile = path.join(root, ".env");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^DEPLOYER_SECRET_KEY=(.+)$/);
      if (m && !process.env.DEPLOYER_SECRET_KEY) {
        process.env.DEPLOYER_SECRET_KEY = m[1].trim();
      }
    }
    if (process.env.DEPLOYER_SECRET_KEY) {
      console.log("Loaded DEPLOYER_SECRET_KEY from .env (test USDC faucet enabled)");
    }
  }

  console.log("\nSeeding demo tokens and pools…");
  await run("npx", ["tsx", "scripts/src/seed-db.ts"], { DATABASE_URL: databaseUrl, ...contractsEnv });

  console.log("\nBuilding API server…");
  await run("npx", ["pnpm", "--filter", "@workspace/api-server", "run", "build"], { DATABASE_URL: databaseUrl });

  const sharedEnv = {
    DATABASE_URL: databaseUrl,
    PORT: "8080",
    NODE_ENV: "development",
    ...contractsEnv,
    ...(process.env.DEPLOYER_SECRET_KEY
      ? { DEPLOYER_SECRET_KEY: process.env.DEPLOYER_SECRET_KEY }
      : {}),
  };

  console.log("\nStarting API on http://localhost:8080 …");
  const api = spawn("node", ["--enable-source-maps", "artifacts/api-server/dist/index.mjs"], {
    cwd: root,
    env: { ...process.env, ...sharedEnv },
    stdio: "inherit",
    shell: true,
  });

  console.log("Starting frontend on http://localhost:5000 …\n");
  const ui = spawn("npx", ["pnpm", "--filter", "@workspace/stellar-dex", "run", "dev"], {
    cwd: root,
    env: { ...process.env, PORT: "5000", BASE_PATH: "/", API_URL: "http://localhost:8080" },
    stdio: "inherit",
    shell: true,
  });

  const shutdown = async () => {
    api.kill();
    ui.kill();
    if (pg) {
      await pg.stop();
      await pg.cleanup();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
