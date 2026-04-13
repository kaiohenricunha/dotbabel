import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  createHarnessContext,
  loadFacts,
  listSpecDirs,
  anyPathMatches,
  listRepoPaths,
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
