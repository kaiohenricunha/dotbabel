/**
 * One Spec ID parser, shared by the `dotbabel criteria` command and the merge
 * gate (ARCH-6). Two parsers meant a body could satisfy one and fail the
 * other: `"dotbabel-core"` passed the coverage gate and then exited 2 in the
 * command, and `dotbabel-core.` did the reverse.
 *
 * Pure by construction — no I/O, no repo access — because `pr-gates.mjs`
 * imports it and that module's whole contract is that it only decides.
 *
 * Fence-aware: a `## Spec ID` heading inside a fenced code block is example
 * text, not a declaration. `stripFences` removes fenced regions before the
 * section is located, so documentation that shows the convention cannot
 * accidentally declare a spec.
 */

// A fence opens with at least three backticks or tildes (CommonMark 4.5).
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

// Leading trim includes '#' (e.g. "##spec-id" → "spec-id"); trailing does not,
// preserving the original behaviour of /^[`'"#]+|[`'"]+$/.
const SPECID_LEADING_TRIM = new Set(["`", "'", '"', "#"]);
const SPECID_TRAILING_TRIM = new Set(["`", "'", '"']);

/**
 * Remove fenced code blocks from a markdown body.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripFences(body) {
  const out = [];
  /** @type {{char: string, len: number}|null} */
  let open = null;

  for (const line of String(body ?? "").split("\n")) {
    const m = FENCE_RE.exec(line);
    if (open === null) {
      if (m === null) out.push(line);
      else open = { char: m[1][0], len: m[1].length };
      continue;
    }
    // Per CommonMark 4.5 only a run of the SAME character, at least as long as
    // the opener, closes the block — so ``` inside a ~~~ block is content.
    if (m !== null && m[1][0] === open.char && m[1].length >= open.len) open = null;
  }
  return out.join("\n");
}

/**
 * Normalize one Spec ID token: strip wrapping quotes/backticks and leading
 * hashes.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeSpecId(value) {
  const v = String(value ?? "");
  let start = 0;
  let end = v.length;
  while (start < end && SPECID_LEADING_TRIM.has(v[start])) start++;
  while (end > start && SPECID_TRAILING_TRIM.has(v[end - 1])) end--;
  return v.slice(start, end).trim();
}

/**
 * Extract the Spec IDs a pull request body declares in its `## Spec ID`
 * section, in first-seen order and deduplicated.
 *
 * The section runs to the next H2 or the end of the body, and every
 * whitespace- or comma-separated token in it is an id — which is why the
 * convention is that nothing else may live under that heading.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function parseSpecIds(body) {
  return parseSpecIdSection(extractSpecIdSection(stripFences(body)));
}

/**
 * Tokenize an already-extracted `## Spec ID` section into normalized, unique
 * ids. Separate from {@link parseSpecIds} because `check-spec-coverage.mjs`
 * extracts the section itself (it needs the raw text to decide whether the
 * section is meaningful at all) and only wants the tokenizer.
 *
 * @param {string} section
 * @returns {string[]}
 */
export function parseSpecIdSection(section) {
  return [...new Set(String(section ?? "").split(/[\s,]+/).map(normalizeSpecId).filter(Boolean))];
}

/**
 * The raw text under the `## Spec ID` heading, or `""` when absent.
 *
 * @param {string} body
 * @returns {string}
 */
function extractSpecIdSection(body) {
  const m = /##\s*Spec ID\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(body);
  if (m === null) return "";
  // Drop HTML comments so a commented-out id is not parsed as a declaration.
  return m[1].replace(/<!--[\s\S]*?-->/g, "").trim();
}
