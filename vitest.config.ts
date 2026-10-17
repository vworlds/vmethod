import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Leave CPU capacity for the CLI children, esbuild and neighbouring worktrees.
    maxWorkers: Math.max(1, Math.min(2, Math.floor(availableParallelism() / 2))),
    testTimeout: 15000,
    hookTimeout: 15000,
    teardownTimeout: 15000,
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/offline.ts"],
  },
});
