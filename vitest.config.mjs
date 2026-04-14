import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["plugins/harness/tests/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "plugins/harness/src/**/*.mjs",
      ],
      exclude: [
        "plugins/harness/src/index.mjs",
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
