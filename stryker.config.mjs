/**
 * Stryker mutation testing (IMPL-6). Each unit of the `qa-verification-harness`
 * spec runs Stryker on only its own TEST-1 modules in its verify step, via
 * `--mutate '<glob for that unit>'` — the `mutate` array below is a fallback
 * for an unscoped run, not the per-unit invocation.
 *
 * The Vitest runner reuses the repository's own `vitest.config.mjs`.
 */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html"],
  thresholds: { high: 90, low: 85, break: 85 },
  mutate: ["plugins/dotbabel/src/criteria/**/*.mjs"],
  tempDirName: ".stryker-tmp",
  // dotbabel fans skills and commands out as symlinks to several CLIs'
  // config directories (`.claude/commands`, `.cli/skills/*`, `.gemini/skills`,
  // `.codex/skills`, and a generated file under `.github/instructions`).
  // Stryker's sandbox copy does not follow a symlinked directory and errors
  // with EISDIR; none of these paths is mutated or read by the criteria
  // tests, so they are excluded from the sandbox copy entirely.
  ignorePatterns: [".claude/commands", ".claude/skills", ".cli", ".gemini/skills", ".codex/skills", ".github/instructions"],
};
