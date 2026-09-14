import { createMarker } from "../lib/attest-marker.mjs";

/**
 * The `dotbabel criteria` evidence comment (§5 "Evidence comment", KD-2).
 *
 * Line 1 is the hidden marker the merge gate greps for, byte-exact like
 * local-attest's own marker (`local-attest-lib.mjs:53`) — both are built by
 * the same shared factory (`lib/attest-marker.mjs`). Line 2 carries the
 * whole evidence payload, base64url-encoded so it survives Markdown
 * rendering untouched; the payload itself holds no output text (OPS-3), only
 * a SHA-256 hash per criterion. The readable part below the marker lines is
 * for humans only — the merge gate never reads it.
 */
export const CRITERIA_MARKER_PREFIX = "<!-- dotbabel-criteria verified-sha=";
const PAYLOAD_LINE_PREFIX = "<!-- dotbabel-criteria-payload ";
const MAX_BODY_CHARS = 60000;

const marker = createMarker(CRITERIA_MARKER_PREFIX);

/** @param {string} headSha @returns {string} */
export function buildCriteriaMarker(headSha) {
  return marker.build(headSha);
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
 * shortened, since a truncated payload line would no longer be valid JSON.
 *
 * @param {object} payload The evidence payload (already built by `verifyCriteria`/the CLI).
 * @param {{ [specId: string]: { [criterionId: string]: string } }} tails Redacted output tails grouped by spec id.
 * @returns {string}
 */
export function renderEvidenceComment(payload, tails) {
  const markerLine = buildCriteriaMarker(payload.head_sha);
  const payloadLine = `${PAYLOAD_LINE_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")} -->`;
  const fixed = `${markerLine}\n${payloadLine}`;
  if (fixed.length > MAX_BODY_CHARS) throw new Error("criteria evidence size exceeds the comment limit before readable output");

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
 * @param {CommentDeps} deps
 * @param {{ repo: string, pr: string|number, body: string }} args
 */
export function postEvidenceComment(deps, { repo, pr, body }) {
  const me = deps.capture(["gh", "api", "user", "--jq", ".login"]).trim();
  const raw = deps.capture(["gh", "api", `repos/${repo}/issues/${pr}/comments`, "--paginate"]);
  const comments = JSON.parse(raw || "[]");
  const older = comments.filter((c) => c && c.user?.login === me && typeof c.body === "string" && c.body.includes(CRITERIA_MARKER_PREFIX));

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
