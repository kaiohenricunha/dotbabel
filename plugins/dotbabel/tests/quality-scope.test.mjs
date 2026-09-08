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

  it("narrows changed files and changed lines to the path filter", () => {
    const repoRoot = repo();
    const base = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "a.js"), "const a = 1;\n");
    fs.writeFileSync(path.join(repoRoot, "outside.js"), "const b = 2;\n");

    const scope = resolveQualityScope({ repoRoot, base, env: {}, paths: ["src"] });
    expect(scope.changedFiles.map((file) => file.path)).toEqual(["src/a.js"]);
    expect(Object.keys(scope.changedLines)).toEqual(["src/a.js"]);
    expect(scope.paths).toEqual(["src"]);
    expect(scope.all).toBe(false);
  });

  it("keeps a rename whose source is outside the path filter", () => {
    const repoRoot = repo();
    fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs", "b.js"), "const b = 2;\n");
    execFileSync("git", ["-C", repoRoot, "add", "."]);
    execFileSync("git", ["-C", repoRoot, "commit", "-qm", "add docs"]);
    const base = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    execFileSync("git", ["-C", repoRoot, "mv", "docs/b.js", "src/b.js"]);
    execFileSync("git", ["-C", repoRoot, "commit", "-qm", "move into src"]);

    const scope = resolveQualityScope({ repoRoot, base, env: {}, paths: ["src"] });
    expect(scope.renames).toContainEqual({ from: "docs/b.js", to: "src/b.js" });
  });

  it("returns an empty change set when the path filter matches no changed file", () => {
    const repoRoot = repo();
    const base = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(repoRoot, "outside.js"), "const b = 2;\n");

    const scope = resolveQualityScope({ repoRoot, base, env: {}, paths: ["nowhere"] });
    expect(scope.changedFiles).toEqual([]);
    expect(scope.changedLines).toEqual({});
  });

  it("scopes every repository file without a diff in the whole-repository mode", () => {
    const repoRoot = repo();
    const scope = resolveQualityScope({ repoRoot, all: true, env: {} });
    expect(scope.baseRevision).toBeNull();
    expect(scope.mergeBase).toBeNull();
    expect(scope.all).toBe(true);
    // old.js is committed and unmodified, so a diff-mode run would never see it.
    expect(scope.changedFiles.map((file) => file.path)).toContain("old.js");
    expect(scope.changedLines["old.js"].length).toBeGreaterThan(0);
  });

  it("combines the whole-repository mode with a path filter", () => {
    const repoRoot = repo();
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "a.js"), "const a = 1;\n");

    const scope = resolveQualityScope({ repoRoot, all: true, paths: ["src"], env: {} });
    expect(scope.changedFiles.map((file) => file.path)).toEqual(["src/a.js"]);
  });

  it("resolves without a base revision in the whole-repository mode", () => {
    const repoRoot = repo();
    // Diff mode throws for this repository; whole-repository mode must not.
    expect(() => resolveQualityScope({ repoRoot, base: "missing-ref", env: {} })).toThrow(/base revision/);
    expect(() => resolveQualityScope({ repoRoot, all: true, env: {} })).not.toThrow();
  });
});
