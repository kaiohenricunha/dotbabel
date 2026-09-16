/**
 * P-C5 — `regression_paths` and `verification_commands` were removed from
 * `docs/repo-facts.json` (KD-9): `regression_paths` is superseded by the
 * quality system's `critical_paths` escalation (KD-6), and
 * `verification_commands` never had a consumer. This file guards both
 * halves of that removal:
 *
 *  - the shipped surface (instruction/rule-floor files, the repo-facts.json
 *    template copies, and the merge-pr command copies) never mentions either
 *    key again, so a future edit cannot silently reintroduce them;
 *  - `dotbabel doctor` warns a consumer repo that still sets one, by name,
 *    rather than staying silent about dead configuration.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync, cpSync } from "node:fs";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { checkRemovedRepoFactsKeys } from "../src/check-repo-facts-keys.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

const REMOVED_KEYS_RX = /\bregression_paths\b|\bverification_commands\b/;

// The shipped, real-repo surface P-C5 touches. The instruction and rule-floor
// half is DERIVED from repo-facts.json rather than copied: that file is the
// repo's single source for the set (checkInstructionDrift iterates the same
// two arrays), so adding a rule-floor file there brings it under this scan
// automatically instead of silently shrinking coverage.
//
// Deliberately NOT scanned: docs/specs/qa-verification-harness/**, whose prose
// (KD-9 among it) documents the removal by name — a historical reference, not
// a live one — plus this test and the check module, which must name the keys
// they guard.
const facts = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/repo-facts.json"), "utf8"));
const SHIPPED_TEXT_FILES = [
  ...new Set([...facts.instruction_files, ...facts.rule_floor_files]),
  // Not in repo-facts.json's own lists: the three merge-pr copies whose step 5
  // described the removed gate, and the generated artifact index, which
  // mirrors each command's frontmatter description into a surface
  // dotbabel-search/list read.
  //
  // To be exact about what including the index buys: it catches a literal key
  // name reappearing there. It does NOT catch the index merely going stale —
  // the description this PR replaced said "data-regression gate", which no
  // key-name regex matches. Staleness is owned by `dotbabel-index --check`
  // (.github/workflows/dogfood.yml:41), which is what actually caught it here.
  "commands/merge-pr.md",
  "plugins/dotbabel/templates/claude/commands/merge-pr.md",
  ".github/prompts/merge-pr.prompt.md",
  "index/artifacts.json",
];

const REPO_FACTS_JSON_COPIES = [
  "docs/repo-facts.json",
  "plugins/dotbabel/templates/docs/repo-facts.json",
  "examples/minimal-consumer/docs/repo-facts.json",
];

describe("removed repo-facts.json keys — shipped surface", () => {
  // One test, with the exact name spec.json's AC-13 declares (KD-15's
  // criterion-to-test binding is confirmed by exact JUnit/output name match,
  // not substring), so it can carry the criterion. It checks every file in
  // one place rather than splitting into it.each cases, which would each get
  // their own generated name and so could not confirm the criterion.
  it("no template, doc, or rule-floor file mentions regression_paths or verification_commands", () => {
    const textOffenders = SHIPPED_TEXT_FILES.filter((relPath) => REMOVED_KEYS_RX.test(readFileSync(path.join(REPO_ROOT, relPath), "utf8")));
    expect(textOffenders, "files that still mention a removed key").toEqual([]);

    const jsonOffenders = REPO_FACTS_JSON_COPIES.filter((relPath) => {
      const parsed = JSON.parse(readFileSync(path.join(REPO_ROOT, relPath), "utf8"));
      return "regression_paths" in parsed || "verification_commands" in parsed;
    });
    expect(jsonOffenders, "repo-facts.json copies that still declare a removed key").toEqual([]);
  });
});

function isolateFixture() {
  const dst = makeTempDir("repo-facts-keys-test-");
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

describe("checkRemovedRepoFactsKeys", () => {
  it("warns when repo-facts gives regression_paths a non-empty value", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    facts.regression_paths = ["internal/auth/**"];
    writeFacts(root, facts);

    const result = checkRemovedRepoFactsKeys(ctx);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => /regression_paths/.test(w))).toBe(true);
  });

  it("warns when repo-facts gives verification_commands a non-empty value", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const facts = readFacts(root);
    facts.verification_commands = ["npm test"];
    writeFacts(root, facts);

    const result = checkRemovedRepoFactsKeys(ctx);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => /verification_commands/.test(w))).toBe(true);
  });

  it("stays silent when both keys are absent or empty", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });

    // Absent (the fixture's baseline shape).
    expect(checkRemovedRepoFactsKeys(ctx)).toEqual({ ok: true, warnings: [] });

    // Present but empty.
    const facts = readFacts(root);
    facts.regression_paths = [];
    facts.verification_commands = [];
    writeFacts(root, facts);
    expect(checkRemovedRepoFactsKeys(ctx)).toEqual({ ok: true, warnings: [] });
  });
});
