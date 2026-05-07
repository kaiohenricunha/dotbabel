import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { checkInstructionDrift } from "../src/check-instruction-drift.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

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

  it("emits DRIFT_INSTRUCTION_FILE_MISSING when a listed instruction file does not exist", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    facts.instruction_files = ["CLAUDE.md", "NONEXISTENT.md"];
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    for (const err of result.errors) expect(err).toBeInstanceOf(ValidationError);
    expect(result.errors.some((e) => e.code === ERROR_CODES.DRIFT_INSTRUCTION_FILE_MISSING && /NONEXISTENT\.md/.test(e.message))).toBe(true);
  });

  it("emits DRIFT_TEAM_COUNT on team_count mismatch", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    facts.team_count = 5;
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.DRIFT_TEAM_COUNT)).toBe(true);
    expect(result.errors.some((e) => /team_count|team count|stale/.test(e))).toBe(true);
  });

  it("emits DRIFT_PROTECTED_PATH when repo-facts has a path not documented in CLAUDE.md", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
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
    expect(result.errors.some((e) => e.code === ERROR_CODES.DRIFT_PROTECTED_PATH)).toBe(true);
    expect(result.errors.some((e) => /protected_paths|protected path|docs\/secrets/.test(e))).toBe(true);
  });

  it("defaults rule_floor_files to instruction_files for backward compatibility", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    delete facts.rule_floor_files;
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === ERROR_CODES.DRIFT_PROTECTED_PATH &&
          e.file === "README.md",
      ),
    ).toBe(true);
  });

  it("emits DRIFT_INSTRUCTION_FILES when rule_floor_files is invalid", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    facts.rule_floor_files = [];
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === ERROR_CODES.DRIFT_INSTRUCTION_FILES &&
          e.pointer === "rule_floor_files",
      ),
    ).toBe(true);
  });

  it("emits DRIFT_PROTECTED_PATH when protected_paths contains a non-string entry", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    facts.protected_paths = ["CLAUDE.md", null, ".claude/commands/**"];
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.DRIFT_PROTECTED_PATH)).toBe(true);
    expect(result.errors.some((e) => /protected_paths/.test(e))).toBe(true);
  });

  it("emits DRIFT_INSTRUCTION_FILES when instruction_files is missing from repo-facts", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    delete facts.instruction_files;
    writeFacts(root, facts);
    const result = checkInstructionDrift(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.DRIFT_INSTRUCTION_FILES)).toBe(true);
    expect(result.errors.some((e) => /instruction_files/.test(e))).toBe(true);
  });
});
