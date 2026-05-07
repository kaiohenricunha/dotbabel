import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { checkInstructionsFresh } from "../src/check-instructions-fresh.mjs";
import {
  generateInstructions,
  RULE_FLOOR_BEGIN,
  RULE_FLOOR_END,
} from "../src/generate-instructions.mjs";
import { ERROR_CODES } from "../src/lib/errors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

function isolateFixture() {
  const dst = mkdtempSync(path.join(tmpdir(), "harness-fresh-test-"));
  cpSync(FIXTURE_SRC, dst, { recursive: true });
  writeFacts(dst);
  writeClaude(dst, "## Protected Paths");
  return dst;
}

function writeFacts(root) {
  const facts = {
    team_count: 2,
    protected_paths: ["CLAUDE.md"],
    instruction_files: ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".github/copilot-instructions.md"],
    rule_floor_files: ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".github/copilot-instructions.md"],
    cli_substitutions: {},
  };
  writeFileSync(
    path.join(root, "docs", "repo-facts.json"),
    `${JSON.stringify(facts, null, 2)}\n`,
  );
}

function writeClaude(root, heading) {
  writeFileSync(
    path.join(root, "CLAUDE.md"),
    [
      "# CLAUDE.md",
      "",
      "This project has 2 teams.",
      "",
      RULE_FLOOR_BEGIN,
      heading,
      "",
      "- `CLAUDE.md`",
      RULE_FLOOR_END,
      "",
    ].join("\n"),
  );
}

function readFile(root, rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function writeFile(root, rel, body) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
}

describe("checkInstructionsFresh", () => {
  it("passes when generated instruction outputs match a fresh render", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx);

    const result = checkInstructionsFresh(ctx);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when CLAUDE.md changes without regenerating outputs", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx);

    writeClaude(root, "## Updated Protected Paths");

    const result = checkInstructionsFresh(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.DRIFT_GENERATED_STALE)).toBe(true);
  });

  it("passes again after regeneration restores generated outputs", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx);
    writeClaude(root, "## Updated Protected Paths");
    expect(checkInstructionsFresh(ctx).ok).toBe(false);

    generateInstructions(ctx);

    expect(checkInstructionsFresh(ctx).ok).toBe(true);
    expect(readFile(root, "AGENTS.md")).toContain("## Updated Protected Paths");
  });

  it("reports stale hand edits to generated target files", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx);
    writeFile(root, "AGENTS.md", "hand edit\n");

    const result = checkInstructionsFresh(ctx);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === ERROR_CODES.DRIFT_GENERATED_STALE &&
          e.file === "AGENTS.md",
      ),
    ).toBe(true);
  });
});
