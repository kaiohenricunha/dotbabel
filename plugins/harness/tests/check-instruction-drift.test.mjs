import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { checkInstructionDrift } from "../src/check-instruction-drift.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

function isolateFixture() {
  const dst = mkdtempSync(path.join(tmpdir(), "harness-drift-test-"));
  cpSync(FIXTURE_SRC, dst, { recursive: true });
  return dst;
}

function factsPath(root) {
  return path.join(root, "docs", "repo-facts.json");
}

function readFacts(root) {
  return JSON.parse(readFileSync(factsPath(root), "utf8"));
}

function writeFacts(root, obj) {
  writeFileSync(factsPath(root), JSON.stringify(obj, null, 2) + "\n");
}

describe("checkInstructionDrift", () => {
  it("passes when all fields align", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when an instruction file listed in repo-facts does not exist", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    facts.instruction_files = ["CLAUDE.md", "NONEXISTENT.md"];
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /NONEXISTENT\.md/.test(e))).toBe(true);
  });

  it("fails on team_count mismatch — file references different number", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    // Change repo-facts to team_count=5 but CLAUDE.md and README.md still say "2 teams"
    const facts = readFacts(root);
    facts.team_count = 5;
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /team_count|team count|stale/.test(e))).toBe(true);
  });

  it("fails on protected_paths mismatch — repo-facts has new path not documented in CLAUDE.md", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    // Add an undocumented protected path to repo-facts while leaving CLAUDE.md unchanged
    const facts = readFacts(root);
    facts.protected_paths = [
      "CLAUDE.md",
      ".github/workflows/**",
      ".claude/commands/**",
      "docs/secrets/**",
    ];
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /protected_paths|protected path|docs\/secrets/.test(e))).toBe(true);
  });

  it("fails when protected_paths contains a non-string entry", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    facts.protected_paths = ["CLAUDE.md", null, ".claude/commands/**"];
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /protected_paths/.test(e))).toBe(true);
  });

  it("fails when instruction_files is missing from repo-facts", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    delete facts.instruction_files;
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /instruction_files/.test(e))).toBe(true);
  });
});
