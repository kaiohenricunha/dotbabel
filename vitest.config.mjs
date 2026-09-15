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
    // Tempdir hygiene. Tests that mkdtempSync and never remove the result
    // leaked a directory per call, and at the rate this suite runs (quality
    // check, local-attest, Stryker's per-mutant reruns) that became tens of
    // thousands of directories in /tmp within two days. setupFiles removes
    // what fixtures/temp-dir.mjs hands out; globalSetup points TMPDIR at one
    // per-run parent and removes it whole, catching what spawned CLIs and
    // killed workers leave behind.
    globalSetup: ["plugins/dotbabel/tests/fixtures/temp-root.mjs"],
    setupFiles: ["plugins/dotbabel/tests/fixtures/temp-dir-setup.mjs"],
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
