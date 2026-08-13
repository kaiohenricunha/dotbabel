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
//   - Sources: 3 of 3. `--help`, SKILL.md, and `docs/handoff-guide.md`.
//     All three sources are reconciled as of Phase 2 PR 8.
//   - Symbols asserted: the *intersection* of stable symbols across all
//     three sources. That is `[doctor, fetch, list, prune, pull, push, search]`
//     for commands and 8 global flags. The fixture documents the small set
//     of symbols present in only one or two sources.
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
const HANDOFF_BIN = resolve(repoRoot, "plugins/dotbabel/bin/dotbabel-handoff.mjs");
const GUIDE_MD_PATH = resolve(repoRoot, "docs/handoff-guide.md");

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
 * @property {string[]} alias_mechanisms  — sorted unique alias-resolution mechanism names found in source
 */

// ---------------------------------------------------------------------------
// Phase 1 expected baselines
// ---------------------------------------------------------------------------

/** Cross-source intersection of sub-commands. `prune` joined in Phase 2 PR 6. */
const PHASE_1_BASELINE_COMMANDS = ["doctor", "fetch", "list", "prune", "pull", "push", "search"];

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
  "-o",
];

/** Both sources baseline — flipped in Phase 2 PR 3 when §5.5.2 mandatory-`--from` landed. */
const PHASE_1_BASELINE_FROM_RULE = Object.freeze({
  present: true,
  applies_to: ["push"],
  mandatory_when: "no <query>",
});

/**
 * Cross-source intersection of alias-resolution mechanisms (#158).
 * All 5 forms must appear in --help, SKILL.md, AND handoff-guide.md
 * (Steps 5+6 of the v1.3.0 alias-resolver work updated each source
 * to enumerate the resolver mechanisms by canonical name).
 */
const PHASE_2_BASELINE_ALIAS_MECHANISMS = [
  "aiTitle",
  "checkpoint",
  "customTitle",
  "name",
  "thread_name",
];

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

  // "Cross-cutting flags" is an H2 in SKILL.md (## Cross-cutting flags).
  // Capture from that heading to the next H2 or EOF only.
  // Safety: do NOT use `\n# ` as an additional terminator — bash comment
  // lines inside any future code block in this section look like `# text`
  // and would prematurely truncate the match, silently dropping flags.
  const flagsSection = text.match(/Cross-cutting flags[^\n]*\n[\s\S]*?(?=\n## |$)/);
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
    alias_mechanisms: extractAliasMechanisms(text),
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
  const synopsisGroup = text.match(/dotbabel handoff\s+\[([^\]]+)\]/);
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
  // Safety: the terminator is `^[A-Z][\w ]*:` (title-case word followed by
  // colon), which bash comment lines (`# text`) can never match. No `\n# `
  // fragility here; the boundary is inherently immune to bash comments.
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
    alias_mechanisms: extractAliasMechanisms(text),
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
  //
  // False-positive audit (Phase 3 W-4, as of dc32931):
  //   The guide now has 3+ paragraphs mentioning `--from`; none trigger all
  //   four clauses simultaneously except the intended §5.5.2 paragraph
  //   ("When calling push with no query argument, --from is required…").
  //   - The `list` table row (line ~135) mentions `--from` but has no "no
  //     query" / "required" prose in the same paragraph.
  //   - The search examples (lines ~156, ~163) appear in code blocks; the
  //     paragraph separator `\n\s*\n` splits them from any surrounding prose
  //     that might contain "required", so they don't form a four-clause match.
  //   No false positive risk identified. Re-verify if new guide paragraphs
  //   describe `--from` as required on `push` in proximity to "no query".
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

/**
 * Structural search for the fabrication-forbidden rule paragraph (KD-7).
 * SKILL.md-only: --help and the user-facing guide don't need to discuss
 * what consumers should do on a failed invocation, so this is asymmetric
 * to extractFromRule (which checks all 3 sources).
 *
 * Heuristic: a paragraph that mentions all four clauses simultaneously,
 * the same approach as extractFromRule. Loose enough to survive wording
 * changes per spec §5.0; strict enough that incidental mentions of
 * "fabricate" or "dotbabel" alone don't false-positive.
 *
 * @param {string} text
 * @returns {{ present: boolean }}
 */
export function extractFabricationRule(text) {
  // Cheap absence check: if no forbidden-behavior verb appears at all,
  // no paragraph could match the four-clause conjunction below.
  if (!/\b(fabricat|reconstruct|synthesi[sz]e)/i.test(text)) {
    return { present: false };
  }

  const paragraphs = text.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const lower = p.toLowerCase();
    const mentionsFailure =
      /\bpermission\s+denied\b/.test(lower) ||
      /\btool[\s-]execution\b/.test(lower) ||
      /\bcannot\s+(?:be\s+)?(?:execute|run|invoke)/.test(lower) ||
      /\bsandbox\b/.test(lower) ||
      /\bbinary\s+(?:not\s+found|missing)\b/.test(lower);
    const mentionsBinary = /\bdotbabel\b/.test(lower);
    const mentionsForbidden =
      /\bfabricat/.test(lower) ||
      /\breconstruct/.test(lower) ||
      /\bsynthesi[sz]e/.test(lower);
    const mentionsRequired =
      /\bverbatim\b/.test(lower) ||
      /\b(?:stop|halt)\b/.test(lower) ||
      /\breport\b(?:[\s-]+[a-z]+){0,4}[\s-]+(?:error|failure)\b/.test(lower);
    if (mentionsFailure && mentionsBinary && mentionsForbidden && mentionsRequired) {
      return { present: true };
    }
  }
  return { present: false };
}

/**
 * Parse `docs/handoff-guide.md`.
 *
 * Sub-commands come from the `## When to use it` table's second column —
 * each non-header row's cell is scanned for backtick-wrapped lowercase-alpha
 * tokens (the verb names). Flat flag tokens come from the `## The five forms`
 * and `## Common patterns` sections, scanned for `--flag` and `-o` tokens.
 * Note: per-command flags (e.g. `--local`, `--remote`) are included; the
 * intersection logic, not this extractor, limits what reaches the baseline.
 *
 * @param {string} text
 * @returns {HandoffSurface}
 */

/**
 * Scan a source for canonical alias-mechanism names. The handoff resolver
 * dispatches alias queries through 5 mechanisms — claude `customTitle`,
 * claude `aiTitle`, codex `thread_name`, copilot `workspace.yaml:name`,
 * gemini `checkpoint` —
 * and ARCH-10 asserts that all 5 are documented across the cross-source
 * triangle (--help / SKILL.md / handoff-guide.md). When any source
 * documents fewer than 5, the alias surface has drifted out of sync with
 * the resolver implementation; the test fails to surface that.
 *
 * The mechanism names map to canonical strings the sources MUST mention:
 * `customTitle`, `aiTitle`, `thread_name`, `workspace.yaml:name`, and
 * `checkpoint` (the copilot mechanism uses the full `workspace.yaml:name`
 * form to disambiguate from incidental `--name` flags or generic "name" prose). If a future
 * source documents copilot's alias mechanism without using the canonical
 * form, that's drift worth surfacing — the test should fail, not be
 * patched to pass via fallback regexes.
 *
 * @param {string} text
 * @returns {string[]}  sorted unique mechanism names found
 */
export function extractAliasMechanisms(text) {
  const found = new Set();
  if (/\bcustomTitle\b/.test(text)) found.add("customTitle");
  if (/\baiTitle\b/.test(text)) found.add("aiTitle");
  if (/\bthread_name\b/.test(text)) found.add("thread_name");
  if (/workspace\.yaml:name\b/.test(text)) found.add("name");
  if (/\bcheckpoint\b/.test(text)) found.add("checkpoint");
  return [...found].sort();
}

export function extractFromGuide(text) {
  // Commands: parse second column of "When to use it" table.
  // Safety: terminate only on `\n## ` (next H2) or EOF, not `\n# `.
  // handoff-guide.md contains a bash comment `# writes to docs/...` inside
  // a code block in `## Common patterns`; that line must not terminate
  // the "When to use it" section (which ends at the next H2 well before it).
  // Using `\n# ` here would be harmless today but becomes a trap if a code
  // example with a comment is ever added to the "When to use it" section.
  const whenSection = text.match(/## When to use it\s+([\s\S]*?)(?=\n## |$)/);
  if (!whenSection) {
    throw new Error("handoff-guide.md: could not find `## When to use it` section");
  }
  const commandSet = new Set();
  // Each non-header row: | <situation> | <sub-command cell> |
  // Extract all `word` tokens from second column where word is lowercase alpha.
  const rowRegex = /^\|[^|]+\|([^|]+)\|/gm;
  let m;
  while ((m = rowRegex.exec(whenSection[1])) !== null) {
    const cell = m[1];
    const verbRegex = /`([a-z]+)/g;
    let vm;
    while ((vm = verbRegex.exec(cell)) !== null) {
      commandSet.add(vm[1]);
    }
  }
  const commands = [...commandSet].sort();

  // Flags: scan "The five forms" and "Common patterns" sections.
  // Safety: terminates on `\n## ` (next H2) or `$` (EOF) only — no `\n# `.
  // `## Common patterns` contains a bash comment `# writes to docs/...`
  // inside a fenced code block; using `\n# ` here would silently truncate
  // that section and cause the flags in the code examples after the comment
  // to be missed.
  const flagSections = text.match(
    /(?:## The five forms|## Common patterns)[\s\S]*?(?=\n## |$)/g,
  );
  const flagTokens = new Set();
  for (const section of flagSections ?? []) {
    const flagRegex = /(?<![a-zA-Z0-9])(--[a-z][a-zA-Z0-9-]+|-o)(?![a-zA-Z0-9-])/g;
    let fm;
    while ((fm = flagRegex.exec(section)) !== null) {
      flagTokens.add(fm[1]);
    }
  }

  return {
    commands,
    flags_by_command: { "*": [...flagTokens].sort() },
    from_rule: extractFromRule(text),
    alias_mechanisms: extractAliasMechanisms(text),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handoff drift (ARCH-10) — Phase 1", () => {
  /** @type {HandoffSurface} */
  let skillSurface;
  /** @type {HandoffSurface} */
  let helpSurface;
  /** @type {HandoffSurface} */
  let guideSurface;

  beforeAll(() => {
    const skillText = readFileSync(SKILL_MD_PATH, "utf8");
    skillSurface = extractFromSkillMd(skillText);

    // The bin sources `$XDG_CONFIG_HOME/dotbabel/handoff.env` at startup
    // (default `$HOME/.config/...`). Point both HOME and XDG_CONFIG_HOME at
    // a fresh temp dir so a user's persisted handoff.env can't leak into the
    // test, and parallel vitest workers can't collide on the same path.
    const hermeticHome = mkdtempSync(resolve(tmpdir(), "handoff-drift-"));
    const help = execFileSync(process.execPath, [HANDOFF_BIN, "--help"], {
      encoding: "utf8",
      env: { ...process.env, HOME: hermeticHome, XDG_CONFIG_HOME: hermeticHome },
    });
    helpSurface = extractFromHelp(help);

    const guideText = readFileSync(GUIDE_MD_PATH, "utf8");
    guideSurface = extractFromGuide(guideText);
  });

  it("test-the-test: each extractor returns a HandoffSurface struct", () => {
    for (const [name, surface] of [
      ["SKILL.md", skillSurface],
      ["--help", helpSurface],
      ["guide", guideSurface],
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
          alias_mechanisms: expect.any(Array),
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
        surface.alias_mechanisms.every((m) => typeof m === "string"),
        `${name} alias_mechanisms`,
      ).toBe(true);
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
    const guideSet = new Set(guideSurface.commands);
    const intersection = helpSurface.commands
      .filter((c) => skillSet.has(c) && guideSet.has(c))
      .sort();
    expect(intersection).toEqual(PHASE_1_BASELINE_COMMANDS);
  });

  it("global-flag intersection across sources matches Phase 1 baseline", () => {
    const skillFlags = new Set(skillSurface.flags_by_command["*"] ?? []);
    const guideFlags = new Set(guideSurface.flags_by_command["*"] ?? []);
    const helpFlags = helpSurface.flags_by_command["*"] ?? [];
    const intersection = helpFlags
      .filter((f) => skillFlags.has(f) && guideFlags.has(f))
      .sort();
    expect(intersection).toEqual(PHASE_1_BASELINE_FLAGS_INTERSECTION);
  });

  it("alias mechanisms intersection across sources matches Phase 2 baseline (#158)", () => {
    const skillSet = new Set(skillSurface.alias_mechanisms);
    const guideSet = new Set(guideSurface.alias_mechanisms);
    const intersection = helpSurface.alias_mechanisms
      .filter((m) => skillSet.has(m) && guideSet.has(m))
      .sort();
    expect(intersection).toEqual(PHASE_2_BASELINE_ALIAS_MECHANISMS);
  });

  it("from_rule baseline matches in all sources", () => {
    expect(skillSurface.from_rule).toEqual(PHASE_1_BASELINE_FROM_RULE);
    expect(helpSurface.from_rule).toEqual(PHASE_1_BASELINE_FROM_RULE);
    expect(guideSurface.from_rule).toEqual(PHASE_1_BASELINE_FROM_RULE);
  });

  it("SKILL.md contains the fabrication-forbidden rule (KD-7)", () => {
    const text = readFileSync(SKILL_MD_PATH, "utf8");
    expect(extractFabricationRule(text)).toEqual({ present: true });
  });
});
