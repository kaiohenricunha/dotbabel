import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  cpSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import {
  generateInstructions,
  renderTarget,
  extractRuleFloor,
  stripRuleFloorMarkers,
  BANNER,
  RULE_FLOOR_BEGIN,
  RULE_FLOOR_END,
  MANIFEST_RELATIVE_PATH,
} from "../src/generate-instructions.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

function isolateFixture() {
  const dst = mkdtempSync(path.join(tmpdir(), "harness-generate-test-"));
  cpSync(FIXTURE_SRC, dst, { recursive: true });
  return dst;
}

function writeClaude(root, body) {
  writeFileSync(path.join(root, "CLAUDE.md"), body);
}

function writeFile(root, rel, body) {
  writeFileSync(path.join(root, rel), body);
}

function readFile(root, rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

function readFacts(root) {
  return JSON.parse(readFile(root, "docs/repo-facts.json"));
}

function writeFacts(root, obj) {
  writeFileSync(
    path.join(root, "docs", "repo-facts.json"),
    JSON.stringify(obj, null, 2) + "\n",
  );
}

const SYNTH_COPILOT = Object.freeze({
  relativeOutputPath: "out/copilot.md",
  cliSet: Object.freeze(["copilot"]),
  substitutionKey: "copilot",
  mode: "synthesize",
});

const SYNTH_SHARED = Object.freeze({
  relativeOutputPath: "out/agents.md",
  cliSet: Object.freeze(["copilot", "codex"]),
  substitutionKey: "agents",
  mode: "synthesize",
});

const INJECT_AGENTS = Object.freeze({
  relativeOutputPath: "AGENTS.md",
  cliSet: Object.freeze(["copilot", "codex"]),
  substitutionKey: "agents",
  mode: "inject",
});

describe("renderTarget — span semantics", () => {
  it("includes unmarked content and strips Claude-only spans (and no banner)", () => {
    const src = [
      "# Common",
      "",
      "Universal rule.",
      "",
      "<!-- dotbabel:cli claude -->",
      "Claude-only line.",
      "<!-- dotbabel:end -->",
      "",
      "Another universal rule.",
    ].join("\n");
    const { body, omittedHeadings } = renderTarget(src, SYNTH_COPILOT, {});
    // renderTarget no longer prepends the banner — composeOutput does that.
    expect(body.startsWith(BANNER)).toBe(false);
    expect(body).toContain("Universal rule.");
    expect(body).toContain("Another universal rule.");
    expect(body).not.toContain("Claude-only line.");
    expect(body).not.toContain("dotbabel:cli");
    expect(body).not.toContain("dotbabel:end");
    expect(omittedHeadings).toEqual([]);
  });

  it("includes spans whose tag-set is a superset of the target cliSet", () => {
    const src = [
      "<!-- dotbabel:cli copilot codex -->",
      "Shared between copilot and codex.",
      "<!-- dotbabel:end -->",
      "<!-- dotbabel:cli copilot -->",
      "Copilot only.",
      "<!-- dotbabel:end -->",
      "<!-- dotbabel:cli gemini -->",
      "Gemini only.",
      "<!-- dotbabel:end -->",
    ].join("\n");

    const sharedBody = renderTarget(src, SYNTH_SHARED, {}).body;
    expect(sharedBody).toContain("Shared between copilot and codex.");
    expect(sharedBody).not.toContain("Copilot only."); // {copilot} ⊉ {copilot, codex}
    expect(sharedBody).not.toContain("Gemini only.");

    const copilotBody = renderTarget(src, SYNTH_COPILOT, {}).body;
    expect(copilotBody).toContain("Shared between copilot and codex.");
    expect(copilotBody).toContain("Copilot only.");
    expect(copilotBody).not.toContain("Gemini only.");
  });

  it("records omitted top-level headings for excluded spans", () => {
    const src = [
      "<!-- dotbabel:cli claude -->",
      "## Skills, Commands, and Discovery",
      "",
      "Claude-only skill body.",
      "<!-- dotbabel:end -->",
    ].join("\n");
    const { body, omittedHeadings } = renderTarget(src, SYNTH_COPILOT, {});
    expect(body).not.toContain("Skills, Commands, and Discovery");
    expect(omittedHeadings).toEqual(["Skills, Commands, and Discovery"]);
  });

  it("treats span markers inside fenced code blocks as literal text", () => {
    const src = [
      "Before fence.",
      "",
      "```",
      "<!-- dotbabel:cli claude -->",
      "literal in fence",
      "<!-- dotbabel:end -->",
      "```",
      "",
      "After fence.",
    ].join("\n");
    const { body } = renderTarget(src, SYNTH_COPILOT, {});
    expect(body).toContain("<!-- dotbabel:cli claude -->");
    expect(body).toContain("literal in fence");
    expect(body).toContain("<!-- dotbabel:end -->");
    expect(body).toContain("After fence.");
  });

  it("throws DRIFT_NESTED_SPAN on nested spans", () => {
    const src = [
      "<!-- dotbabel:cli claude -->",
      "outer",
      "<!-- dotbabel:cli copilot -->",
      "inner",
      "<!-- dotbabel:end -->",
      "<!-- dotbabel:end -->",
    ].join("\n");
    let caught;
    try {
      renderTarget(src, SYNTH_COPILOT, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.DRIFT_NESTED_SPAN);
    expect(caught.line).toBe(3);
  });

  it("throws DRIFT_UNCLOSED_SPAN on missing end marker", () => {
    const src = ["<!-- dotbabel:cli claude -->", "open forever"].join("\n");
    let caught;
    try {
      renderTarget(src, SYNTH_COPILOT, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.DRIFT_UNCLOSED_SPAN);
    expect(caught.line).toBe(1);
  });

  it("throws DRIFT_UNCLOSED_SPAN on orphan end marker", () => {
    const src = ["body", "<!-- dotbabel:end -->", "more"].join("\n");
    let caught;
    try {
      renderTarget(src, SYNTH_COPILOT, {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.DRIFT_UNCLOSED_SPAN);
    expect(caught.line).toBe(2);
  });
});

describe("renderTarget — substitutions", () => {
  it("applies the per-target map and the _default_ map", () => {
    const src = "Use Claude Code from ~/.claude/CLAUDE.md.";
    const subs = {
      _default_: { "Claude Code": "your CLI" },
      copilot: { "~/.claude/": "~/.copilot/" },
    };
    const { body } = renderTarget(src, SYNTH_COPILOT, subs);
    expect(body).toContain("Use your CLI from ~/.copilot/CLAUDE.md.");
  });

  it("applies longer needles before shorter ones to avoid prefix clobber", () => {
    const src = "abcde and abc";
    const subs = { _default_: { abc: "X", abcde: "LONG" } };
    const { body } = renderTarget(src, SYNTH_COPILOT, subs);
    expect(body).toContain("LONG and X");
  });
});

describe("rule-floor extraction helpers", () => {
  const wrappedSrc = [
    "preamble",
    RULE_FLOOR_BEGIN,
    "## Section",
    "rule body",
    RULE_FLOOR_END,
    "trailer",
  ].join("\n");

  it("extractRuleFloor returns the slice between markers, trimmed", () => {
    const slice = extractRuleFloor(wrappedSrc);
    expect(slice).toBe("## Section\nrule body");
  });

  it("extractRuleFloor throws when markers are missing", () => {
    let caught;
    try {
      extractRuleFloor("no markers here");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.DRIFT_UNCLOSED_SPAN);
  });

  it("stripRuleFloorMarkers drops the marker LINES but keeps content", () => {
    const stripped = stripRuleFloorMarkers(wrappedSrc);
    expect(stripped).toBe("preamble\n## Section\nrule body\ntrailer");
  });
});

describe("generateInstructions — synthesize mode", () => {
  it("writes a fully synthesized file with banner and no rule-floor markers", () => {
    const root = isolateFixture();
    writeClaude(
      root,
      [
        "# CLAUDE.md",
        "",
        "intro",
        "",
        RULE_FLOOR_BEGIN,
        "## Section",
        "rule body",
        RULE_FLOOR_END,
      ].join("\n"),
    );
    writeFacts(root, { ...readFacts(root), cli_substitutions: {} });
    const ctx = createHarnessContext({ repoRoot: root });
    const result = generateInstructions(ctx, {
      targets: [
        {
          relativeOutputPath: "out/synthesized.md",
          cliSet: ["copilot"],
          substitutionKey: "copilot",
          mode: "synthesize",
        },
      ],
    });
    expect(result.ok).toBe(true);
    const written = readFile(root, "out/synthesized.md");
    expect(written.startsWith(BANNER + "\n")).toBe(true);
    expect(written).toContain("intro");
    expect(written).toContain("## Section");
    expect(written).toContain("rule body");
    expect(written).not.toContain(RULE_FLOOR_BEGIN);
    expect(written).not.toContain(RULE_FLOOR_END);
  });
});

describe("generateInstructions — inject mode", () => {
  function setupCanonical(root) {
    writeClaude(
      root,
      [
        "# CLAUDE.md",
        "",
        "intro",
        "",
        RULE_FLOOR_BEGIN,
        "## Section",
        "rule body",
        RULE_FLOOR_END,
      ].join("\n"),
    );
    writeFacts(root, { ...readFacts(root), cli_substitutions: {} });
  }

  it("appends a rule-floor section on first run when host file lacks markers", () => {
    const root = isolateFixture();
    setupCanonical(root);
    writeFile(
      root,
      "AGENTS.md",
      "# Repository Guidelines\n\nProject-specific content here.\n",
    );
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx, { targets: [INJECT_AGENTS] });
    const after = readFile(root, "AGENTS.md");
    expect(after).toContain("# Repository Guidelines");
    expect(after).toContain("Project-specific content here.");
    expect(after).toContain(RULE_FLOOR_BEGIN);
    expect(after).toContain(RULE_FLOOR_END);
    expect(after).toContain(BANNER);
    expect(after).toContain("## Section");
    expect(after).toContain("rule body");
  });

  it("replaces only the block on subsequent runs, leaving hand-authored content untouched", () => {
    const root = isolateFixture();
    setupCanonical(root);
    writeFile(
      root,
      "AGENTS.md",
      [
        "# Repository Guidelines",
        "",
        "Hand-authored top.",
        "",
        RULE_FLOOR_BEGIN,
        "STALE",
        RULE_FLOOR_END,
        "",
        "Hand-authored bottom.",
        "",
      ].join("\n"),
    );
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx, { targets: [INJECT_AGENTS] });
    const after = readFile(root, "AGENTS.md");
    expect(after).toContain("# Repository Guidelines");
    expect(after).toContain("Hand-authored top.");
    expect(after).toContain("Hand-authored bottom.");
    expect(after).not.toContain("STALE");
    expect(after).toContain("## Section");
    expect(after).toContain("rule body");
    // Only one pair of markers exists.
    expect(after.match(new RegExp(RULE_FLOOR_BEGIN, "g")).length).toBe(1);
    expect(after.match(new RegExp(RULE_FLOOR_END, "g")).length).toBe(1);
  });

  it("matches rule-floor markers only on marker lines during replacement", () => {
    const root = isolateFixture();
    writeClaude(
      root,
      [
        "# CLAUDE.md",
        "",
        RULE_FLOOR_BEGIN,
        `The closing marker \`${RULE_FLOOR_END}\` can be mentioned in prose.`,
        "fresh body",
        RULE_FLOOR_END,
      ].join("\n"),
    );
    writeFacts(root, { ...readFacts(root), cli_substitutions: {} });
    writeFile(
      root,
      "AGENTS.md",
      [
        "# Repository Guidelines",
        "",
        RULE_FLOOR_BEGIN,
        `The closing marker \`${RULE_FLOOR_END}\` can be mentioned in prose.`,
        "STALE",
        RULE_FLOOR_END,
        "",
        "Hand-authored tail.",
        "",
      ].join("\n"),
    );
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx, { targets: [INJECT_AGENTS] });
    const after = readFile(root, "AGENTS.md");
    expect(after).toContain("fresh body");
    expect(after).toContain("Hand-authored tail.");
    expect(after).not.toContain("STALE");
    expect(
      after.split("\n").filter((line) => line.trim() === RULE_FLOOR_END),
    ).toHaveLength(1);
  });

  it("is idempotent — running twice produces the same content", () => {
    const root = isolateFixture();
    setupCanonical(root);
    writeFile(root, "AGENTS.md", "# Guidelines\n\nstuff\n");
    const ctx = createHarnessContext({ repoRoot: root });
    generateInstructions(ctx, { targets: [INJECT_AGENTS] });
    const first = readFile(root, "AGENTS.md");
    generateInstructions(ctx, { targets: [INJECT_AGENTS] });
    const second = readFile(root, "AGENTS.md");
    expect(second).toBe(first);
  });

  it("throws on mismatched (orphan) rule-floor markers in host file", () => {
    const root = isolateFixture();
    setupCanonical(root);
    writeFile(
      root,
      "AGENTS.md",
      `# Guidelines\n\n${RULE_FLOOR_BEGIN}\nbody without close\n`,
    );
    const ctx = createHarnessContext({ repoRoot: root });
    let caught;
    try {
      generateInstructions(ctx, { targets: [INJECT_AGENTS] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.DRIFT_UNCLOSED_SPAN);
  });

  it("throws on missing rule-floor markers in CLAUDE.md", () => {
    const root = isolateFixture();
    writeClaude(root, "# CLAUDE.md\n\nno markers here\n");
    writeFacts(root, { ...readFacts(root), cli_substitutions: {} });
    writeFile(root, "AGENTS.md", "# host\n");
    const ctx = createHarnessContext({ repoRoot: root });
    let caught;
    try {
      generateInstructions(ctx, { targets: [INJECT_AGENTS] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.DRIFT_UNCLOSED_SPAN);
  });
});

describe("generateInstructions — manifest", () => {
  it("records mode + cliSet + omittedHeadings per target", () => {
    const root = isolateFixture();
    writeClaude(
      root,
      [
        "# CLAUDE.md",
        "intro",
        RULE_FLOOR_BEGIN,
        "<!-- dotbabel:cli claude -->",
        "## Claude only",
        "<!-- dotbabel:end -->",
        "## Universal",
        "body",
        RULE_FLOOR_END,
      ].join("\n"),
    );
    writeFacts(root, { ...readFacts(root), cli_substitutions: {} });
    writeFile(root, "AGENTS.md", "# Guidelines\n");
    const ctx = createHarnessContext({ repoRoot: root });
    const result = generateInstructions(ctx, {
      targets: [
        INJECT_AGENTS,
        {
          relativeOutputPath: "out/copilot-user.md",
          cliSet: ["copilot"],
          substitutionKey: "copilot",
          mode: "synthesize",
        },
      ],
    });
    expect(result.manifest.targets["AGENTS.md"].mode).toBe("inject");
    expect(result.manifest.targets["AGENTS.md"].cliSet).toEqual([
      "copilot",
      "codex",
    ]);
    expect(result.manifest.targets["AGENTS.md"].omittedHeadings).toContain(
      "Claude only",
    );
    expect(result.manifest.targets["out/copilot-user.md"].mode).toBe(
      "synthesize",
    );
    expect(existsSync(path.join(root, MANIFEST_RELATIVE_PATH))).toBe(true);
  });
});

describe("generateInstructions — cli_substitutions validation", () => {
  function setup(value) {
    const root = isolateFixture();
    const facts = readFacts(root);
    facts.cli_substitutions = value;
    writeFacts(root, facts);
    writeClaude(
      root,
      [`# Doc`, "", RULE_FLOOR_BEGIN, "## Rule", RULE_FLOOR_END, ""].join("\n"),
    );
    return createHarnessContext({ repoRoot: root });
  }

  it("rejects an array as cli_substitutions", () => {
    const ctx = setup(["copilot"]);
    expect(() => generateInstructions(ctx, { dryRun: true })).toThrow(
      ValidationError,
    );
  });

  it("rejects a non-object substitution map per CLI key", () => {
    const ctx = setup({ copilot: "not an object" });
    expect(() => generateInstructions(ctx, { dryRun: true })).toThrow(
      /string→string map/,
    );
  });

  it("rejects a non-string replacement value", () => {
    const ctx = setup({ copilot: { foo: 42 } });
    expect(() => generateInstructions(ctx, { dryRun: true })).toThrow(
      /must be a string/,
    );
  });

  it("accepts undefined / null without raising", () => {
    const ctxA = setup(undefined);
    const ctxB = setup(null);
    expect(() => generateInstructions(ctxA, { dryRun: true })).not.toThrow();
    expect(() => generateInstructions(ctxB, { dryRun: true })).not.toThrow();
  });
});
