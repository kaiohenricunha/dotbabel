import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { runQualityCheck } from "../src/quality/index.mjs";

const dirs = [];
const qualityBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/dotbabel-quality.mjs");
function repository({ missingReport = false, crashingCoverage = false } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-index-"));
  dirs.push(repoRoot);
  fs.mkdirSync(path.join(repoRoot, "coverage"));
  const coverageScript = crashingCoverage
    ? "process.exit(1)"
    : missingReport
    ? "process.exit(0)"
    : "require('node:fs').writeFileSync('coverage/lcov.info', 'SF:index.js\\nDA:1,1\\nDA:2,1\\nend_of_record\\n')";
  fs.writeFileSync(path.join(repoRoot, ".dotbabel.json"), JSON.stringify({ quality: {
    base_ref: "main",
    components: [{ root: ".", languages: ["javascript"], tools: {
      lint: { argv: ["node", "-e", "process.exit(0)"] },
      coverage: { argv: ["node", "-e", coverageScript], report: { format: "lcov", path: "coverage/lcov.info" } },
    } }],
  } }));
  fs.writeFileSync(path.join(repoRoot, "index.js"), "const first = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoRoot, "add", "."]);
  execFileSync("git", ["-C", repoRoot, "commit", "-qm", "base"]);
  fs.appendFileSync(path.join(repoRoot, "index.js"), "const second = 2;\n");
  return repoRoot;
}

function criticalRepository() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-critical-"));
  dirs.push(repoRoot);
  fs.writeFileSync(path.join(repoRoot, ".dotbabel.json"), JSON.stringify({ quality: {
    base_ref: "main",
    critical_paths: ["critical/**"],
    components: [{ root: ".", languages: ["javascript"], tools: {
      test: { argv: ["node", "-e", "process.exit(1)"] },
    } }],
  } }));
  fs.mkdirSync(path.join(repoRoot, "critical"));
  fs.writeFileSync(path.join(repoRoot, "critical", "value.js"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoRoot, "add", "."]);
  execFileSync("git", ["-C", repoRoot, "commit", "-qm", "base"]);
  fs.appendFileSync(path.join(repoRoot, "critical", "value.js"), "export const changed = 2;\n");
  return repoRoot;
}

function criticalMultiComponentRepository() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-critical-components-"));
  dirs.push(repoRoot);
  fs.writeFileSync(path.join(repoRoot, ".dotbabel.json"), JSON.stringify({ quality: {
    base_ref: "main",
    critical_paths: ["api/**"],
  } }));
  for (const root of ["api", "web"]) {
    fs.mkdirSync(path.join(repoRoot, root));
    fs.writeFileSync(path.join(repoRoot, root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    fs.writeFileSync(path.join(repoRoot, root, "index.js"), `export const value = "${root}";\n`);
  }
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoRoot, "add", "."]);
  execFileSync("git", ["-C", repoRoot, "commit", "-qm", "base"]);
  fs.appendFileSync(path.join(repoRoot, "api", "index.js"), "export const changed = true;\n");
  return repoRoot;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("quality check orchestration", () => {
  it("fast profile exits 1 when an escalated test fails", () => {
    const repoRoot = criticalRepository();
    const execution = spawnSync(process.execPath, [
      qualityBin,
      "check",
      "--repo", repoRoot,
      "--profile", "fast",
      "--base", "main",
      "--allow-project-commands",
      "--json",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    const result = JSON.parse(execution.stdout);
    expect(execution.status).toBe(1);
    expect(result.results.find((item) => item.rule === "correctness.tests")).toMatchObject({ verdict: "fail" });
  });

  it("lists critical_matches in the check envelope", async () => {
    const repoRoot = criticalRepository();
    const result = await runQualityCheck({
      repoRoot,
      profile: "fast",
      base: "main",
      allowProjectCommands: true,
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    expect(result.critical_matches).toEqual(["critical/value.js"]);
  });

  it("lists every component represented by a critically escalated plan", async () => {
    const repoRoot = criticalMultiComponentRepository();
    const result = await runQualityCheck({
      repoRoot,
      profile: "fast",
      base: "main",
      paths: ["api"],
      allowProjectCommands: true,
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    expect(result.components.map((component) => component.id)).toEqual(["api:javascript", "web:javascript"]);
    expect(result.executions.every((execution) => result.components.some((component) => component.id === execution.componentId))).toBe(true);
  });

  it("returns immediately for a disabled policy", async () => {
    const result = await runQualityCheck({ policy: { enabled: false, default_profile: "fast" } });
    expect(result).toMatchObject({ schema_version: 1, command: "check", state: "disabled", verdict: "pass" });
  });

  it("runs configured tools and evaluates changed coverage", async () => {
    const repoRoot = repository();
    const result = await runQualityCheck({
      repoRoot,
      profile: "pr",
      base: "main",
      allowProjectCommands: true,
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    expect(result.executions.some((item) => item.capability === "lint" && item.exitCode === 0)).toBe(true);
    expect(result.results.find((item) => item.rule === "coverage.changed_lines")).toMatchObject({ actual: 100, verdict: "pass" });
    expect(result.results.find((item) => item.rule === "size.file_loc")).toMatchObject({ verdict: "pass" });
  });

  it("treats a missing configured report as an environment failure", async () => {
    const repoRoot = repository({ missingReport: true });
    const result = await runQualityCheck({
      repoRoot,
      profile: "pr",
      base: "main",
      allowProjectCommands: true,
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    expect(result.environment_error).toBe(true);
    expect(result.results.find((item) => item.rule === "coverage.changed_lines")).toMatchObject({ state: "unavailable", verdict: "fail" });
  });

  it("labels a path-scoped run in the result envelope", async () => {
    const repoRoot = repository();
    const result = await runQualityCheck({
      repoRoot,
      profile: "fast",
      base: "main",
      paths: ["index.js"],
      allowProjectCommands: true,
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    expect(result.path_scope).toEqual(["index.js"]);
    expect(result.all_files).toBe(false);
  });

  it("reports an empty path scope for a full run", async () => {
    const repoRoot = repository();
    const result = await runQualityCheck({
      repoRoot,
      profile: "fast",
      base: "main",
      allowProjectCommands: true,
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    expect(result.path_scope).toEqual([]);
    expect(result.all_files).toBe(false);
  });

  it("reads the working-tree baseline in the whole-repository mode", async () => {
    const repoRoot = repository();
    const result = await runQualityCheck({
      repoRoot,
      profile: "pr",
      all: true,
      allowProjectCommands: true,
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    expect(result.all_files).toBe(true);
    expect(result.scope.mergeBase).toBeNull();
  });

  it("treats a crashing coverage command as an environment failure instead of not-configured", async () => {
    const repoRoot = repository({ crashingCoverage: true });
    const result = await runQualityCheck({
      repoRoot,
      profile: "pr",
      base: "main",
      allowProjectCommands: true,
      env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
    });
    expect(result.environment_error).toBe(true);
    expect(result.results.find((item) => item.rule === "coverage.changed_lines")).toMatchObject({ state: "unavailable", verdict: "fail" });
    expect(result.results.find((item) => item.rule === "coverage.changed_lines")).not.toMatchObject({ state: "not_configured" });
  });
});

// --- P-C4: mutation scoring end to end (KD-7, REL-11) ---------------------

function mutationRepository(mutantLines) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-mutation-"));
  dirs.push(repoRoot);
  // A project-declared mutation tool: the command writes the report, so this
  // exercises the real parse → score → evaluate path rather than a stub.
  const report = JSON.stringify({ schemaVersion: "1.0", files: { "index.js": { mutants: mutantLines.map(([line, status], id) => ({ id: `${id}`, mutatorName: "ArithmeticOperator", status, location: { start: { line, column: 1 }, end: { line, column: 9 } } })) } } });
  fs.writeFileSync(path.join(repoRoot, ".dotbabel.json"), JSON.stringify({ quality: {
    base_ref: "main",
    components: [{ root: ".", languages: ["javascript"], tools: {
      mutation: { argv: ["node", "-e", `require('node:fs').writeFileSync('mutation.json', ${JSON.stringify(report)})`], report: { format: "stryker-json", path: "mutation.json" } },
    } }],
  } }));
  fs.writeFileSync(path.join(repoRoot, "index.js"), "const first = 1;\n");
  execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoRoot, "add", "."]);
  execFileSync("git", ["-C", repoRoot, "commit", "-qm", "base"]);
  // Line 2 is the only changed line.
  fs.appendFileSync(path.join(repoRoot, "index.js"), "const second = 2;\n");
  return repoRoot;
}

// Two results carry the `mutation.changed_score` rule: one from the EXECUTION
// (did the command run and exit 0) and one from the parsed METRIC. Only the
// metric carries a `key`, so select on that rather than on position.
const mutationMetric = (result) => result.results.find((item) => item.rule === "mutation.changed_score" && item.key);

const runMutation = (repoRoot) => runQualityCheck({
  repoRoot,
  profile: "deep",
  base: "main",
  allowProjectCommands: true,
  env: { PATH: process.env.PATH, HOME: repoRoot, XDG_CONFIG_HOME: path.join(repoRoot, ".config") },
});

describe("mutation scoring", () => {
  it("scores a mutation report against the changed lines only", async () => {
    // Line 2 changed. Two mutants there (one killed), one on unchanged line 1
    // — which would lift the score to 66.7 if scope were ignored.
    const result = await runMutation(mutationRepository([[2, "Killed"], [2, "Survived"], [1, "Killed"]]));
    const metric = mutationMetric(result);
    expect(metric).toMatchObject({ state: "checked", actual: 50, detected: 1, valid: 2 });
    expect(metric.verdict).toBe("fail"); // 50 is under the 85 budget
  });

  it("reports mutation as not_applicable when no mutant lands on a changed line", async () => {
    // REL-11: nothing to mutate is not a failed budget. A zero here would
    // block every pull request whose diff happens to miss the mutated lines.
    const result = await runMutation(mutationRepository([[1, "Killed"], [1, "Survived"]]));
    const metric = mutationMetric(result);
    expect(metric).toMatchObject({ state: "not_applicable", verdict: "info" });
    expect(metric.actual).toBeUndefined();
    expect(metric.message).toMatch(/no mutant starts on a changed line/);
  });
});
