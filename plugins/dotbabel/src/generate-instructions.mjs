import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import {
  loadFacts,
  readText,
} from "./spec-harness-lib.mjs";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

/**
 * @typedef {"synthesize" | "inject"} TargetMode
 *
 * @typedef {object} CliTarget
 * @property {string} relativeOutputPath  Repo-relative POSIX path to write.
 * @property {readonly string[]} cliSet   Set of CLI ids the file serves.
 *                                        A `<!-- dotbabel:cli ... -->` span is
 *                                        included only when its tag-set is a
 *                                        superset of this set (i.e. the span's
 *                                        content applies to every CLI the file
 *                                        serves). Unmarked content always
 *                                        applies.
 * @property {string} substitutionKey     Key into `cli_substitutions` map in
 *                                        repo-facts.json. The `_default_` map
 *                                        is applied first (project-wide
 *                                        canonical->canonical aliases) and the
 *                                        per-key map second (e.g. `copilot`).
 * @property {TargetMode} mode            "synthesize" writes the entire file;
 *                                        "inject" replaces only the rule-floor
 *                                        block (delimited by RULE_FLOOR_BEGIN/END
 *                                        markers) inside an existing host file.
 */

/**
 * Default targets emitted when the caller passes no `targets` override.
 *
 * INJECT targets are pre-existing hand-authored files that already cover their
 * own audience (build commands, project structure, etc.); the generator only
 * manages the delimited rule-floor block inside them. SYNTHESIZE targets are
 * fully written by the generator (used for user-scope template files that have
 * no hand-authored content).
 *
 * AGENTS.md is shared between Copilot and Codex (both CLIs read the same
 * filename at the project root), so its serve-set is `{copilot, codex}` and
 * any CLI-conditional span must cover both for its content to land there.
 */
export const DEFAULT_TARGETS = Object.freeze([
  Object.freeze({
    relativeOutputPath: "AGENTS.md",
    cliSet: Object.freeze(["copilot", "codex"]),
    substitutionKey: "agents",
    mode: "inject",
  }),
  Object.freeze({
    relativeOutputPath: "GEMINI.md",
    cliSet: Object.freeze(["gemini"]),
    substitutionKey: "gemini",
    mode: "inject",
  }),
  Object.freeze({
    relativeOutputPath: ".github/copilot-instructions.md",
    cliSet: Object.freeze(["copilot"]),
    substitutionKey: "copilot",
    mode: "inject",
  }),
  Object.freeze({
    relativeOutputPath: "plugins/dotbabel/templates/cli-instructions/copilot-instructions.md",
    cliSet: Object.freeze(["copilot"]),
    substitutionKey: "copilot",
    mode: "synthesize",
  }),
  Object.freeze({
    relativeOutputPath: "plugins/dotbabel/templates/cli-instructions/codex-AGENTS.md",
    cliSet: Object.freeze(["codex"]),
    substitutionKey: "codex",
    mode: "synthesize",
  }),
  Object.freeze({
    relativeOutputPath: "plugins/dotbabel/templates/cli-instructions/gemini-GEMINI.md",
    cliSet: Object.freeze(["gemini"]),
    substitutionKey: "gemini",
    mode: "synthesize",
  }),
]);

/** Repo-relative path for the per-target manifest written alongside outputs. */
export const MANIFEST_RELATIVE_PATH =
  "plugins/dotbabel/templates/cli-instructions/.manifest.json";

/** Deterministic auto-generated banner written into every output file. */
export const BANNER =
  "<!-- AUTO-GENERATED FROM CLAUDE.md by dotbabel-generate-instructions. Do not edit. -->";

/** Marker that opens a rule-floor block in CLAUDE.md and host files. */
export const RULE_FLOOR_BEGIN = "<!-- dotbabel:rule-floor:begin -->";
/** Marker that closes a rule-floor block in CLAUDE.md and host files. */
export const RULE_FLOOR_END = "<!-- dotbabel:rule-floor:end -->";
const INJECT_FALLBACK_HEADING = "## Universal rule floor";

const SPAN_OPEN_RE =
  /^<!--\s*dotbabel:cli\s+([a-z0-9,]+(?:\s+[a-z0-9,]+)*)\s*-->\s*$/;
const SPAN_END_RE = /^<!--\s*dotbabel:end\s*-->\s*$/;
const HEADING_RE = /^(#{1,2})\s+(\S.*)$/;
const FENCE_RE = /^([`~]{3,})/;

/**
 * Parse a `<!-- dotbabel:cli a b c -->` opener into a normalized tag-set.
 *
 * @param {string} raw  The raw inner directive text (e.g. "copilot codex").
 * @returns {Set<string>}
 */
function parseTagSet(raw) {
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * @param {Set<string>} superSet
 * @param {readonly string[]} subSet
 * @returns {boolean}
 */
function isSuperset(superSet, subSet) {
  for (const s of subSet) {
    if (!superSet.has(s)) return false;
  }
  return true;
}

/**
 * Render the canonical CLAUDE.md text for a single output target.
 *
 * Applies `<!-- dotbabel:cli ... -->` span filtering and substitutions. The
 * output retains `<!-- dotbabel:rule-floor:begin/end -->` markers so callers
 * can either keep them (synthesize) or extract the slice between them
 * (inject). The auto-generated banner is NOT prepended here — `composeOutput`
 * adds it in the right position for each mode.
 *
 * Span semantics:
 *  - Span markers must be on their own line, at column 0, outside any open
 *    fenced code block. Otherwise they are treated as literal text.
 *  - A span is INCLUDED iff its tag-set ⊇ `target.cliSet`. Unmarked content is
 *    always included.
 *  - Open / close marker lines are stripped from output regardless of inclusion.
 *  - Nested spans (`open` before previous `end`) → throws DRIFT_NESTED_SPAN.
 *  - Unclosed spans (EOF inside a span) → throws DRIFT_UNCLOSED_SPAN.
 *
 * Returns the rendered body plus the list of `# / ##` headings that would have
 * been emitted but were dropped because their containing span did NOT match —
 * Gate C consults this list when distinguishing legitimate from illegitimate
 * heading omissions.
 *
 * @param {string} sourceText
 * @param {CliTarget} target
 * @param {Record<string, Record<string, string>>} substitutions
 * @returns {{ body: string, omittedHeadings: string[] }}
 */
export function renderTarget(sourceText, target, substitutions) {
  const lines = sourceText.split("\n");
  const out = [];
  /** @type {string[]} */
  const omittedHeadings = [];

  /** @type {{ included: boolean, lineNumber: number } | null} */
  let activeSpan = null;
  /** @type {string | null} */
  let openFence = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (openFence === null) {
      const m = line.match(FENCE_RE);
      if (m) openFence = m[1];
    } else {
      const m = line.match(FENCE_RE);
      if (m && m[1].length >= openFence.length && m[1][0] === openFence[0]) {
        openFence = null;
      }
      if (activeSpan === null || activeSpan.included) out.push(line);
      continue;
    }

    const openMatch = line.match(SPAN_OPEN_RE);
    if (openMatch) {
      if (activeSpan !== null) {
        throw new ValidationError({
          code: ERROR_CODES.DRIFT_NESTED_SPAN,
          category: "drift",
          file: "CLAUDE.md",
          line: i + 1,
          message: `dotbabel:cli span opened on line ${i + 1} while a previous span (line ${activeSpan.lineNumber}) is still open — nested spans are not supported`,
          hint: "close the outer span with <!-- dotbabel:end --> first",
        });
      }
      const tags = parseTagSet(openMatch[1]);
      activeSpan = {
        included: isSuperset(tags, target.cliSet),
        lineNumber: i + 1,
      };
      continue;
    }

    const endMatch = line.match(SPAN_END_RE);
    if (endMatch) {
      if (activeSpan === null) {
        throw new ValidationError({
          code: ERROR_CODES.DRIFT_UNCLOSED_SPAN,
          category: "drift",
          file: "CLAUDE.md",
          line: i + 1,
          message: `dotbabel:end on line ${i + 1} has no matching dotbabel:cli opener`,
          hint: "remove the orphan dotbabel:end marker",
        });
      }
      activeSpan = null;
      continue;
    }

    if (activeSpan === null || activeSpan.included) {
      out.push(line);
    } else {
      const hm = line.match(HEADING_RE);
      if (hm) omittedHeadings.push(hm[2].trim());
    }
  }

  if (activeSpan !== null) {
    throw new ValidationError({
      code: ERROR_CODES.DRIFT_UNCLOSED_SPAN,
      category: "drift",
      file: "CLAUDE.md",
      line: activeSpan.lineNumber,
      message: `dotbabel:cli span opened on line ${activeSpan.lineNumber} is never closed`,
      hint: "add a matching <!-- dotbabel:end -->",
    });
  }

  let body = out.join("\n");
  const orderedMaps = [
    substitutions._default_ ?? {},
    substitutions[target.substitutionKey] ?? {},
  ];
  for (const map of orderedMaps) {
    const needles = Object.keys(map).sort((a, b) => b.length - a.length);
    for (const needle of needles) {
      const replacement = map[needle];
      if (typeof replacement !== "string") continue;
      body = body.split(needle).join(replacement);
    }
  }

  return { body, omittedHeadings };
}

/**
 * Strip the rule-floor marker LINES from a rendered body, preserving content
 * between them. Used by synthesize-mode targets, where the full rendered text
 * becomes the file contents.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripRuleFloorMarkers(body) {
  return body
    .split("\n")
    .filter(
      (l) =>
        l.trim() !== RULE_FLOOR_BEGIN && l.trim() !== RULE_FLOOR_END,
    )
    .join("\n");
}

/**
 * Extract the slice between rule-floor markers from a rendered body.
 *
 * Throws DRIFT_UNCLOSED_SPAN if either marker is missing.
 *
 * @param {string} body
 * @returns {string}
 */
export function extractRuleFloor(body) {
  const lines = body.split("\n");
  const beginIdx = lines.findIndex((l) => l.trim() === RULE_FLOOR_BEGIN);
  const endIdx = lines.findIndex((l) => l.trim() === RULE_FLOOR_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new ValidationError({
      code: ERROR_CODES.DRIFT_UNCLOSED_SPAN,
      category: "drift",
      file: "CLAUDE.md",
      message:
        "rule-floor markers missing or out of order — CLAUDE.md must contain a <!-- dotbabel:rule-floor:begin --> ... <!-- dotbabel:rule-floor:end --> pair",
      hint: "add the marker pair around the rule-floor section in CLAUDE.md",
    });
  }
  return lines.slice(beginIdx + 1, endIdx).join("\n").trim();
}

/**
 * Compute the final file content for a synthesize target.
 *
 * @param {string} renderedBody
 * @returns {string}
 */
function composeSynthesize(renderedBody) {
  return normalizeGeneratedMarkdown(`${BANNER}\n\n${stripRuleFloorMarkers(renderedBody)}`);
}

/**
 * Compute the new content of a host file by replacing or appending a
 * delimited rule-floor block. Throws when the host file has only one of the
 * two markers (mismatched / corrupted state).
 *
 * @param {string} existingHostText
 * @param {string} ruleFloor   The body to place inside the markers (no banner).
 * @param {string} relativeOutputPath
 * @returns {string}
 */
function composeInject(existingHostText, ruleFloor, relativeOutputPath) {
  const blockBody = `${BANNER}\n\n${normalizeGeneratedMarkdown(ruleFloor).trimEnd()}`;
  const block = `${RULE_FLOOR_BEGIN}\n${blockBody}\n\n${RULE_FLOOR_END}`;

  const lines = existingHostText.split("\n");
  const beginLine = lines.findIndex((l) => l.trim() === RULE_FLOOR_BEGIN);
  const endLine = lines.findIndex(
    (l, idx) => idx > beginLine && l.trim() === RULE_FLOOR_END,
  );

  if (beginLine !== -1 && endLine !== -1) {
    const before = lines.slice(0, beginLine).join("\n");
    const after = lines.slice(endLine + 1).join("\n");
    const updated = `${before}${before ? "\n" : ""}${block}${after ? `\n${after}` : ""}`;
    return existingHostText.endsWith("\n") && !updated.endsWith("\n")
      ? `${updated}\n`
      : updated;
  }

  if (beginLine === -1 && endLine === -1) {
    // First-run bootstrap: append a section.
    const trimmed = existingHostText.replace(/\s+$/, "");
    const sep = trimmed.length === 0 ? "" : "\n\n";
    return `${trimmed}${sep}${INJECT_FALLBACK_HEADING}\n\n${block}\n`;
  }

  throw new ValidationError({
    code: ERROR_CODES.DRIFT_UNCLOSED_SPAN,
    category: "drift",
    file: relativeOutputPath,
    message:
      "rule-floor markers are mismatched — host file has only one of <!-- dotbabel:rule-floor:begin --> / <!-- dotbabel:rule-floor:end -->",
    hint: "remove the orphan marker so the generator can re-add a clean pair on next run",
  });
}

/**
 * Generate every CLI-flavored instruction file from `CLAUDE.md` and write
 * them to disk, plus a `.manifest.json` recording per-file conditional-span
 * heading omissions.
 *
 * @param {object} ctx
 * @param {string} ctx.repoRoot
 * @param {object} [opts]
 * @param {readonly CliTarget[]} [opts.targets]
 * @param {boolean} [opts.dryRun]
 * @returns {{ ok: boolean, files: { path: string, content: string, mode: TargetMode, omittedHeadings: string[] }[], manifest: object }}
 */
export function generateInstructions(ctx, opts = {}) {
  const targets = opts.targets ?? DEFAULT_TARGETS;
  const facts = loadFacts(ctx);
  const substitutions = validateSubstitutions(facts.cli_substitutions);
  const sourceText = readText(ctx, "CLAUDE.md");

  /** @type {{ path: string, content: string, mode: TargetMode, omittedHeadings: string[] }[]} */
  const files = [];
  /** @type {Record<string, { cliSet: string[], mode: TargetMode, omittedHeadings: string[] }>} */
  const manifestEntries = {};

  for (const target of targets) {
    const { body, omittedHeadings } = renderTarget(
      sourceText,
      target,
      substitutions,
    );

    let content;
    if (target.mode === "inject") {
      const ruleFloor = extractRuleFloor(body);
      const absHost = path.join(ctx.repoRoot, target.relativeOutputPath);
      const existing = existsSync(absHost)
        ? readFileSync(absHost, "utf8")
        : "";
      content = composeInject(existing, ruleFloor, target.relativeOutputPath);
    } else {
      content = composeSynthesize(body);
    }

    files.push({
      path: target.relativeOutputPath,
      content,
      mode: target.mode,
      omittedHeadings,
    });
    manifestEntries[target.relativeOutputPath] = {
      cliSet: [...target.cliSet],
      mode: target.mode,
      omittedHeadings,
    };
  }

  const manifest = {
    source: "CLAUDE.md",
    generator: "dotbabel-generate-instructions",
    targets: manifestEntries,
  };
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;

  if (!opts.dryRun) {
    for (const file of files) {
      const abs = path.join(ctx.repoRoot, file.path);
      ensureParentDir(abs);
      writeFileSync(abs, file.content);
    }
    const manifestAbs = path.join(ctx.repoRoot, MANIFEST_RELATIVE_PATH);
    ensureParentDir(manifestAbs);
    writeFileSync(manifestAbs, manifestContent);
  }

  return {
    ok: true,
    files: [
      ...files,
      {
        path: MANIFEST_RELATIVE_PATH,
        content: manifestContent,
        mode: "synthesize",
        omittedHeadings: [],
      },
    ],
    manifest,
  };
}

function ensureParentDir(absPath) {
  mkdirSync(path.dirname(absPath), { recursive: true });
}

function normalizeGeneratedMarkdown(content) {
  return `${content
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/g, "")}\n`;
}

/**
 * Walk a markdown body and return its `#`/`##` headings, ignoring lines inside
 * fenced code blocks. Reused by Gate C so the generator and the parity gate
 * share one regex / fence-tracking implementation.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractHeadings(markdown) {
  const headings = [];
  let openFence = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = line.match(FENCE_RE);
    if (openFence === null) {
      if (fenceMatch) openFence = fenceMatch[1];
    } else {
      if (
        fenceMatch &&
        fenceMatch[1].length >= openFence.length &&
        fenceMatch[1][0] === openFence[0]
      ) {
        openFence = null;
      }
      continue;
    }
    const hm = line.match(HEADING_RE);
    if (hm) headings.push(hm[2].trim());
  }
  return headings;
}

function validateSubstitutions(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError({
      code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
      category: "drift",
      file: "docs/repo-facts.json",
      pointer: "cli_substitutions",
      message: "cli_substitutions must be an object mapping target keys to substitution maps",
    });
  }
  for (const [key, map] of Object.entries(raw)) {
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      throw new ValidationError({
        code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
        category: "drift",
        file: "docs/repo-facts.json",
        pointer: `cli_substitutions.${key}`,
        message: `cli_substitutions.${key} must be a string→string map`,
      });
    }
    for (const [needle, replacement] of Object.entries(map)) {
      if (typeof replacement !== "string") {
        throw new ValidationError({
          code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
          category: "drift",
          file: "docs/repo-facts.json",
          pointer: `cli_substitutions.${key}.${needle}`,
          message: `cli_substitutions.${key}.${JSON.stringify(needle)} must be a string`,
        });
      }
    }
  }
  return raw;
}

export { ERROR_CODES };
