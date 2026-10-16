#!/usr/bin/env node
/**
 * check-review.mjs
 *
 * Deterministic checks for the language-review skill. The skill's editorial
 * judgment is subjective and is never tested here. This file covers the two
 * parts that are not subjective:
 *
 *   preserve  Does a suggested revision keep every protected token of the
 *             original: placeholders, ICU syntax, markup, code spans, URLs,
 *             identifiers, fixed terms, and Markdown structure?
 *   validate  Does a JSON review follow the output contract in
 *             references/output-contract.md?
 *   extract   List the protected tokens of a text.
 *
 * The skill itself is read-only and has no shell, so a person or a CI job runs
 * this file. It has no dependencies, reads files, and never writes one.
 *
 * Usage:
 *   node check-review.mjs preserve --original <file|-> --revised <file|-> [options]
 *   node check-review.mjs validate <review.json|-> [options]
 *   node check-review.mjs extract <file|-> [options]
 *
 * Exit codes: 0 ok, 1 violation, 2 input could not be read, 64 usage.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXIT = { OK: 0, VIOLATION: 1, ENV: 2, USAGE: 64 };

/** Issue categories: the ten assessed dimensions, then three supporting ones. */
export const CATEGORIES = [
  "naturalness",
  "idiom",
  "lexical-choice",
  "syntax",
  "register",
  "cohesion",
  "regional-fit",
  "fidelity",
  "artificial-style",
  "clarity",
  "mechanics",
  "consistency",
  "markup",
];
/** Severities, from a wrong or harmful text to an acceptable alternative. */
export const SEVERITIES = ["critical", "major", "minor", "preference"];
/** Confidence levels for a finding. */
export const CONFIDENCES = ["high", "medium", "low"];
/** Overall verdicts. Each follows from the severities and confidences of the findings. */
export const VERDICTS = ["natural", "minor-polish", "needs-revision"];

const CLDR_PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
const TRANSLATABLE_ATTRS = new Set([
  "alt",
  "title",
  "placeholder",
  "label",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "summary",
]);
const ICU_OPTION_TYPES = new Set(["plural", "select", "selectordinal"]);
const BIDI_CLASS = "\\u200E\\u200F\\u061C\\u202A-\\u202E\\u2066-\\u2069";
const BIDI_RE = new RegExp(`[${BIDI_CLASS}]`, "g");
const INVISIBLE_RE = /[\u00A0\u200B-\u200F\u061C\u202A-\u202F\u2060-\u2069\uFEFF]/g;
const FILL = "\uE000";

/** Show invisible characters as \uXXXX so a report can name them. */
function show(value) {
  return value.replace(
    INVISIBLE_RE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
}

class IcuError extends Error {}

/** @param {string} s @param {number} i @returns {number} index after a quoted section */
function skipQuote(s, i) {
  if (s[i + 1] === "'") return i + 2;
  if (s[i + 1] === "{" || s[i + 1] === "}") {
    const close = s.indexOf("'", i + 2);
    return close === -1 ? s.length : close + 1;
  }
  return i + 1;
}

function parseIcuMessage(s, j, ctx, inPlural) {
  while (j < s.length) {
    const c = s[j];
    if (c === "}") {
      ctx.ranges.push([j, j + 1]);
      return j + 1;
    }
    if (c === "{") {
      j = parseIcuArgument(s, j, ctx, inPlural);
      continue;
    }
    if (c === "'") {
      j = skipQuote(s, j);
      continue;
    }
    if (c === "#" && inPlural) {
      ctx.tokens.push({ kind: "icu-hash", value: "#", pos: j });
      ctx.ranges.push([j, j + 1]);
    }
    j++;
  }
  throw new IcuError("unterminated message");
}

function readUntil(s, j, stops) {
  let out = "";
  while (j < s.length && !stops.includes(s[j])) out += s[j++];
  return [out, j];
}

function parseIcuArgument(s, start, ctx, inPlural) {
  let [name, j] = readUntil(s, start + 1, [",", "}", "{"]);
  if (j >= s.length) throw new IcuError(`unterminated argument at offset ${start}`);
  if (s[j] === "{") throw new IcuError(`unexpected "{" inside an argument at offset ${j}`);
  name = name.trim();
  if (s[j] === "}") {
    ctx.tokens.push({ kind: "placeholder", value: `{${name}}`, pos: start });
    ctx.ranges.push([start, j + 1]);
    return j + 1;
  }
  let type;
  [type, j] = readUntil(s, j + 1, [",", "}", "{"]);
  type = type.trim();
  if (j >= s.length) throw new IcuError(`unterminated argument at offset ${start}`);
  if (s[j] === "{") throw new IcuError(`unexpected "{" inside an argument at offset ${j}`);
  if (s[j] === "}") {
    ctx.tokens.push({ kind: "icu-arg", value: `{${name},${type}}`, pos: start });
    ctx.ranges.push([start, j + 1]);
    return j + 1;
  }
  j++;
  if (!ICU_OPTION_TYPES.has(type)) {
    let style;
    [style, j] = readUntil(s, j, ["}", "{"]);
    if (j >= s.length || s[j] === "{") {
      throw new IcuError(`unterminated ${type} argument at offset ${start}`);
    }
    const tail = style.trim().replace(/\s+/g, " ");
    ctx.tokens.push({
      kind: "icu-arg",
      value: tail ? `{${name},${type},${tail}}` : `{${name},${type}}`,
      pos: start,
    });
    ctx.ranges.push([start, j + 1]);
    return j + 1;
  }
  ctx.tokens.push({ kind: "icu-arg", value: `{${name},${type}}`, pos: start });
  ctx.ranges.push([start, j]);
  const nestedPlural = type === "select" ? inPlural : true;
  for (;;) {
    while (j < s.length && /\s/.test(s[j])) j++;
    if (j >= s.length) throw new IcuError(`unterminated ${type} argument at offset ${start}`);
    if (s[j] === "}") {
      ctx.ranges.push([j, j + 1]);
      return j + 1;
    }
    const selectorStart = j;
    let selector;
    [selector, j] = readUntil(s, j, [" ", "\t", "\n", "\r", "{", "}"]);
    if (selector === "") throw new IcuError(`expected a selector at offset ${j}`);
    while (j < s.length && /\s/.test(s[j])) j++;
    if (/^offset:/.test(selector)) {
      ctx.tokens.push({ kind: "icu-offset", value: `${name}.${selector}`, pos: selectorStart });
      ctx.ranges.push([selectorStart, j]);
      continue;
    }
    if (s[j] !== "{") {
      throw new IcuError(`expected "{" after selector "${selector}" at offset ${j}`);
    }
    ctx.tokens.push({ kind: "icu-selector", value: `${name}.${selector}`, pos: selectorStart });
    ctx.ranges.push([selectorStart, j + 1]);
    j = parseIcuMessage(s, j + 1, ctx, nestedPlural);
  }
}

/**
 * Parse ICU MessageFormat in `s`. Fills `tokens` and `ranges` (the syntax
 * characters, so later passes do not read them again) and returns the first
 * syntax error, or null.
 *
 * @param {string} s
 * @param {{tokens: object[], ranges: number[][]}} ctx
 * @returns {string|null}
 */
function parseIcu(s, ctx) {
  try {
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "'") i = skipQuote(s, i);
      else if (c === "{") i = parseIcuArgument(s, i, ctx, false);
      else if (c === "}") throw new IcuError(`unexpected "}" at offset ${i}`);
      else i++;
    }
    return null;
  } catch (err) {
    if (err instanceof IcuError) return err.message;
    throw err;
  }
}

function trimUrl(url) {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (last && /[.,;:!?»”’'"…،؛؟*_]/.test(last)) {
      u = u.slice(0, -1);
      continue;
    }
    const pairs = { ")": "(", "]": "[", "}": "{" };
    if (last && pairs[last]) {
      const opens = u.split(pairs[last]).length - 1;
      const closes = u.split(last).length - 1;
      if (closes > opens) {
        u = u.slice(0, -1);
        continue;
      }
    }
    return u;
  }
}

/**
 * List the tokens of `text` that a revision must keep: placeholders in every
 * common syntax, ICU structure, tags and their non-translatable attributes,
 * code, URLs, e-mail addresses, identifiers, Markdown structure, bidi marks,
 * and any fixed terms the caller names.
 *
 * @param {string} text
 * @param {{preserve?: string[]}} [options]
 * @returns {{tokens: Array<{kind: string, value: string, pos: number}>, errors: string[]}}
 */
export function extractProtectedTokens(text, { preserve = [] } = {}) {
  const mask = text.split("");
  const tokens = [];
  const errors = [];

  const blank = (start, end) => {
    for (let k = start; k < end; k++) if (mask[k] !== "\n") mask[k] = FILL;
  };
  /** Run `re` over the current mask; `handle(m)` returns the kept end offset or undefined. */
  const pass = (re, handle) => {
    const view = mask.join("");
    for (const m of view.matchAll(re)) {
      const kept = handle(m);
      blank(m.index, kept ?? m.index + m[0].length);
    }
  };
  const push = (kind, value, pos) => {
    tokens.push({ kind, value, pos });
  };

  pass(/^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?\n {0,3}\1[ \t]*$/gm, (m) => {
    push("code-fence", text.slice(m.index, m.index + m[0].length).trimEnd(), m.index);
  });
  pass(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m) => {
    push("code-span", text.slice(m.index, m.index + m[0].length), m.index);
  });
  pass(/<!--[\s\S]*?-->/g, (m) => {
    push("comment", text.slice(m.index, m.index + m[0].length), m.index);
  });
  pass(/<((?:https?|ftp|mailto):[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/g, (m) => {
    push("url", m[1], m.index);
  });
  pass(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s+[^<>]*?)?\s*\/?>|<\/?\d+\s*\/?>/g, (m) => {
    const raw = text.slice(m.index, m.index + m[0].length);
    const parts = raw.match(/^<(\/?)([A-Za-z0-9][A-Za-z0-9:-]*)([\s\S]*?)(\/?)>$/);
    const [, closing, name, rest, selfClosing] = parts;
    push("tag", closing ? `</${name}>` : selfClosing ? `<${name}/>` : `<${name}>`, m.index);
    if (closing) return;
    for (const a of rest.matchAll(
      /([A-Za-z_:@][-\w:.@]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
    )) {
      const attr = a[1].toLowerCase();
      if (TRANSLATABLE_ATTRS.has(attr)) {
        push("attr", `${name}@${attr}`, m.index);
      } else {
        push("attr", `${name}@${attr}=${a[2] ?? a[3] ?? a[4] ?? ""}`, m.index);
      }
    }
  });
  pass(
    /\]\(\s*(<[^>\n]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g,
    (m) => {
      const dest = m[1].replace(/^<|>$/g, "");
      if (dest) push("link-dest", dest, m.index);
    },
  );
  pass(/^ {0,3}\[[^\]\n]+\]:[ \t]*(\S+)/gm, (m) => {
    push("link-dest", m[1].replace(/^<|>$/g, ""), m.index);
  });
  pass(
    new RegExp(
      `(?:\\b(?:https?|ftp):\\/\\/|\\bmailto:|\\bwww\\.)[^\\s<>"'${BIDI_CLASS}${FILL}]+`,
      "giu",
    ),
    (m) => {
      const url = trimUrl(m[0]);
      push("url", url, m.index);
      return m.index + url.length;
    },
  );
  pass(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, (m) => {
    push("email", m[0], m.index);
  });
  pass(/\{\{[^{}]*\}\}/g, (m) => push("template", `{{${m[0].slice(2, -2).trim()}}}`, m.index));
  pass(/\$\{[^{}]*\}/g, (m) => push("template", m[0], m.index));
  pass(/%\{[^{}]*\}/g, (m) => push("template", m[0], m.index));
  pass(/%\([A-Za-z_]\w*\)[#0\- +]*\d*(?:\.\d+)?[sdifrxXeEgGc]/g, (m) =>
    push("template", m[0], m.index),
  );
  pass(/\$t\([^()]*\)/g, (m) => push("template", m[0], m.index));
  pass(
    /%(?:\d+\$)?[-+0#]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|h|ll|l|L|z|j|t)?[diouxXeEfFgGaAcspn%]/g,
    (m) => push("format", m[0], m.index),
  );

  if (mask.includes("{") || mask.includes("}")) {
    const ctx = { tokens, ranges: [] };
    const error = parseIcu(mask.join(""), ctx);
    if (error) errors.push(`ICU syntax: ${error}`);
    for (const [a, b] of ctx.ranges) blank(a, b);
  }

  pass(/&(?:[A-Za-z][A-Za-z0-9]{1,31}|#\d{1,7}|#[xX][0-9A-Fa-f]{1,6});/g, (m) =>
    push("entity", m[0], m.index),
  );

  const terms = [...new Set(preserve.filter((t) => typeof t === "string" && t !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = /^[A-Za-z0-9_]/.test(term) ? "(?<![A-Za-z0-9_])" : "";
    const after = /[A-Za-z0-9_]$/.test(term) ? "(?![A-Za-z0-9_])" : "";
    pass(new RegExp(`${before}${escaped}${after}`, "g"), (m) => push("term", term, m.index));
  }

  pass(/(?<![\p{L}\p{N}_/.~-])(?:~|\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)*/gu, (m) => {
    const path = m[0].replace(/[.-]+$/, "");
    push("identifier", path, m.index);
    return m.index + path.length;
  });
  pass(/(?<![\p{L}\p{N}_.])[A-Za-z_]\w+(?:\.[A-Za-z_]\w+)+(?![\p{L}\p{N}_])/gu, (m) =>
    push("identifier", m[0], m.index),
  );
  pass(
    /(?<![\p{L}\p{N}_])(?=[A-Za-z0-9]*(?:[a-z][A-Z]|[A-Z][A-Z][a-z]))[A-Za-z][A-Za-z0-9]*(?![\p{L}\p{N}_])/gu,
    (m) => {
      // Plural acronyms (PDFs, APIs) are ordinary prose, not identifiers.
      if (/^[A-Z0-9]+s$/.test(m[0])) return m.index;
      push("identifier", m[0], m.index);
      return undefined;
    },
  );
  pass(/(?<![\p{L}\p{N}_])[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+(?![\p{L}\p{N}_])/gu, (m) =>
    push("identifier", m[0], m.index),
  );
  pass(/(?<![\w-])--[A-Za-z][A-Za-z0-9-]*/g, (m) => push("identifier", m[0], m.index));
  pass(/(?<![\w$])\$[A-Z_][A-Z0-9_]+/g, (m) => push("identifier", m[0], m.index));

  collectMarkdown(mask.join(""), push);

  for (const m of text.matchAll(BIDI_RE)) {
    push("bidi", `U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`, m.index);
  }

  tokens.sort((a, b) => a.pos - b.pos);
  return { tokens, errors };
}

/**
 * Markdown structure from the masked text: headings, list items, quotes, table
 * rows, rules, and strong or emphasis spans. Code is already masked out.
 *
 * @param {string} masked
 * @param {(kind: string, value: string, pos: number) => void} push
 */
function collectMarkdown(masked, push) {
  let offset = 0;
  for (const line of masked.split("\n")) {
    const pos = offset;
    offset += line.length + 1;
    let rest = line;
    let m;
    if ((m = line.match(/^ {0,3}(#{1,6})(?:\s|$)/))) push("md", `heading:${m[1].length}`, pos);
    else if (/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) {
      push("md", "table-sep", pos);
      continue;
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|").length;
      push("md", `table-row:${cells}`, pos);
    } else if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      push("md", "rule", pos);
      continue;
    } else if (/^ {0,3}>/.test(line)) {
      push("md", "quote", pos);
      rest = line.replace(/^[ >]+/, "");
    } else if ((m = line.match(/^\s*[-*+]\s+/))) {
      push("md", "list", pos);
      rest = line.slice(m[0].length);
    } else if ((m = line.match(/^\s*\d{1,9}[.)]\s+/))) {
      push("md", "olist", pos);
      rest = line.slice(m[0].length);
    }
    for (const s of rest.matchAll(
      /\*\*(?=\S)[^*\n]+?(?<=\S)\*\*|(?<![\w_])__(?=[^\s_])[^_\n]+?(?<=[^\s_])__(?![\w_])/g,
    )) {
      push("md", "strong", pos + (s.index ?? 0));
    }
    const noStrong = rest.replace(
      /\*\*(?=\S)[^*\n]+?(?<=\S)\*\*|(?<![\w_])__(?=[^\s_])[^_\n]+?(?<=[^\s_])__(?![\w_])/g,
      (x) => FILL.repeat(x.length),
    );
    for (const s of noStrong.matchAll(
      /(?<![*\w])\*(?=[^\s*])[^*\n]+?(?<=[^\s*])\*(?![*\w])|(?<![\w_])_(?=[^\s_])[^_\n]+?(?<=[^\s_])_(?![\w_])/g,
    )) {
      push("md", "em", pos + (s.index ?? 0));
    }
  }
}

function tally(tokens) {
  const counts = new Map();
  for (const { kind, value } of tokens) {
    const key = `${kind}\u0000${value}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { kind, value, count: 1 });
  }
  return counts;
}

function bidiInsideTokens(tokens) {
  return tokens.filter(
    (t) => t.kind !== "bidi" && /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/.test(t.value),
  );
}

/**
 * Compare the protected tokens of an original and its revision. Placeholders
 * may move, because word order differs between languages, so tokens are
 * compared as multisets.
 *
 * Differences are violations, except: directional marks are warnings (a
 * right-to-left fix may add one on purpose) unless one lands inside another
 * token; and, when `allowPluralCategories` is set, added or removed CLDR plural
 * categories and their # markers are warnings (a language may need more
 * categories than the original message has).
 *
 * @param {string} original
 * @param {string} revised
 * @param {{preserve?: string[], allowPluralCategories?: boolean}} [options]
 * @returns {{ok: boolean, missing: Array<{kind: string, value: string, count: number}>, added: Array<{kind: string, value: string, count: number}>, warnings: string[], errors: string[]}}
 */
export function compareProtectedTokens(
  original,
  revised,
  { preserve = [], allowPluralCategories = false } = {},
) {
  const a = extractProtectedTokens(original, { preserve });
  const b = extractProtectedTokens(revised, { preserve });
  const countsA = tally(a.tokens);
  const countsB = tally(b.tokens);

  let missing = [];
  let added = [];
  for (const [key, entry] of countsA) {
    const delta = entry.count - (countsB.get(key)?.count ?? 0);
    if (delta > 0) missing.push({ kind: entry.kind, value: show(entry.value), count: delta });
  }
  for (const [key, entry] of countsB) {
    const delta = entry.count - (countsA.get(key)?.count ?? 0);
    if (delta > 0) added.push({ kind: entry.kind, value: show(entry.value), count: delta });
  }

  const warnings = [];
  const relax = (list, side, test, why = "") => {
    const kept = [];
    for (const t of list) {
      if (test(t)) warnings.push(`${t.kind} ${t.value} ${side} (x${t.count}${why})`);
      else kept.push(t);
    }
    return kept;
  };
  const isBidi = (t) => t.kind === "bidi";
  missing = relax(missing, "removed", isBidi);
  added = relax(added, "added", isBidi);

  if (allowPluralCategories) {
    const isCategory = (t) =>
      t.kind === "icu-selector" && CLDR_PLURAL_CATEGORIES.has(t.value.split(".").pop());
    if (missing.some(isCategory) || added.some(isCategory)) {
      const relaxed = (t) => isCategory(t) || t.kind === "icu-hash";
      const why = "; plural categories allowed";
      missing = relax(missing, "removed", relaxed, why);
      added = relax(added, "added", relaxed, why);
    }
  }

  const errors = [];
  if (b.errors.length > a.errors.length) errors.push(...b.errors.slice(a.errors.length));
  const insideBefore = bidiInsideTokens(a.tokens).length;
  const inside = bidiInsideTokens(b.tokens);
  if (inside.length > insideBefore) {
    for (const t of inside) errors.push(`directional mark inside ${t.kind} ${show(t.value)}`);
  }

  return {
    ok: missing.length === 0 && added.length === 0 && errors.length === 0,
    missing,
    added,
    warnings,
    errors,
  };
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Check a review against the output contract. This is structural only: it
 * never judges whether a suggestion is good Portuguese, Arabic, or English.
 *
 * @param {unknown} doc
 * @param {{preserve?: string[]}} [options]
 * @returns {{ok: boolean, errors: Array<{path: string, code: string, message: string}>, warnings: string[]}}
 */
export function validateReviewDocument(doc, { preserve = [] } = {}) {
  const errors = [];
  const warnings = [];
  const fail = (path, code, message) => errors.push({ path, code, message });
  const done = () => ({ ok: errors.length === 0, errors, warnings });

  if (!isObject(doc)) {
    fail("$", "invalid-document", "A review must be a JSON object.");
    return done();
  }

  if (!isText(doc.language)) fail("language", "missing-field", "language is required.");
  else if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(doc.language)) {
    fail("language", "invalid-language", `"${doc.language}" is not a BCP 47 tag such as pt-BR.`);
  }
  if (!isText(doc.verdict)) fail("verdict", "missing-field", "verdict is required.");
  else if (!VERDICTS.includes(doc.verdict)) {
    fail("verdict", "invalid-enum", `verdict must be one of ${VERDICTS.join(", ")}.`);
  }
  if (!isText(doc.disclaimer)) {
    fail(
      "disclaimer",
      "missing-field",
      "A disclaimer that this is not a native-speaker validation is required.",
    );
  }
  if (!Array.isArray(doc.findings)) {
    fail(
      "findings",
      "invalid-findings",
      "findings must be an array, empty when the text is natural.",
    );
    return done();
  }

  if (
    doc.assumptions !== undefined &&
    !(
      isObject(doc.assumptions) &&
      Object.values(doc.assumptions).every((v) => typeof v === "string")
    )
  ) {
    fail("assumptions", "invalid-assumptions", "assumptions must be an object of strings.");
  }
  if (
    doc.left_alone !== undefined &&
    !(Array.isArray(doc.left_alone) && doc.left_alone.every(isText))
  ) {
    fail("left_alone", "invalid-left-alone", "left_alone must be an array of non-empty strings.");
  }

  const fixedTerms = [
    ...preserve,
    ...(Array.isArray(doc.preserve) ? doc.preserve.filter((t) => typeof t === "string") : []),
  ];
  const levels = [];

  doc.findings.forEach((finding, i) => {
    const at = (field) => `findings[${i}].${field}`;
    if (!isObject(finding)) {
      fail(`findings[${i}]`, "invalid-finding", "Each finding must be an object.");
      return;
    }
    for (const field of ["original", "suggestion", "explanation"]) {
      if (!isText(finding[field])) fail(at(field), "missing-field", `${field} is required.`);
    }
    for (const [field, allowed] of [
      ["category", CATEGORIES],
      ["severity", SEVERITIES],
      ["confidence", CONFIDENCES],
    ]) {
      if (!isText(finding[field])) fail(at(field), "missing-field", `${field} is required.`);
      else if (!allowed.includes(finding[field])) {
        fail(at(field), "invalid-enum", `${field} must be one of ${allowed.join(", ")}.`);
      }
    }
    if (SEVERITIES.includes(finding.severity)) {
      levels.push({ severity: finding.severity, unsure: finding.confidence === "low" });
    }
    if (finding.location !== undefined && !isText(finding.location)) {
      fail(at("location"), "invalid-location", "location must be a non-empty string.");
    }
    if (
      finding.locations !== undefined &&
      !(
        Array.isArray(finding.locations) &&
        finding.locations.length > 0 &&
        finding.locations.every(isText)
      )
    ) {
      fail(at("locations"), "invalid-location", "locations must be a non-empty array of strings.");
    }
    if (finding.confidence === "low" && !isText(finding.uncertainty)) {
      fail(
        at("uncertainty"),
        "missing-uncertainty",
        "A low-confidence finding must say what is uncertain.",
      );
    }
    if (isText(finding.original) && isText(finding.suggestion)) {
      if (finding.suggestion === finding.original) {
        fail(
          at("suggestion"),
          "identical-suggestion",
          "The suggestion equals the original, so there is nothing to change.",
        );
      } else {
        const result = compareProtectedTokens(finding.original, finding.suggestion, {
          preserve: fixedTerms,
        });
        if (!result.ok) {
          const parts = [
            ...result.missing.map((t) => `missing ${t.kind} ${t.value}`),
            ...result.added.map((t) => `added ${t.kind} ${t.value}`),
            ...result.errors,
          ];
          fail(
            at("suggestion"),
            "protected-token",
            `The suggestion changes protected content: ${parts.join("; ")}.`,
          );
        }
        warnings.push(...result.warnings.map((w) => `${at("suggestion")}: ${w}`));
      }
    }
  });

  // A critical or major finding that the reviewer is unsure of counts as minor: it should
  // not turn the whole text into needs-revision on a guess.
  const blocking = levels.some(
    (l) => (l.severity === "critical" || l.severity === "major") && !l.unsure,
  );
  const minor = levels.some(
    (l) =>
      l.severity === "minor" || ((l.severity === "critical" || l.severity === "major") && l.unsure),
  );
  const expected = blocking ? "needs-revision" : minor ? "minor-polish" : "natural";
  if (expected === "natural" && doc.findings.length > 0) {
    fail(
      "findings",
      "preference-only",
      "A review with only preference findings is natural: report an empty findings array and put the alternatives in left_alone.",
    );
  }
  if (VERDICTS.includes(doc.verdict) && doc.verdict !== expected) {
    fail(
      "verdict",
      "verdict-mismatch",
      `The findings give "${expected}", not "${doc.verdict}": needs-revision needs a critical or major finding that is not low confidence, minor-polish needs a minor one, and natural has no findings.`,
    );
  }
  return done();
}

const USAGE = `check-review.mjs: deterministic checks for the language-review skill

Usage:
  node check-review.mjs preserve --original <file|-> --revised <file|-> [options]
  node check-review.mjs validate <review.json|-> [options]
  node check-review.mjs extract <file|-> [options]

Options:
  --preserve <term>           A fixed term to keep verbatim (repeatable)
  --glossary <file>           Fixed terms, one per line; lines starting with # are ignored
  --allow-plural-categories   Treat added or removed CLDR plural categories as warnings
  --json                      Print JSON
  -h, --help                  Print this help

Exit codes: 0 ok, 1 violation, 2 input could not be read, 64 usage.`;

class UsageError extends Error {}

function parseCli(argv) {
  const opts = { preserve: [], json: false, allowPluralCategories: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (name) => {
      if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
      return argv[++i];
    };
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--allow-plural-categories") opts.allowPluralCategories = true;
    else if (arg === "--original") opts.original = value(arg);
    else if (arg === "--revised") opts.revised = value(arg);
    else if (arg === "--preserve") opts.preserve.push(value(arg));
    else if (arg === "--glossary") opts.glossary = value(arg);
    else if (arg === "-" || !arg.startsWith("-")) positional.push(arg);
    else throw new UsageError(`unknown option ${arg}`);
  }
  return { opts, positional };
}

function readInput(path) {
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch (err) {
    err.inputPath = path;
    throw err;
  }
}

function glossaryTerms(path) {
  return readInput(path)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/**
 * Run the command line.
 *
 * @param {string[]} [argv]
 * @returns {number} the exit code
 */
export function main(argv = process.argv.slice(2)) {
  const out = (s) => process.stdout.write(`${s}\n`);
  const err = (s) => process.stderr.write(`${s}\n`);
  let parsed;
  try {
    parsed = parseCli(argv);
    const [command, ...rest] = parsed.positional;
    if (parsed.opts.help) {
      out(USAGE);
      return EXIT.OK;
    }
    if (!["preserve", "validate", "extract"].includes(command)) {
      throw new UsageError("expected a command: preserve, validate, or extract");
    }
    const { opts } = parsed;
    const preserve = [...opts.preserve, ...(opts.glossary ? glossaryTerms(opts.glossary) : [])];

    if (command === "preserve") {
      if (opts.original === undefined || opts.revised === undefined || rest.length) {
        throw new UsageError("preserve needs --original and --revised");
      }
      if (opts.original === "-" && opts.revised === "-") {
        throw new UsageError("only one input may be read from stdin");
      }
      const result = compareProtectedTokens(readInput(opts.original), readInput(opts.revised), {
        preserve,
        allowPluralCategories: opts.allowPluralCategories,
      });
      if (opts.json) out(JSON.stringify(result, null, 2));
      else {
        out(
          result.ok
            ? "ok: every protected token is preserved"
            : `fail: ${result.missing.length + result.added.length + result.errors.length} protected-token problem(s)`,
        );
        for (const t of result.missing) out(`  missing ${t.kind} ${t.value} (x${t.count})`);
        for (const t of result.added) out(`  added ${t.kind} ${t.value} (x${t.count})`);
        for (const e of result.errors) out(`  ${e}`);
        for (const w of result.warnings) out(`  warn: ${w}`);
      }
      return result.ok ? EXIT.OK : EXIT.VIOLATION;
    }

    if (rest.length !== 1) throw new UsageError(`${command} needs one input file, or - for stdin`);
    const input = readInput(rest[0]);

    if (command === "extract") {
      const result = extractProtectedTokens(input, { preserve });
      if (opts.json) out(JSON.stringify(result, null, 2));
      else {
        for (const t of result.tokens) out(`${t.kind}\t${show(t.value)}`);
        for (const e of result.errors) err(e);
      }
      return EXIT.OK;
    }

    let doc;
    try {
      doc = JSON.parse(input);
    } catch (e) {
      err(`input is not valid JSON: ${e.message}`);
      return EXIT.VIOLATION;
    }
    const result = validateReviewDocument(doc, { preserve });
    if (opts.json) out(JSON.stringify(result, null, 2));
    else {
      out(
        result.ok
          ? `ok: review is well-formed (${doc.findings.length} finding${doc.findings.length === 1 ? "" : "s"})`
          : `fail: ${result.errors.length} problem(s)`,
      );
      for (const e of result.errors) out(`  ${e.path} ${e.code}: ${e.message}`);
      for (const w of result.warnings) out(`  warn: ${w}`);
    }
    return result.ok ? EXIT.OK : EXIT.VIOLATION;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n\n${USAGE}`);
      return EXIT.USAGE;
    }
    if (e && e.inputPath !== undefined) {
      err(`cannot read ${e.inputPath}: ${e.message}`);
      return EXIT.ENV;
    }
    throw e;
  }
}

// Run-direct guard, symlink-safe. bootstrap and project-sync install this skill
// through symlinks, and Node resolves the real path of the entry module while
// argv[1] keeps the link, so a plain comparison would conclude the file was
// imported and exit 0 without running. Compare real paths on both sides.
let runDirect = false;
if (process.argv[1]) {
  const self = fileURLToPath(import.meta.url);
  runDirect = self === process.argv[1];
  if (!runDirect) {
    try {
      runDirect = realpathSync(self) === realpathSync(process.argv[1]);
    } catch {
      runDirect = false;
    }
  }
}
if (runDirect) process.exitCode = main();
