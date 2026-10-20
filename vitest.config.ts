import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@aflow/engine": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    // `*.typetest.ts` files are type-only; `npm run typecheck` checks them.
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // CLAUDE.md: never more than 2 workers, leave headroom on the host.
    pool: "threads",
    poolOptions: { threads: { minThreads: 1, maxThreads: 2 } },
  },
});
