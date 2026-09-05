import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveQualityScope } from "../src/quality/scope.mjs";

const dirs = [];
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-scope-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "old.js"), "const a = 1;\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "base"]);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("quality git scope", () => {
  it("includes committed, staged, unstaged, untracked, and renamed files", () => {
    const repoRoot = repo();
    const base = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repoRoot, "mv", "old.js", "new.js"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-qm", "rename"]);
    fs.appendFileSync(path.join(repoRoot, "new.js"), "const b = 2;\n");
    fs.writeFileSync(path.join(repoRoot, "staged.py"), "x = 1\n");
    execFileSync("git", ["-C", repoRoot, "add", "staged.py"]);
    fs.writeFileSync(path.join(repoRoot, "untracked.go"), "package p\n");
    fs.mkdirSync(path.join(repoRoot, "skill"));
    fs.symlinkSync("skill", path.join(repoRoot, "skill-link"));

    const scope = resolveQualityScope({ repoRoot, base, env: {} });
    expect(scope.mergeBase).toBe(base);
    expect(scope.changedFiles.map((file) => file.path)).toEqual(expect.arrayContaining(["new.js", "staged.py", "untracked.go"]));
    expect(scope.renames).toContainEqual({ from: "old.js", to: "new.js" });
    expect(scope.changedLines["new.js"]).toContain(2);
    expect(scope.changedFiles.map((file) => file.path)).toContain("skill-link");
    expect(scope.changedLines["skill-link"]).toEqual([]);
  });

  it("fails visibly when no base can be resolved", () => {
    const repoRoot = repo();
    expect(() => resolveQualityScope({ repoRoot, base: "missing-ref", env: {} })).toThrow(/base revision/);
  });
});
