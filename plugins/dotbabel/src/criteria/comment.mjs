import { deflateRawSync } from "node:zlib";

import { createMarker } from "../lib/attest-marker.mjs";

/**
 * The `dotbabel criteria` evidence comment (§5 "Evidence comment", KD-2).
 *
 * Line 1 is the hidden marker the merge gate greps for, byte-exact like
 * local-attest's own marker (`local-attest-lib.mjs:55`) — both are built by
 * the same shared factory (`lib/attest-marker.mjs`). Line 2 carries the
 * whole evidence payload, raw-deflated and then base64url-encoded so it
 * survives Markdown rendering untouched and so that realistic payloads fit
 * the comment cap; the payload itself holds no output text (OPS-3), only a
 * SHA-256 hash per criterion. The readable part below the marker lines is for
 * humans only — the merge gate never reads it.
 */
export const CRITERIA_MARKER_PREFIX = "<!-- dotbabel-criteria verified-sha=";
/**
 * Opening text of the plain (pre-z1) payload line: base64url of the JSON.
 *
 * The writer no longer emits this form. It emits `PAYLOAD_LINE_PREFIX_Z1`,
 * which begins with this text. The reader in `evidence.mjs` accepts both, and
 * it uses this prefix to find line 2 and to read the plain form that older
 * versions posted. The producer and the gate that judges it must never drift
 * apart: a mismatch here would leave the command posting evidence the gate
 * cannot see, and neither side would look broken on its own.
 */
export const PAYLOAD_LINE_PREFIX = "<!-- dotbabel-criteria-payload ";
/**
 * Opening text of the compressed (version z1) payload line.
 *
 * The plain form put base64url(JSON) after `PAYLOAD_LINE_PREFIX`, and a
 * payload of 57 criteria and 137 named tests (pull request #465) was then
 * 66,022 characters: over `MAX_BODY_CHARS` before any readable output. The z1
 * form carries base64url(deflateRaw(JSON)) instead. It extends the plain
 * prefix, so a guard on the plain prefix also matches it, and `:` is outside
 * the base64url alphabet, so a plain payload can never start with `z1:`. The
 * reader tells the two forms apart by prefix alone and never guesses.
 */
export const PAYLOAD_LINE_PREFIX_Z1 = `${PAYLOAD_LINE_PREFIX}z1:`;
/**
 * The most UTF-8 bytes of payload JSON the writer emits and the reader inflates.
 *
 * One bound for both sides. The reader passes it to `inflateRawSync` as
 * `maxOutputLength`, so a small line that would inflate without limit (a
 * decompression bomb) is refused as undecodable. The writer refuses a larger
 * payload rather than post evidence its own gate would then refuse.
 */
export const MAX_PAYLOAD_JSON_BYTES = 1024 * 1024;
const MAX_BODY_CHARS = 60000;
const LINE_SUFFIX = " -->";

const marker = createMarker(CRITERIA_MARKER_PREFIX);

/** @param {string} headSha @returns {string} */
export function buildCriteriaMarker(headSha) {
  return marker.build(headSha);
}

/**
 * Encode the evidence payload into its z1 comment line.
 *
 * Deterministic within one Node build: the same payload gives the same bytes,
 * because `JSON.stringify` keeps key order and the deflate settings are fixed.
 * zlib does not promise the same bytes across versions, so compare decoded
 * payloads, never encoded lines.
 *
 * @param {object} payload The evidence payload.
 * @returns {string} `PAYLOAD_LINE_PREFIX_Z1`, then base64url(deflateRaw(JSON)), then ` -->`.
 * @throws {Error} When the payload JSON is over `MAX_PAYLOAD_JSON_BYTES`. The
 *   writer encodes before it posts, so the message says that nothing was posted.
 */
export function encodeCriteriaPayloadLine(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.length > MAX_PAYLOAD_JSON_BYTES) {
    throw new Error(
      `criteria evidence payload JSON is ${json.length} bytes, over the ${MAX_PAYLOAD_JSON_BYTES}-byte limit; refused while encoding the payload line, so nothing was posted`,
    );
  }
  return `${PAYLOAD_LINE_PREFIX_Z1}${deflateRawSync(json, { level: 9 }).toString("base64url")}${LINE_SUFFIX}`;
}

/**
 * @param {object} criterion One criterion from the evidence payload.
 * @returns {string} `"<confirmed>/<total>"`, or an em dash when the criterion has no `tests`.
 */
function testsCell(criterion) {
  if (!Array.isArray(criterion.tests)) return "—";
  const total = criterion.tests.length;
  const confirmed = criterion.tests.filter((t) => t.result === "passed" || t.result === "failed" || t.result === "error").length;
  return `${confirmed}/${total}`;
}

function durationCell(criterion) {
  return typeof criterion.duration_ms === "number" ? `${criterion.duration_ms}ms` : "—";
}

function escapeMarkdown(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
}

function fenced(text) {
  const longest = Math.max(0, ...(String(text).match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Render the full comment body. Shrinks output tails first when the body
 * would exceed `MAX_BODY_CHARS` (OPS-3) — the payload line is never
 * shortened, since a truncated payload line would no longer decode.
 *
 * @param {object} payload The evidence payload (already built by `verifyCriteria`/the CLI).
 * @param {{ [specId: string]: { [criterionId: string]: string } }} tails Redacted output tails grouped by spec id.
 * @returns {string}
 * @throws {Error} When the marker and payload lines alone exceed `MAX_BODY_CHARS`
 *   (the message gives their length, the limit, and the criteria and spec
 *   counts), or the payload JSON exceeds `MAX_PAYLOAD_JSON_BYTES`.
 */
export function renderEvidenceComment(payload, tails) {
  const markerLine = buildCriteriaMarker(payload.head_sha);
  const payloadLine = encodeCriteriaPayloadLine(payload);
  const fixed = `${markerLine}\n${payloadLine}`;
  if (fixed.length > MAX_BODY_CHARS) {
    const criteria = payload.specs.reduce((n, spec) => n + spec.criteria.length, 0);
    throw new Error(
      `criteria evidence marker and payload lines are ${fixed.length} characters, over the ${MAX_BODY_CHARS}-character comment limit before any readable output, for ${criteria} criterion(s) in ${payload.specs.length} spec(s); nothing was posted`,
    );
  }

  const entries = [];
  for (const spec of payload.specs) {
    for (const criterion of spec.criteria) {
      entries.push({ spec, criterion, tail: tails?.[spec.id]?.[criterion.id] });
    }
  }

  function render({ rowLimit = entries.length, details = true, tailCap = Number.MAX_SAFE_INTEGER } = {}) {
    const shown = entries.slice(0, rowLimit);
    const rows = shown.map(({ spec, criterion }) =>
      `| ${escapeMarkdown(spec.id)} | ${escapeMarkdown(criterion.id)} | ${escapeMarkdown(criterion.status)} | ${testsCell(criterion)} | ${durationCell(criterion)} |`,
    );
    if (rowLimit < entries.length) rows.push(`| … | ${entries.length - rowLimit} more criteria not shown | … | … | … |`);
    const detailBlocks = details
      ? entries
          .filter(({ tail }) => tail !== undefined)
          .map(({ spec, criterion, tail }) => {
            const keep = Math.min(String(tail).length, tailCap);
            const kept = keep === 0 ? "" : String(tail).slice(-keep);
            return [`<details><summary>${escapeMarkdown(spec.id)} ${escapeMarkdown(criterion.id)} output</summary>`, "", fenced(kept), "", "</details>"].join("\n");
          })
      : [];
    return [fixed, "### Acceptance criteria evidence", "", "| Spec | Criterion | Status | Tests | Duration |", "| ---- | --------- | ------ | ----- | -------- |", ...rows, "", ...detailBlocks].join("\n");
  }

  let body = render();
  if (body.length <= MAX_BODY_CHARS) return body;

  // Find the largest per-tail cap that fits. This water-filling shape keeps a
  // short tail whole while shrinking longer tails equally from their starts.
  if (render({ tailCap: 0 }).length <= MAX_BODY_CHARS) {
    let low = 0;
    let high = Math.max(0, ...entries.map(({ tail }) => String(tail ?? "").length));
    while (low < high) {
      const candidate = Math.ceil((low + high) / 2);
      if (render({ tailCap: candidate }).length <= MAX_BODY_CHARS) low = candidate;
      else high = candidate - 1;
    }
    return render({ tailCap: low });
  }

  body = render({ details: false });
  if (body.length <= MAX_BODY_CHARS) return body;

  let low = 0;
  let high = entries.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (render({ rowLimit: candidate, details: false }).length <= MAX_BODY_CHARS) low = candidate;
    else high = candidate - 1;
  }
  body = render({ rowLimit: low, details: false });
  return body.length <= MAX_BODY_CHARS ? body : fixed;
}

/**
 * @typedef {object} CommentDeps
 * @property {(argv: string[]) => string} capture Run a read-only command without a shell.
 * @property {(argv: string[], jsonBody: object) => void} ghApiWithInput POST/PATCH/mutate with JSON stdin.
 * @property {(msg: string) => void} [log]
 */

/**
 * Post a new evidence comment and minimize the tool's own older ones (§5
 * "Evidence comment"; never edits a comment, per OPS-4).
 *
 * `markerPrefix` names the evidence family being superseded and defaults to the
 * criteria one. Another family (review-complete) passes its own prefix so that
 * posting it never hides a criteria comment, and the reverse.
 *
 * @param {CommentDeps} deps
 * @param {{ repo: string, pr: string|number, body: string, markerPrefix?: string }} args
 */
export function postEvidenceComment(deps, { repo, pr, body, markerPrefix = CRITERIA_MARKER_PREFIX }) {
  const me = deps.capture(["gh", "api", "user", "--jq", ".login"]).trim();
  const raw = deps.capture(["gh", "api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]);
  const comments = JSON.parse(raw || "[]");
  const older = comments.filter((c) => c && c.user?.login === me && typeof c.body === "string" && c.body.includes(markerPrefix));

  deps.ghApiWithInput(["gh", "api", "--method", "POST", `repos/${repo}/issues/${pr}/comments`, "--input", "-"], { body });

  for (const comment of older) {
    const nodeId = comment.node_id;
    if (!nodeId) continue;
    deps.capture([
      "gh",
      "api",
      "graphql",
      "-f",
      "query=mutation($id: ID!) { minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) { minimizedComment { isMinimized } } }",
      "-F",
      `id=${nodeId}`,
    ]);
  }

  deps.log?.(`Posted a new evidence comment and minimized ${older.length} older one(s).`);
}
