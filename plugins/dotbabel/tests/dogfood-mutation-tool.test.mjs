// P-F1: this repository runs the whole harness against itself, so the mutation
// budget TEST-1 declares has to be a tool the harness can actually execute and
// read back here.
//
// Built-in Stryker detection cannot do that job in this repository. It plans
// `./node_modules/.bin/stryker`, a path that does not exist inside a git
// worktree — dependencies resolve upward to the main checkout — so the plan
// lands as `not_configured`, and its own remediation text says to declare a
// project mutation tool instead. `strykerReportPath()` is the second reason:
// it reads `jsonReporter.fileName` only from the JSON config forms, and this
// repository configures Stryker in `stryker.config.mjs`, which would have to be
// executed to read. Both gaps close the same way, and this file guards the
// seams that a silent drift would open.
//
// Every assertion here is about a failure that is INVISIBLE at runtime: a
// report written somewhere the harness does not look resolves through
// `on_unavailable: info`, which reads as a pass rather than as a missing
// measurement.

import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Stryker's own default when a config sets no `jsonReporter.fileName`. */
const STRYKER_DEFAULT_REPORT_PATH = "reports/mutation/mutation.json";

// TEST-1 names six module groups, not one: the criteria tree plus the changed
// parts of pr-gates.mjs, lib/pr-markers.mjs, quality/discovery.mjs,
// quality/evaluate.mjs and quality/reports.mjs. Only the criteria tree has a
// standing mutate scope; the other five were mutation-tested by their own
// unit's `--mutate` verify step and have no standing enforcement point. That
// gap is tracked, not asserted here — this constant is deliberately the
// criteria tree alone, and the test name says so.
const CRITERIA_ROOT = "plugins/dotbabel/src/criteria";

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"));
}

/**
 * Import a repository module by path.
 *
 * Node's ESM loader wants a URL for an absolute specifier: on Windows a bare
 * `C:\\...` parses as a `c:` scheme and throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
 *
 * @param {string} relative
 * @returns {Promise<object>}
 */
function importRepoModule(relative) {
  return import(pathToFileURL(path.join(REPO_ROOT, relative)).href);
}

/** This repository's single JavaScript quality component. */
function javascriptComponent() {
  const config = readJson(".dotbabel.json");
  const components = config.quality?.components ?? [];
  return components.find((component) => (component.languages ?? []).includes("javascript"));
}

/**
 * The command a declared tool really runs, with `npm run <script>` expanded
 * through package.json.
 *
 * Asserting on the raw argv would pass against `npm run mutation` even after
 * the script it names was renamed or rewritten to run something else, which is
 * exactly the drift worth catching.
 *
 * @param {string[]} argv
 * @returns {string}
 */
function resolveCommand(argv) {
  if (argv[0] === "npm" && argv[1] === "run" && typeof argv[2] === "string") {
    const script = readJson("package.json").scripts?.[argv[2]];
    if (typeof script !== "string") {
      throw new Error(`.dotbabel.json runs \`npm run ${argv[2]}\`, but package.json declares no such script`);
    }
    return script;
  }
  return argv.join(" ");
}

/**
 * The Stryker config file the declared `mutation` tool really loads.
 *
 * Reading `stryker.config.mjs` unconditionally would test a file the harness
 * does not use.
 *
 * @returns {string}
 */
function harnessConfigPath() {
  const script = resolveCommand(javascriptComponent().tools.mutation.argv);
  const named = script.trim().split(/\s+/).find((token) => token.endsWith(".mjs"));
  return named ?? "stryker.config.mjs";
}

describe("this repository's declared mutation tool (P-F1)", () => {
  it("runs Stryker through a config that sets no break threshold", async () => {
    // `break` and a parsed report are mutually exclusive: quality/index.mjs:25-35
    // parses a report only on exit 0, so a break threshold would make Stryker's
    // exit code the verdict and the score would never be computed. The floor
    // still applies through mutation.changed_score (quality/policy.mjs:41).
    const config = (await importRepoModule(harnessConfigPath())).default;
    expect(config.thresholds?.break, "a break threshold here hides the mutation score from the harness").toBeUndefined();
  });

  it("keeps the per-unit break threshold on the config IMPL-6 prescribes", async () => {
    // IMPL-6 and docs/specs/model-intelligence TEST-3 both enforce the 85 floor
    // by running `npx stryker run --mutate '<glob>'` directly and reading the
    // exit code. That path must keep breaking.
    const config = (await importRepoModule("stryker.config.mjs")).default;
    expect(config.thresholds?.break).toBe(85);
  });
  it("declares a mutation tool on the JavaScript component that reports stryker-json", () => {
    const mutation = javascriptComponent()?.tools?.mutation;
    expect(mutation, "quality.components[javascript].tools.mutation is not declared").toBeDefined();
    expect(mutation.report?.format).toBe("stryker-json");
  });

  it("runs a command that actually invokes Stryker", () => {
    const mutation = javascriptComponent()?.tools?.mutation;
    expect(resolveCommand(mutation.argv)).toMatch(/\bstryker\b/);
  });

  it("enables the json reporter, without which Stryker writes no report at all", async () => {
    const config = (await importRepoModule(harnessConfigPath())).default;
    expect(config.reporters).toContain("json");
  });

  it("declares the report path Stryker will really write to", async () => {
    const config = (await importRepoModule(harnessConfigPath())).default;
    const written = config.jsonReporter?.fileName ?? STRYKER_DEFAULT_REPORT_PATH;
    expect(javascriptComponent()?.tools?.mutation?.report?.path).toBe(written);
  });

  it("puts every criteria module inside Stryker's mutate scope", async () => {
    // Matching each real file beats `mutate.some(p => p.startsWith(root))`:
    // that predicate stays green after `mutate` narrows to a single file, which
    // is precisely how a mutation budget gets quietly hollowed out.
    const config = (await importRepoModule(harnessConfigPath())).default;
    const modules = fs
      .readdirSync(path.join(REPO_ROOT, CRITERIA_ROOT))
      .filter((entry) => entry.endsWith(".mjs"))
      .map((entry) => `${CRITERIA_ROOT}/${entry}`);
    expect(modules.length, "no criteria modules found — the root moved").toBeGreaterThan(0);
    for (const module of modules) {
      expect(config.mutate.some((pattern) => path.matchesGlob(module, pattern)), `${module} is outside the mutate scope`).toBe(true);
    }
  });

  it("excludes every fan-out skills directory from Stryker's sandbox", async () => {
    // Stryker's sandbox copy does not follow a symlinked directory: one
    // unexcluded fan-out target kills the whole run with EISDIR before a single
    // mutant is scored. The list used to be hand-written, and had already
    // fallen behind the registry by two runtimes.
    const config = (await importRepoModule(harnessConfigPath())).default;
    const { skillDirRuntimes, projectSkillsDir } = await importRepoModule("plugins/dotbabel/src/agents.mjs");
    for (const runtime of skillDirRuntimes()) {
      const dir = projectSkillsDir(runtime);
      // Assert the value is a real path first. `projectSkillsDir` returns null
      // for a runtime declared without `dir`, and `toContain(null)` would pass
      // against a list that spliced that same null in.
      expect(typeof dir, `${runtime} declares no projectFanOut.dir`).toBe("string");
      expect(config.ignorePatterns, `${runtime} fans out to a skills tree Stryker would try to copy`).toContain(dir);
    }
  });

  it("keeps the mutation report out of version control", () => {
    // Ask git rather than doing prefix arithmetic on .gitignore: a prefix match
    // cannot see a later `!`-negation un-ignoring the file, and it rejects a
    // perfectly valid rewrite of the rule into a glob form.
    const written = javascriptComponent()?.tools?.mutation?.report?.path ?? STRYKER_DEFAULT_REPORT_PATH;
    const result = spawnSync("git", ["check-ignore", "-q", "--no-index", written], { cwd: REPO_ROOT });
    expect(result.status, `${written} is not ignored by git`).toBe(0);
  });
});
