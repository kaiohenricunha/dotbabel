// ARCH-10 drift test (Phase 1) for the handoff skill — see
// docs/specs/handoff-skill/spec/3-high-level-architecture.md §ARCH-10
// and docs/specs/handoff-skill/spec/6-implementation-plan.md §6.1 Phase 1.
//
// What this test is.
//   A *cross-source* drift test that asserts the handoff skill's public
//   symbol list (sub-commands + flags + the `--from`-when-no-query rule)
//   stays in agreement across the sources where users learn the surface:
//   the binary's `--help` output and `skills/handoff/SKILL.md`. When any
//   one source moves out of sync, the test fails — that is the cutover
//   signal §6 calls for, not a bug in the test.
//
// What this test is not.
//   It is not a per-source snapshot. A snapshot test fails the moment any
//   source changes, regardless of whether the others were updated, which
//   provides no signal for a Phase 2 PR that legitimately reshapes the
//   surface in lockstep across sources.
//
// Phase 1 scope (deliberately minimal — see fixtures/handoff-drift-known-disagreements.md).
//   - Sources: 2 of 3. Just `--help` + SKILL.md. `docs/handoff-guide.md`
//     is heavily drifted today (per spec §1) and joins as a third source
//     in Phase 2 PR 8 after docs reconciliation lands.
//   - Symbols asserted: the *intersection* of stable symbols. Today that
//     is `[doctor, fetch, list, pull, push, search]` for commands and a
//     small intersection for global flags. As Phase 2 PRs reconcile each
//     disagreement, the intersection grows and the fixture shrinks.
//   - `from_rule` is asserted `{ present: false, applies_to: [], mandatory_when: null }`
//     in both sources today; spec §5.5.2's mandatory-`--from` rule lands
//     in Phase 2 PR 3 and both extractors flip in lockstep with the binary
//     change.
//
// Mechanism.
//   Two extractors produce a `HandoffSurface` struct from each source.
//   The struct schema is the "test-the-test" — a shape assertion runs
//   first and would catch an extractor that silently produced the wrong
//   shape before anything else compared values.
//
// Maintenance.
//   When a Phase 2 PR moves a symbol from "disagreement" to "agreement,"
//   it (a) updates the relevant source(s), (b) deletes the symbol's row
//   from `fixtures/handoff-drift-known-disagreements.md`, (c) updates
//   `PHASE_1_BASELINE_*` here. All three changes land in the same PR;
//   the test enforces the lockstep.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseFrontmatter } from "../src/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

const SKILL_MD_PATH = resolve(repoRoot, "skills/handoff/SKILL.md");
const HANDOFF_BIN = resolve(repoRoot, "plugins/dotclaude/bin/dotclaude-handoff.mjs");

/**
 * @typedef {object} FromRule
 * @property {boolean} present  — does the source document a mandatory-`--from` rule for `push` without `<query>`
 * @property {string[]} applies_to  — sub-commands the rule applies to (e.g. `["push"]`); empty when not present
 * @property {string|null} mandatory_when  — short structural marker of when it applies (e.g. "no <query>"); null when not present
 */

/**
 * The minimal symbol-list surface each source contributes.
 *
 * `flags_by_command` uses the sentinel key `"*"` for "global flags" because
 * neither source today disambiguates flags per sub-command rigorously enough
 * to make per-command extraction reliable. Phase 2 PRs that introduce per-
 * command flag rigor will populate per-command keys; this Phase 1 baseline
 * just tracks the global flag set.
 *
 * @typedef {object} HandoffSurface
 * @property {string[]} commands  — sorted, lowercase sub-command names (e.g. `["doctor", "fetch", ...]`)
 * @property {Record<string, string[]>} flags_by_command  — `"*"` → sorted global flag tokens (each `--name` or `-x`)
 * @property {FromRule} from_rule
 */

// ---------------------------------------------------------------------------
// Phase 1 expected baselines
// ---------------------------------------------------------------------------

/** Cross-source intersection of sub-commands on c117418. */
const PHASE_1_BASELINE_COMMANDS = ["doctor", "fetch", "list", "pull", "push", "search"];

/**
 * Cross-source intersection of global flags on c117418.
 * Excluded flags + their reconciliation PR live in
 * `fixtures/handoff-drift-known-disagreements.md`.
 *
 * Notes on what's IN: flags that both `--help`'s Options block AND
 * SKILL.md's "Cross-cutting flags" bullet list mention canonically.
 * Universal CLI flags (`--help`, `--version`, `--no-color`, `--verbose`)
 * are excluded from spec coverage.
 */
const PHASE_1_BASELINE_FLAGS_INTERSECTION = [
  "--fixed",
  "--from",
  "--json",
  "--limit",
  "--since",
  "--summary",
  "--tag",
  "--to",
  "-o",
];

/** Both sources baseline — flipped in Phase 2 PR 3 when §5.5.2 mandatory-`--from` landed. */
const PHASE_1_BASELINE_FROM_RULE = Object.freeze({
  present: true,
  applies_to: ["push"],
  mandatory_when: "no <query>",
});

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Parse `skills/handoff/SKILL.md`.
 *
 * Sub-commands come from the `argument-hint:` frontmatter line, which is
 * structured YAML and the schema's authoritative source. The Sub-commands
 * markdown table is prose and has internally drifted on c117418
 * (omits `prune`); the fixture file documents that.
 *
 * Global flags come from the `## Cross-cutting flags ...` bullet list
 * (the bullets that begin `- \`--<name>\``). That section is the single
 * place SKILL.md tries to enumerate flags canonically.
 *
 * @param {string} text
 * @returns {HandoffSurface}
 */
export function extractFromSkillMd(text) {
  const { frontmatter } = parseFrontmatter(text);
  const argHint = frontmatter["argument-hint"];
  if (typeof argHint !== "string") {
    throw new Error("SKILL.md: frontmatter missing string `argument-hint` key");
  }
  const firstGroup = argHint.match(/\[([^\]]+)\]/);
  if (!firstGroup) {
    throw new Error("SKILL.md: argument-hint missing `[verb1|verb2|...]` group");
  }
  const commands = firstGroup[1]
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort();

  // "Cross-cutting flags" lives as a paragraph inside `## Sub-commands` —
  // not its own H2 — so the shared `extractTemplateSection` doesn't apply.
  // Capture from the inline paragraph header to the next `##`/`#` heading.
  const flagsSection = text.match(/Cross-cutting flags[^\n]*\n[\s\S]*?(?=\n## |\n# |$)/);
  if (!flagsSection) {
    throw new Error("SKILL.md: could not find `Cross-cutting flags` section");
  }
  const flagTokens = new Set();
  // Each bullet begins `- \`<token>\``; tokens may be slash-joined aliases
  // (`--fixed/-F`) or comma-separated (`` `--name`, `-x` ``). Accept both.
  const bulletRegex = /^\s*-\s+`(--?[a-z][a-zA-Z0-9-]*(?:[/,]\s*`?-?-?[a-zA-Z][a-zA-Z0-9-]*`?)*)/gm;
  let m;
  while ((m = bulletRegex.exec(flagsSection[0])) !== null) {
    for (const tok of m[1].split(/[/,`\s]+/)) {
      if (tok && tok.startsWith("-")) flagTokens.add(tok);
    }
  }

  return {
    commands,
    flags_by_command: { "*": [...flagTokens].sort() },
    from_rule: extractFromRule(text),
  };
}

/**
 * Parse the binary's `--help` output.
 *
 * Sub-commands come from the synopsis line's first `[verb1|verb2|...]`
 * group. Global flags come from the `Options:` block.
 *
 * @param {string} text
 * @returns {HandoffSurface}
 */
export function extractFromHelp(text) {
  // Anchor only on the verb group; spec §5.0 keeps `--help` wording editable
  // (`[args...]` may be rephrased as `[arguments]`, `<args>`, or omitted).
  const synopsisGroup = text.match(/dotclaude handoff\s+\[([^\]]+)\]/);
  if (!synopsisGroup) {
    throw new Error("--help: synopsis line missing `[verb1|verb2|...]` group");
  }
  const commands = synopsisGroup[1]
    .split("|")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort();

  // Capture from `Options:` to the next title-case section header or EOF.
  // (`\Z` is not a JS regex anchor — `(?![\s\S])` is the EOF lookahead.)
  const optsBlock = text.match(/^Options:\s*$([\s\S]*?)(?=^[A-Z][\w ]*:|(?![\s\S]))/m);
  if (!optsBlock) {
    throw new Error("--help: could not find `Options:` block");
  }
  const flagTokens = new Set();
  // Each Options line begins with whitespace and `--name` or `--name, -x`
  // or `-x, --name`. Capture every long-form / short-form token on the line.
  const flagLineRegex = /^\s+(--?[a-z][a-zA-Z0-9-]*(?:,\s*--?[a-zA-Z][a-zA-Z0-9-]*)*)/gm;
  let m;
  while ((m = flagLineRegex.exec(optsBlock[1])) !== null) {
    for (const tok of m[1].split(",").map((s) => s.trim())) {
      if (tok && tok.startsWith("-")) flagTokens.add(tok);
    }
  }

  return {
    commands,
    flags_by_command: { "*": [...flagTokens].sort() },
    from_rule: extractFromRule(text),
  };
}

/**
 * Structural search for the `--from`-when-no-query rule paragraph.
 * Conservative on purpose: today the rule is absent from both sources.
 * Phase 2 PR 3 will add the §5.5.2 paragraph; this function will then
 * find it and report `{ present: true, applies_to: ["push"], mandatory_when: "no <query>" }`
 * (or whatever Phase 2 freezes), and the baseline above will flip.
 *
 * @param {string} text
 * @returns {FromRule}
 */
export function extractFromRule(text) {
  // Cheap absence check first: if `--from` doesn't appear at all, nothing
  // could match the four-clause heuristic below.
  if (!/--from\b/.test(text)) return { present: false, applies_to: [], mandatory_when: null };

  // Heuristic: a paragraph that mentions all of:
  //   (a) `--from` as a flag,
  //   (b) `push` (the verb the rule applies to),
  //   (c) a "no <query>" / "without <query>" marker (or synonym),
  //   (d) a required/mandatory marker.
  // We avoid prose-exact matching per spec §5.0 (wording stays editable).
  // Keep this loose enough to find the §5.5.2 paragraph in any reasonable
  // wording, strict enough not to false-positive on incidental flag mentions.
  const paragraphs = text.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const lower = p.toLowerCase();
    const mentionsFromFlag = /(^|[^a-z-])--from\b/.test(p);
    const mentionsPush = /\bpush\b/.test(lower);
    const mentionsNoQuery =
      /\bno\s*<?query>?\b/.test(lower) ||
      /\bwithout\s+(?:a\s+)?<?query>?\b/.test(lower) ||
      /\bwhen\s+no\s+`?<?query>?`?\b/.test(lower) ||
      /\b(?:omit(?:ting|ted)?|absent|missing)\s+(?:the\s+|a\s+)?<?query>?\b/.test(lower);
    const mentionsRequired =
      /\bmandator(?:y|ily)\b/.test(lower) ||
      /\brequired?\b/.test(lower) ||
      /\bmust\s+(?:include|pass|set)\b/.test(lower);
    if (mentionsFromFlag && mentionsPush && mentionsNoQuery && mentionsRequired) {
      return {
        present: true,
        applies_to: ["push"],
        mandatory_when: "no <query>",
      };
    }
  }
  return { present: false, applies_to: [], mandatory_when: null };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handoff drift (ARCH-10) — Phase 1", () => {
  /** @type {HandoffSurface} */
  let skillSurface;
  /** @type {HandoffSurface} */
  let helpSurface;

  beforeAll(() => {
    const skillText = readFileSync(SKILL_MD_PATH, "utf8");
    skillSurface = extractFromSkillMd(skillText);

    // The bin sources `$XDG_CONFIG_HOME/dotclaude/handoff.env` at startup
    // (default `$HOME/.config/...`). Point both HOME and XDG_CONFIG_HOME at
    // a fresh temp dir so a user's persisted handoff.env can't leak into the
    // test, and parallel vitest workers can't collide on the same path.
    const hermeticHome = mkdtempSync(resolve(tmpdir(), "handoff-drift-"));
    const help = execFileSync(process.execPath, [HANDOFF_BIN, "--help"], {
      encoding: "utf8",
      env: { ...process.env, HOME: hermeticHome, XDG_CONFIG_HOME: hermeticHome },
    });
    helpSurface = extractFromHelp(help);
  });

  it("test-the-test: each extractor returns a HandoffSurface struct", () => {
    for (const [name, surface] of [
      ["SKILL.md", skillSurface],
      ["--help", helpSurface],
    ]) {
      // Top-level shape.
      expect(surface, name).toEqual(
        expect.objectContaining({
          commands: expect.any(Array),
          flags_by_command: expect.any(Object),
          // `mandatory_when` is `string | null`. `expect.anything()`
          // rejects null, so the type check below covers it instead.
          from_rule: expect.objectContaining({
            present: expect.any(Boolean),
            applies_to: expect.any(Array),
          }),
        }),
      );
      // Element-type checks.
      expect(
        surface.commands.every((c) => typeof c === "string"),
        `${name} commands`,
      ).toBe(true);
      expect(
        Object.values(surface.flags_by_command).every(
          (v) => Array.isArray(v) && v.every((f) => typeof f === "string"),
        ),
        `${name} flags_by_command values`,
      ).toBe(true);
      expect(surface.from_rule.applies_to.every((c) => typeof c === "string")).toBe(true);
      expect(
        surface.from_rule.mandatory_when === null ||
          typeof surface.from_rule.mandatory_when === "string",
      ).toBe(true);
      // Each extractor produced *some* commands; an empty list almost
      // always means a parse miss.
      expect(surface.commands.length, `${name} commands non-empty`).toBeGreaterThan(0);
    }
  });

  it("commands intersection across sources matches Phase 1 baseline", () => {
    const skillSet = new Set(skillSurface.commands);
    const intersection = helpSurface.commands.filter((c) => skillSet.has(c)).sort();
    expect(intersection).toEqual(PHASE_1_BASELINE_COMMANDS);
  });

  it("global-flag intersection across sources matches Phase 1 baseline", () => {
    const skillFlags = new Set(skillSurface.flags_by_command["*"] ?? []);
    const helpFlags = helpSurface.flags_by_command["*"] ?? [];
    const intersection = helpFlags.filter((f) => skillFlags.has(f)).sort();
    expect(intersection).toEqual(PHASE_1_BASELINE_FLAGS_INTERSECTION);
  });

  it("from_rule baseline matches in both sources", () => {
    expect(skillSurface.from_rule).toEqual(PHASE_1_BASELINE_FROM_RULE);
    expect(helpSurface.from_rule).toEqual(PHASE_1_BASELINE_FROM_RULE);
  });
});
