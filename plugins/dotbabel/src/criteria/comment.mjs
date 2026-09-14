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

/**
 * Render the full comment body. Shrinks output tails first when the body
 * would exceed `MAX_BODY_CHARS` (OPS-3) — the payload line is never
 * shortened, since a truncated payload line would no longer be valid JSON.
 *
 * @param {object} payload The evidence payload (already built by `verifyCriteria`/the CLI).
 * @param {{ [criterionId: string]: string }} tails Redacted output tail per criterion id that ran.
 * @returns {string}
 */
export function renderEvidenceComment(payload, tails) {
  const markerLine = buildCriteriaMarker(payload.head_sha);
  const payloadLine = `${PAYLOAD_LINE_PREFIX}${Buffer.from(JSON.stringify(payload)).toString("base64url")} -->`;

  const rows = [];
  for (const spec of payload.specs) {
    for (const criterion of spec.criteria) {
      rows.push(`| ${spec.id} | ${criterion.id} | ${criterion.status} | ${testsCell(criterion)} | ${durationCell(criterion)} |`);
    }
  }

  const criterionIds = payload.specs.flatMap((spec) => spec.criteria.map((c) => c.id));

  function render() {
    const details = criterionIds
      .filter((id) => tails[id] !== undefined)
      .map((id) => [`<details><summary>${id} output</summary>`, "", tails[id], "", "</details>"].join("\n"));
    return [markerLine, payloadLine, "### Acceptance criteria evidence", "", "| Spec | Criterion | Status | Tests | Duration |", "| ---- | --------- | ------ | ----- | -------- |", ...rows, "", ...details].join("\n");
  }

  let body = render();
  // Output tails shrink first when over budget (OPS-3) — shrink in one
  // deterministic step to the remaining budget split evenly across the
  // details blocks that carry a tail, rather than iterating; a body still
  // over budget after every tail is emptied is a fixed cost this function
  // cannot reduce further (the table itself, one row per criterion).
  if (body.length > MAX_BODY_CHARS) {
    const tailCount = criterionIds.filter((id) => tails[id] !== undefined).length;
    const over = body.length - MAX_BODY_CHARS;
    const perTailCut = tailCount > 0 ? Math.ceil(over / tailCount) : 0;
    const shrunkTails = {};
    for (const id of criterionIds) {
      if (tails[id] === undefined) continue;
      const keep = Math.max(0, tails[id].length - perTailCut);
      shrunkTails[id] = tails[id].slice(-keep);
    }
    tails = shrunkTails;
    body = render();
  }
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
}

/**
 * @typedef {object} CommentDeps
 * @property {(cmd: string) => string} capture Run a read-only command, return trimmed stdout.
 * @property {(cmd: string, jsonBody: object) => void} ghApiWithInput POST/PATCH/mutate, sending `jsonBody` as `--input -` stdin.
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
  const me = deps.capture("gh api user --jq .login").trim();
  const raw = deps.capture(`gh api repos/${repo}/issues/${pr}/comments --paginate`);
  const comments = JSON.parse(raw || "[]");
  const older = comments.filter((c) => c && c.user?.login === me && typeof c.body === "string" && c.body.includes(CRITERIA_MARKER_PREFIX));

  for (const comment of older) {
    const nodeId = comment.node_id;
    if (!nodeId) continue;
    deps.capture(`gh api graphql -f query='mutation { minimizeComment(input: {subjectId: "${nodeId}", classifier: OUTDATED}) { minimizedComment { isMinimized } } }'`);
  }

  deps.ghApiWithInput(`gh api --method POST repos/${repo}/issues/${pr}/comments --input -`, { body });
  deps.log?.(`Posted a new evidence comment and minimized ${older.length} older one(s).`);
}
