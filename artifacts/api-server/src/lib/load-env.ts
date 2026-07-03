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

function existingRoots(here: string): string[] {
  return [
    process.cwd(),
    path.join(here, "../../.."), // bundled: dist/index.mjs → repo root
    path.join(here, "../../../.."), // source: src/lib/load-env.ts → repo root
  ].filter(
    (root, index, all) =>
      !!root && all.indexOf(root) === index && fs.existsSync(root),
  );
}

/** Load contract env from repo files and Vercel local env files without overwriting runtime vars. */
export function loadContractEnv(): void {
  if (process.env.SKIP_CONTRACT_ENV === "1" || process.env.VITEST === "true") {
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = existingRoots(here);

  const candidateFiles = roots.flatMap((root) => [
    path.join(root, ".env.contracts"),
    path.join(root, ".env"),
    path.join(root, ".vercel", ".env.production.local"),
    path.join(root, ".vercel", ".env.preview.local"),
    path.join(root, ".vercel", ".env.development.local"),
    path.join(root, ".vercel", ".env.local"),
  ]);

  for (const file of candidateFiles) {
    if (fs.existsSync(file)) loadEnvFile(file);
  }
}
