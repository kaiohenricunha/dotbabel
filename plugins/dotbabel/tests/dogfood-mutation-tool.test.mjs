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
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** Stryker's own default when a config sets no `jsonReporter.fileName`. */
const STRYKER_DEFAULT_REPORT_PATH = "reports/mutation/mutation.json";

/** The modules TEST-1 puts under a mutation budget (IMPL-6). */
const TEST_1_ROOT = "plugins/dotbabel/src/criteria/";

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"));
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

describe("this repository's declared mutation tool (P-F1)", () => {
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
    const config = (await import(path.join(REPO_ROOT, "stryker.config.mjs"))).default;
    expect(config.reporters).toContain("json");
  });

  it("declares the report path Stryker will really write to", async () => {
    const config = (await import(path.join(REPO_ROOT, "stryker.config.mjs"))).default;
    const written = config.jsonReporter?.fileName ?? STRYKER_DEFAULT_REPORT_PATH;
    expect(javascriptComponent()?.tools?.mutation?.report?.path).toBe(written);
  });

  it("puts the TEST-1 modules inside Stryker's mutate scope", async () => {
    const config = (await import(path.join(REPO_ROOT, "stryker.config.mjs"))).default;
    expect(config.mutate.some((pattern) => pattern.startsWith(TEST_1_ROOT))).toBe(true);
  });

  it("excludes every fan-out skills directory from Stryker's sandbox", async () => {
    // Stryker's sandbox copy does not follow a symlinked directory: one
    // unexcluded fan-out target kills the whole run with EISDIR before a single
    // mutant is scored. The list used to be hand-written, and had already
    // fallen behind the registry by two runtimes.
    const config = (await import(path.join(REPO_ROOT, "stryker.config.mjs"))).default;
    const { skillDirRuntimes, projectSkillsDir } = await import(path.join(REPO_ROOT, "plugins/dotbabel/src/agents.mjs"));
    for (const runtime of skillDirRuntimes()) {
      expect(config.ignorePatterns, `${runtime} fans out to a skills tree Stryker would try to copy`).toContain(projectSkillsDir(runtime));
    }
  });

  it("keeps the mutation report out of version control", () => {
    const written = javascriptComponent()?.tools?.mutation?.report?.path ?? STRYKER_DEFAULT_REPORT_PATH;
    const ignored = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
    expect(ignored.some((line) => line !== "" && !line.startsWith("#") && written.startsWith(line.replace(/^\//, "")))).toBe(true);
  });
});
