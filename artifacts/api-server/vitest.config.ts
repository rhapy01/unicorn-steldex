import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(artifactDir, "../..");

function workspaceAlias(name: string, relEntry: string) {
  return [name, path.resolve(repoRoot, relEntry)] as const;
}

const workspaceAliases = Object.fromEntries([
  workspaceAlias("@workspace/api-zod", "lib/api-zod/src/index.ts"),
  workspaceAlias("@workspace/db", "lib/db/src/index.ts"),
]);

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/vitest.setup.ts"],
  },
});
