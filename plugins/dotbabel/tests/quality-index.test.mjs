import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runQualityCheck } from "../src/quality/index.mjs";

const dirs = [];
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
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("quality check orchestration", () => {
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
