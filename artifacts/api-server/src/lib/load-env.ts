import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function loadEnvFile(file: string): void {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

/** Load `.env.contracts` and optional `.env` from repo root (does not overwrite existing vars). */
export function loadContractEnv(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [
    process.cwd(),
    path.join(here, "../../.."), // bundled: dist/index.mjs → repo root
    path.join(here, "../../../.."), // source: src/lib/load-env.ts → repo root
  ];
  const root = roots.find((r) => fs.existsSync(path.join(r, ".env.contracts"))) ?? roots[0];

  const contractsFile = path.join(root, ".env.contracts");
  if (fs.existsSync(contractsFile)) loadEnvFile(contractsFile);

  const envFile = path.join(root, ".env");
  if (fs.existsSync(envFile)) loadEnvFile(envFile);
}
