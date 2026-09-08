import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listRepositoryFiles, matchesPathScope, normalizePathScope } from "../src/quality/paths.mjs";

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-quality-paths-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("matchesPathScope", () => {
  it("treats a glob-free pattern as a directory prefix", () => {
    expect(matchesPathScope(["src/quality"], "src/quality/scope.mjs")).toBe(true);
    expect(matchesPathScope(["src/quality"], "src/quality/adapters/go.mjs")).toBe(true);
  });

  it("does not treat a prefix as a partial directory-name match", () => {
    expect(matchesPathScope(["src/quality"], "src/qualityother/a.mjs")).toBe(false);
  });

  it("matches an exact file path", () => {
    expect(matchesPathScope(["src/a.mjs"], "src/a.mjs")).toBe(true);
    expect(matchesPathScope(["src/a.mjs"], "src/a.mjs.bak")).toBe(false);
  });

  it("delegates a wildcard pattern to the shared glob matcher", () => {
    expect(matchesPathScope(["**/*.mjs"], "a/b.mjs")).toBe(true);
    expect(matchesPathScope(["src/*"], "src/a.mjs")).toBe(true);
    expect(matchesPathScope(["src/*"], "src/a/b.mjs")).toBe(false);
  });

  it("matches every file when no pattern is supplied", () => {
    expect(matchesPathScope([], "anything/at/all.mjs")).toBe(true);
  });
});

describe("normalizePathScope", () => {
  it("normalizes Windows separators and a trailing slash", () => {
    expect(normalizePathScope(["src\\quality\\"])).toEqual(["src/quality"]);
  });

  it("removes duplicates and repository-root patterns", () => {
    expect(normalizePathScope(["src", "./src", ".", "./"])).toEqual(["src"]);
  });

  it("rejects an empty pattern rather than silently widening the run", () => {
    expect(() => normalizePathScope([""])).toThrow(/non-empty/);
  });

  it("rejects an absolute path", () => {
    expect(() => normalizePathScope(["/etc/passwd"])).toThrow(/repository-relative/);
  });

  it("rejects a parent escape", () => {
    expect(() => normalizePathScope(["../secrets"])).toThrow(/escape/);
    expect(() => normalizePathScope(["src/../.."])).toThrow(/escape/);
  });

  it("keeps an interior double-dot that stays inside the repository", () => {
    expect(normalizePathScope(["src/../lib"])).toEqual(["lib"]);
  });

  it("returns an empty list for no input", () => {
    expect(normalizePathScope([])).toEqual([]);
  });
});

describe("listRepositoryFiles", () => {
  it("lists tracked and untracked files in a Git repository", () => {
    const repoRoot = tempDir();
    fs.writeFileSync(path.join(repoRoot, "tracked.js"), "export const a = 1;\n");
    execFileSync("git", ["init", "-q", "-b", "main", repoRoot]);
    execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repoRoot, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", repoRoot, "add", "."]);
    execFileSync("git", ["-C", repoRoot, "commit", "-qm", "base"]);
    fs.writeFileSync(path.join(repoRoot, "untracked.js"), "export const b = 2;\n");

    const files = listRepositoryFiles(repoRoot);
    expect(files).toContain("tracked.js");
    expect(files).toContain("untracked.js");
  });

  it("falls back to a filesystem walk outside a Git repository", () => {
    const repoRoot = tempDir();
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "src", "a.js"), "export const a = 1;\n");
    fs.mkdirSync(path.join(repoRoot, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "node_modules", "skip.js"), "module.exports = 1;\n");

    const files = listRepositoryFiles(repoRoot);
    expect(files).toContain("src/a.js");
    expect(files).not.toContain("node_modules/skip.js");
  });
});
