/**
 * copilot-frontmatter.mjs — maps Claude command/skill frontmatter onto
 * GitHub Copilot's `.prompt.md` / `.instructions.md` shape.
 *
 * Pure and I/O-free: every function takes strings/objects in, returns
 * strings/objects out. `project-sync.mjs` owns reading the source file and
 * writing the result.
 *
 * GitHub's schema (public preview, may drift — re-verify before relying on
 * this table long-term):
 *   .prompt.md:       description, name, argument-hint, agent, model, tools
 *   .instructions.md: description, name, applyTo (glob string; no tools key)
 *
 * The missing `tools` key on .instructions.md is why a skill's
 * `allowed-tools`/`tools` has nowhere to go — see INSTRUCTIONS_MD_KEY_RULES.
 */

import { createRequire } from "node:module";
import { parseFrontmatter } from "./build-index.mjs";

const require = createRequire(import.meta.url);
let _yamlMod;
function getYaml() {
  return (_yamlMod ??= require("js-yaml"));
}

/** First line of a generated frontmatter block's second line (a YAML comment,
 * invisible to any frontmatter parser's parsed output but a cheap prefix
 * check for "did dotbabel write this file"). Kept *after* the opening `---`
 * — not before it — because every mainstream frontmatter convention
 * (Jekyll, Hugo, gray-matter, and GitHub's own prompt/instructions files)
 * requires `---` on line 1. A banner ahead of it would make Copilot fail to
 * see the frontmatter at all. */
export const GENERATED_MARKER_PREFIX = "# dotbabel:generated";

/** Claude command key -> `.prompt.md` key. `tools`/`allowed-tools` are
 * handled outside this table (see `resolveToolsSource`) since they need
 * precedence logic, not a 1:1 rename. Any frontmatter key not listed here
 * (every dotbabel taxonomy key: id, type, version, domain, platform, task,
 * maturity, owner, created, updated, ...) is silently dropped — warning on
 * ~10 keys per file with no fix available would be pure noise. */
export const PROMPT_MD_KEY_RULES = Object.freeze({
  description: Object.freeze({ to: "description" }),
  name: Object.freeze({ to: "name" }),
  "argument-hint": Object.freeze({ to: "argument-hint" }),
  model: Object.freeze({ warnOnDrop: true }),
  effort: Object.freeze({ warnOnDrop: true }),
  "disable-model-invocation": Object.freeze({ warnOnDrop: true }),
});

/** Claude skill key -> `.instructions.md` key. `argument-hint` is
 * deliberately absent from this table (neither mapped nor warn-listed):
 * instructions.md has no per-invocation argument concept and never will, so
 * warning about it would be permanent, unactionable noise. */
export const INSTRUCTIONS_MD_KEY_RULES = Object.freeze({
  description: Object.freeze({ to: "description" }),
  name: Object.freeze({ to: "name" }),
  tools: Object.freeze({ warnOnDrop: true }),
  "allowed-tools": Object.freeze({ warnOnDrop: true }),
  model: Object.freeze({ warnOnDrop: true }),
  effort: Object.freeze({ warnOnDrop: true }),
  "disable-model-invocation": Object.freeze({ warnOnDrop: true }),
});

/** `.instructions.md` has no Claude-side source for `applyTo` — every
 * generated skill instructions file applies repo-wide. */
export const DEFAULT_APPLY_TO = "**";

/**
 * Apply a key-rules table to a frontmatter object: a listed key with `to`
 * is renamed into `mapped`; a listed key with `warnOnDrop` is reported in
 * `dropped`; an unlisted key is silently ignored.
 *
 * @param {object} frontmatter
 * @param {Record<string, {to?: string, warnOnDrop?: boolean}>} rules
 * @returns {{ mapped: object, dropped: string[] }}
 */
function applyKeyRules(frontmatter, rules) {
  const mapped = {};
  const dropped = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    const rule = rules[key];
    if (!rule) continue;
    if (rule.to) mapped[rule.to] = value;
    else if (rule.warnOnDrop) dropped.push(key);
  }
  return { mapped, dropped };
}

/**
 * Normalize a Claude `tools`/`allowed-tools` value into a deduped array of
 * tool names. Real files use both a space-separated string
 * (`allowed-tools: Read Grep Glob Bash`) and a comma-separated string
 * (`tools: Read, Grep, Glob`), sometimes in the same file — accept both.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeToolsList(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map(String).map((s) => s.trim()).filter(Boolean))];
  }
  if (typeof raw === "string") {
    return [
      ...new Set(
        raw
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
  }
  return [];
}

/**
 * Which frontmatter key names the tools grant, when both are present.
 * `allowed-tools` wins — it's the more specific, more recently-adopted key.
 *
 * @param {object} frontmatter
 * @returns {unknown}
 */
function resolveToolsSource(frontmatter) {
  if (frontmatter["allowed-tools"] !== undefined) {
    return frontmatter["allowed-tools"];
  }
  if (frontmatter.tools !== undefined) return frontmatter.tools;
  return undefined;
}

/**
 * Map a Claude command's frontmatter onto `.prompt.md` shape.
 *
 * @param {object} frontmatter
 * @returns {{ frontmatter: object, dropped: string[] }}
 */
export function mapCommandFrontmatter(frontmatter) {
  const toolsValue = resolveToolsSource(frontmatter);
  const rest = { ...frontmatter };
  delete rest["allowed-tools"];
  delete rest.tools;
  const { mapped, dropped } = applyKeyRules(rest, PROMPT_MD_KEY_RULES);
  if (toolsValue !== undefined) mapped.tools = normalizeToolsList(toolsValue);
  return { frontmatter: mapped, dropped };
}

/**
 * Map a Claude skill's frontmatter onto `.instructions.md` shape.
 *
 * @param {object} frontmatter
 * @returns {{ frontmatter: object, dropped: string[] }}
 */
export function mapSkillFrontmatter(frontmatter) {
  const { mapped, dropped } = applyKeyRules(
    frontmatter,
    INSTRUCTIONS_MD_KEY_RULES,
  );
  mapped.applyTo = DEFAULT_APPLY_TO;
  return { frontmatter: mapped, dropped };
}

/**
 * Render a plain object as a YAML frontmatter body (the lines between the
 * `---` delimiters, each ending in `\n`; empty string for an empty object).
 *
 * @param {object} obj
 * @returns {string}
 */
export function renderFrontmatterBlock(obj) {
  if (Object.keys(obj).length === 0) return "";
  return getYaml().dump(obj);
}

/**
 * Whether `content` is a file this module generated: `---` on line 1 (so any
 * frontmatter-aware tool, dotbabel's own `parseFrontmatter` included, still
 * sees a well-formed block) and the marker comment on line 2.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function isGeneratedFile(content) {
  if (typeof content !== "string") return false;
  const lines = content.split("\n");
  return (
    lines[0]?.trim() === "---" &&
    (lines[1]?.trimStart().startsWith(GENERATED_MARKER_PREFIX) ?? false)
  );
}

/**
 * Compose a generated Copilot file from a Claude source file's raw text.
 *
 * @param {string} sourceText
 * @param {"command"|"skill"} kind
 * @param {string} relSourcePath  Repo-relative path to the Claude source, for the marker comment.
 * @returns {{ content: string, dropped: string[] }}
 */
export function composeGeneratedFrontmatter(sourceText, kind, relSourcePath) {
  const { frontmatter, body } = parseFrontmatter(sourceText);
  const { frontmatter: mapped, dropped } =
    kind === "command"
      ? mapCommandFrontmatter(frontmatter)
      : mapSkillFrontmatter(frontmatter);
  const marker = `${GENERATED_MARKER_PREFIX} — do not edit directly. Source: ${relSourcePath}. Regenerate with \`dotbabel project-sync\`.`;
  const yamlLines = renderFrontmatterBlock(mapped);
  const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
  const content = `---\n${marker}\n${yamlLines}---\n\n${trimmedBody}\n`;
  return { content, dropped };
}
