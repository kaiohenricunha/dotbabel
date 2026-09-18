/**
 * Stryker mutation testing (IMPL-6). Each unit of the `qa-verification-harness`
 * spec runs Stryker on only its own TEST-1 modules in its verify step, via
 * `--mutate '<glob for that unit>'` — the `mutate` array below is a fallback
 * for an unscoped run, not the per-unit invocation.
 *
 * The Vitest runner reuses the repository's own `vitest.config.mjs`.
 */
import { skillDirRuntimes, projectSkillsDir } from "./plugins/dotbabel/src/agents.mjs";

export default {
  packageManager: "npm",
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  // `json` is what `dotbabel quality` reads back: the declared mutation tool in
  // `.dotbabel.json` parses this file with the `stryker-json` format. The path
  // is set explicitly rather than left to Stryker's default, because the two
  // have to be stated identically in two places and a silent divergence
  // resolves through `on_unavailable: info` — a missing measurement that reads
  // as a pass. `dogfood-mutation-tool.test.mjs` pins them together.
  reporters: ["clear-text", "progress", "html", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // `break: 85` is IMPL-6's per-unit gate: a unit runs `npx stryker run
  // --mutate '<glob>'` in its verify step and the floor is enforced by the exit
  // code. `docs/specs/model-intelligence` TEST-3 relies on the same mechanism.
  //
  // The harness cannot use this config for that reason — see
  // `stryker.harness.config.mjs`.
  thresholds: { high: 90, low: 85, break: 85 },
  mutate: ["plugins/dotbabel/src/criteria/**/*.mjs"],
  tempDirName: ".stryker-tmp",
  // dotbabel fans skills and commands out as symlinks into several CLIs'
  // config directories. Stryker's sandbox copy does not follow a symlinked
  // directory and dies with EISDIR; none of these paths is mutated or read by
  // the criteria tests, so they are excluded from the sandbox copy entirely.
  //
  // The per-CLI skills directories are derived from the agent registry rather
  // than listed here. A hand-written list silently rots: it was written before
  // the registry gained OpenCode and Antigravity, and the resulting EISDIR on
  // `.opencode/skills` surfaced only when P-F1 first ran Stryker in this
  // repository. Adding a `skills-dir` runtime now updates this automatically.
  ignorePatterns: [
    ".claude/commands",
    ".claude/skills",
    // This repository nests whole checkouts here, each with its own fan-out
    // symlink trees. Stryker does not read `.gitignore`, so a run started from
    // the main checkout would copy every active worktree and hit the same
    // EISDIR on a nested symlink.
    ".claude/worktrees",
    ".cli",
    ".github/instructions",
    // `dir` is optional on a `ProjectFanOut` (`agents.mjs:71-74`), so a runtime
    // declared without one would otherwise splice `null` into this list.
    ...skillDirRuntimes()
      .map((runtime) => projectSkillsDir(runtime))
      .filter(Boolean),
  ],
};
