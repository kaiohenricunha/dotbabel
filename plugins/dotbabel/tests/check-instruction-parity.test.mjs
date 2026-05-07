import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { checkInstructionParity } from "../src/check-instruction-parity.mjs";
import {
  generateInstructions,
  RULE_FLOOR_BEGIN,
  RULE_FLOOR_END,
} from "../src/generate-instructions.mjs";
import { ERROR_CODES } from "../src/lib/errors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

function isolateFixture() {
  const dst = mkdtempSync(path.join(tmpdir(), "harness-parity-test-"));
  cpSync(FIXTURE_SRC, dst, { recursive: true });
  writeFacts(dst);
  writeClaude(dst);
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

function writeClaude(root) {
  writeFileSync(
    path.join(root, "CLAUDE.md"),
    [
      "# CLAUDE.md",
      "",
      "This project has 2 teams.",
      "",
      RULE_FLOOR_BEGIN,
      "## Protected Paths",
      "",
      "- `CLAUDE.md`",
      "",
      "<!-- dotbabel:cli claude -->",
      "## Claude Only",
      "",
      "Only Claude should see this heading.",
      "<!-- dotbabel:end -->",
      RULE_FLOOR_END,
      "",
    ].join("\n"),
  );
}

function readFile(root, rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function writeFile(root, rel, body) {
  writeFileSync(path.join(root, rel), body);
}

describe("checkInstructionParity", () => {
  it("passes when generated target headings match their CLI render", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx);

    const result = checkInstructionParity(ctx);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails when a hand edit removes an applicable generated heading", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx);
    writeFile(
      root,
      "AGENTS.md",
      readFile(root, "AGENTS.md").replace("## Protected Paths\n", ""),
    );

    const result = checkInstructionParity(ctx);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) =>
          e.code === ERROR_CODES.DRIFT_PARITY_MISSING_HEADING &&
          e.file === "AGENTS.md" &&
          e.expected === "Protected Paths",
      ),
    ).toBe(true);
  });

  it("passes when a CLI-conditional heading is legitimately omitted", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx);

    const agents = readFile(root, "AGENTS.md");
    expect(agents).not.toContain("## Claude Only");

    const result = checkInstructionParity(ctx);
    expect(result.ok).toBe(true);
  });
});
