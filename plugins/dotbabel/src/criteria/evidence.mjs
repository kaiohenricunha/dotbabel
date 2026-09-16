/**
 * The read half of the evidence comment (P-B3). `comment.mjs` builds and
 * posts; this parses what the merge gate found back into a payload it can
 * judge.
 *
 * Deliberately pure and schema-shaped rather than trusting the comment: the
 * body is attacker-influenced text on a pull request, and the gate's whole
 * job is to decide whether to believe it. Every failure mode here is a
 * distinct outcome the gate maps to its own reason code, so "someone pasted
 * junk" can never read as "no evidence" (which a later comment could then
 * satisfy) or as a pass.
 */
import { CRITERIA_MARKER_PREFIX, PAYLOAD_LINE_PREFIX } from "./comment.mjs";
import { createMarker } from "../lib/attest-marker.mjs";

const marker = createMarker(CRITERIA_MARKER_PREFIX);

/**
 * @typedef {object} ParsedEvidence
 * @property {"ok"|"not-evidence"|"undecodable"|"sha-mismatch"} state
 * @property {string|null} sha        The SHA the marker names.
 * @property {object|null} payload    The decoded payload, when `state` is "ok".
 * @property {string|null} detail     Why it failed, for the gate's reason detail.
 */

/**
 * Parse one comment body into its marker SHA and evidence payload.
 *
 * `sha-mismatch` is its own state because a payload whose `head_sha` differs
 * from the marker it rides on is the shape a forgery takes: the marker is
 * what the gate greps, the payload is what it believes, and letting those
 * disagree would let a trusted-looking marker vouch for someone else's
 * results.
 *
 * @param {string} body
 * @returns {ParsedEvidence}
 */
export function parseEvidenceComment(body) {
  const sha = marker.parseSha(body);
  if (sha === null) return { state: "not-evidence", sha: null, payload: null, detail: null };

  const line = String(body).split("\n")[1] ?? "";
  if (!line.startsWith(PAYLOAD_LINE_PREFIX) || !line.endsWith(" -->")) {
    return { state: "undecodable", sha, payload: null, detail: "line 2 is not the payload comment" };
  }

  const encoded = line.slice(PAYLOAD_LINE_PREFIX.length, -" -->".length).trim();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (err) {
    return { state: "undecodable", sha, payload: null, detail: `payload did not decode: ${err.message}` };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { state: "undecodable", sha, payload: null, detail: "payload is not an object" };
  }
  // No `!== undefined` guard: REL-2 makes head_sha the binding between the
  // payload and the commit, so a payload that simply omits it must not be
  // accepted on the strength of the marker line alone.
  if (payload.head_sha !== sha) {
    return {
      state: "sha-mismatch",
      sha,
      payload,
      detail: `payload head_sha ${payload.head_sha} does not match marker ${sha}`,
    };
  }
  return { state: "ok", sha, payload, detail: null };
}

/**
 * Shape-check a decoded payload against the fields the gate relies on.
 *
 * This is not the full JSON Schema — the gate is pure and synchronous, and
 * Ajv is neither. It checks exactly what the gate reads, so a payload that
 * passes here cannot make the gate throw on a missing field. The schema
 * itself stays authoritative for producers, and `dotbabel criteria` validates
 * against it when it writes.
 *
 * @param {unknown} payload
 * @returns {string|null} A reason it is invalid, or null when usable.
 */
export function evidencePayloadProblem(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "payload is not an object";
  const p = /** @type {any} */ (payload);
  if (p.schema_version !== 1) return `unsupported schema_version: ${JSON.stringify(p.schema_version)}`;
  if (typeof p.verdict !== "string") return "verdict is missing";
  if (typeof p.head_sha !== "string" || !/^[0-9a-f]{40}$/i.test(p.head_sha)) return "head_sha is missing or malformed";
  if (!Array.isArray(p.specs)) return "specs is not an array";
  for (const spec of p.specs) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return "a spec entry is not an object";
    if (typeof spec.id !== "string" || spec.id === "") return "a spec entry has no id";
    if (!Array.isArray(spec.criteria)) return `spec ${spec.id} has no criteria array`;
    for (const criterion of spec.criteria) {
      if (criterion === null || typeof criterion !== "object" || Array.isArray(criterion)) {
        return `a criterion of ${spec.id} is not an object`;
      }
      if (typeof criterion.id !== "string" || criterion.id === "") return `a criterion of ${spec.id} has no id`;
      if (typeof criterion.status !== "string") return `criterion ${spec.id}/${criterion.id} has no status`;
    }
  }
  return null;
}

/**
 * The criterion ids a payload reports as having actually run, per spec id.
 *
 * Only `pass` counts. The two vocabularies are easy to conflate: a spec
 * criterion is `planned` or `active`, while a payload criterion is `pending`,
 * `pass`, `fail`, `error` or `unconfirmed`. `pending` is what the command
 * records for a criterion the spec still marks `planned` — listed and
 * shape-checked, but never executed (KD-15).
 *
 * An earlier revision counted every non-`pending` status, which made a
 * criterion recorded as `fail` or `error` "covered" and left only the
 * aggregate `verdict` standing between that payload and a pass. Requiring
 * `pass` per criterion means the gate does not depend on the producer
 * summarising its own run correctly.
 *
 * @param {object} payload
 * @returns {Map<string, Set<string>>}
 */
export function payloadCoverage(payload) {
  const out = new Map();
  for (const spec of payload.specs ?? []) {
    out.set(spec.id, new Set((spec.criteria ?? []).filter((c) => c.status === "pass").map((c) => c.id)));
  }
  return out;
}
