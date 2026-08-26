import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // CLAUDE.md: never more than 2 workers, leave headroom on the host.
    pool: "threads",
    poolOptions: { threads: { minThreads: 1, maxThreads: 2 } },
  },
});
