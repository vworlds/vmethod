import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15000,
    hookTimeout: 15000,
    teardownTimeout: 15000,
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/offline.ts"],
  },
});
