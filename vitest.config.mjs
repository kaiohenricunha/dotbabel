import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["plugins/dotbabel/tests/**/*.test.mjs"],
    // Many tests shell out to real Node CLIs (execFileSync of dotbabel's own
    // bin scripts), which costs ~2.6-2.9s per test on an idle machine. Against
    // vitest's 5s default that leaves under 2x headroom, so they time out
    // whenever the host is loaded — running the suite twice under
    // `dotbabel quality check` (test + coverage) reproduced 26 such failures
    // while the same suite passes standalone.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      include: [
        "plugins/dotbabel/src/**/*.mjs",
      ],
      exclude: [
        "plugins/dotbabel/src/index.mjs",
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
