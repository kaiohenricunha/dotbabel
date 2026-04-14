import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import {
  createHarnessContext,
  loadFacts,
  listSpecDirs,
  anyPathMatches,
  listRepoPaths,
  getChangedFiles,
} from "../src/spec-harness-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "minimal-repo");

describe("createHarnessContext", () => {
  it("accepts an explicit repoRoot and resolves derived paths", () => {
    const ctx = createHarnessContext({ repoRoot: FIXTURE });
    expect(ctx.repoRoot).toBe(FIXTURE);
    expect(ctx.specsRoot).toBe(path.join(FIXTURE, "docs", "specs"));
    expect(ctx.manifestPath).toBe(path.join(FIXTURE, ".claude", "skills-manifest.json"));
    expect(ctx.factsPath).toBe(path.join(FIXTURE, "docs", "repo-facts.json"));
  });

  it("resolves repoRoot from HARNESS_REPO_ROOT env when no arg passed", () => {
    const prev = process.env.HARNESS_REPO_ROOT;
    process.env.HARNESS_REPO_ROOT = FIXTURE;
    try {
      const ctx = createHarnessContext();
      expect(ctx.repoRoot).toBe(FIXTURE);
    } finally {
      if (prev === undefined) delete process.env.HARNESS_REPO_ROOT;
      else process.env.HARNESS_REPO_ROOT = prev;
    }
  });
});

describe("loadFacts", () => {
  it("reads docs/repo-facts.json from the repoRoot", () => {
    const ctx = createHarnessContext({ repoRoot: FIXTURE });
    const facts = loadFacts(ctx);
    expect(facts.team_count).toBe(2);
    expect(facts.protected_paths).toContain("CLAUDE.md");
  });
});

describe("listSpecDirs", () => {
  it("lists one spec in the fixture", () => {
    const ctx = createHarnessContext({ repoRoot: FIXTURE });
    expect(listSpecDirs(ctx)).toEqual(["example-spec"]);
  });
});

describe("anyPathMatches", () => {
  it("matches glob patterns", () => {
    expect(anyPathMatches(".claude/commands/**", [".claude/commands/example.md"])).toBe(true);
    expect(anyPathMatches(".claude/commands/**", ["src/App.jsx"])).toBe(false);
  });

  it("matches bare-path prefixes without globs", () => {
    expect(anyPathMatches("docs/specs/example-spec", ["docs/specs/example-spec/spec.json"])).toBe(true);
  });
});

describe("listRepoPaths", () => {
  it("returns repo-relative POSIX paths, skipping ignored directories", () => {
    const ctx = createHarnessContext({ repoRoot: FIXTURE });
    const paths = listRepoPaths(ctx);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".claude/commands/example.md");
    expect(paths).toContain("docs/specs/example-spec/spec.json");
    // Ignored top-level (example: node_modules) must not appear
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });
});

describe("silent-catch replacement (debug-gated)", () => {
  // These tests exercise the post-fix behavior of the two former `catch {}` blocks
  // in spec-harness-lib.mjs. Previously they swallowed errors unconditionally;
  // now they route through `debug()` (HARNESS_DEBUG=1) while preserving the
  // same fallback return value so behavior is backwards-compatible.

  it("getChangedFiles short-circuits to HARNESS_CHANGED_FILES csv (no git probe required)", () => {
    const prev = process.env.HARNESS_CHANGED_FILES;
    process.env.HARNESS_CHANGED_FILES = "a.md,b.js,";
    try {
      expect(getChangedFiles()).toEqual(["a.md", "b.js"]);
    } finally {
      if (prev === undefined) delete process.env.HARNESS_CHANGED_FILES;
      else process.env.HARNESS_CHANGED_FILES = prev;
    }
  });

  it("createHarnessContext fallback chain surfaces an Error when no repoRoot can be resolved (subprocess run in non-git dir)", () => {
    const nonGitDir = mkdtempSync(path.join(tmpdir(), "non-git-"));
    const libPath = path.resolve(__dirname, "..", "src", "spec-harness-lib.mjs");
    const libUrl = pathToFileURL(libPath).href;
    const probe = `import('${libUrl}').then(m => { try { m.createHarnessContext(); console.log('NO_THROW'); } catch (e) { console.log('THROWN:' + e.message); } });`;
    const out = execFileSync(process.execPath, ["-e", probe], {
      cwd: nonGitDir,
      env: { ...process.env, HARNESS_REPO_ROOT: "" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(out).toMatch(/THROWN:.*repoRoot not provided/);
  });

  it("getChangedFiles returns [] when git diff fails (subprocess run in non-git dir)", () => {
    const nonGitDir = mkdtempSync(path.join(tmpdir(), "no-git-diff-"));
    const libPath = path.resolve(__dirname, "..", "src", "spec-harness-lib.mjs");
    const libUrl = pathToFileURL(libPath).href;
    const probe = `import('${libUrl}').then(m => { const r = m.getChangedFiles(); console.log('RESULT:' + JSON.stringify(r)); });`;
    const out = execFileSync(process.execPath, ["-e", probe], {
      cwd: nonGitDir,
      env: { ...process.env, HARNESS_CHANGED_FILES: "", GITHUB_BASE_REF: "definitely-not-a-real-ref-xyzzy" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(out).toMatch(/RESULT:\[\]/);
  });
});
