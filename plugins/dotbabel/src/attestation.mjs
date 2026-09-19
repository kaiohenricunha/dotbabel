/**
 * Attestation evidence — the machine-readable half of a local-attest comment.
 *
 * `local-attest` used to post a human table whose only gate-readable part was
 * the marker on line 1: "the configured matrix passed at this SHA". That was
 * enough while the marker only skipped a redundant remote run. It is not
 * enough now that the merge gate treats the same comment as authorization to
 * skip verification entirely, because the marker says nothing about WHICH
 * matrix ran:
 *
 *     // base ref                                // the pull request
 *     { name: "test", command: "npm test" }  ->  { name: "test", command: "true" }
 *
 * Both produce a truthful `{"name":"test","status":"pass"}`. So the payload
 * records a hash of the files that govern the run, and the gate recomputes
 * that hash from the BASE ref. A pull request that edits those files cannot
 * attest itself; once the change lands on the trunk, later pull requests
 * attest against it.
 *
 * **What this does and does not cover.** A leg command is usually an
 * indirection — `npm test`, `bash scripts/run-bats.sh` — so hashing the matrix
 * definition alone would leave the hop open: rewrite `package.json`'s `test`
 * script and the leg still reports a truthful pass. `governance_files` is
 * therefore configured to name the script targets too, not just the matrix.
 *
 * The residual is the tooling the legs invoke from `plugins/dotbabel/src/**`.
 * Hashing that tree would make every pull request touching the package report
 * ATTESTATION_CONFIG_CHANGED, so it is deliberately excluded: it is a protected
 * path requiring spec review, and the tool's own tests run inside the same
 * matrix. The guarantee is "the configured commands and their script targets
 * are the ones the trunk agreed to", not "the entire toolchain is pinned".
 *
 * Pure apart from `node:crypto` — no I/O, no clock of its own. The caller
 * reads the file bytes and passes them in, which is what lets the gate stay
 * testable and lets `hashGovernanceFiles` be called identically by the
 * producer (real working tree) and the judge (`git show <base>:<path>`).
 */
import { createHash } from "node:crypto";

import { createMarker } from "./lib/attest-marker.mjs";
import { decodePayloadLine, encodePayloadLine } from "./lib/evidence-payload.mjs";

/**
 * Line 1 of an attestation comment. Byte-exact: `.github/workflows/test.yml`
 * greps for this string with `grep -qFx`, so changing it silently un-gates
 * every consumer's CI.
 */
export const ATTEST_MARKER_PREFIX = "<!-- local-attest verified-sha=";

/** Line 2 of an attestation comment. */
export const ATTEST_PAYLOAD_LINE_PREFIX = "<!-- local-attest-payload ";

/** Files whose contents define what an attestation actually proves. */
export const DEFAULT_GOVERNANCE_FILES = Object.freeze([".local-attest.config.mjs", ".dotbabel.json"]);

const GOVERNED_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * True when a `governance_files` entry is a plain relative path inside the
 * repository.
 *
 * The list is authored in `.dotbabel.json`, which the producer reads at the pull
 * request's HEAD, and each entry reaches `git show <rev>:<path>`. An entry that
 * escapes the repository or carries shell metacharacters is a configuration bug,
 * and on the producer side an injection vector. Both sides apply this one
 * predicate, so neither can be talked into running an entry the other refuses.
 *
 * Refusing is also the fail-closed direction: the gate drops an entry that fails
 * this test while the producer still hashes it (as absent), so the two hashes
 * can never match and every merge blocks until the trunk's configuration is
 * fixed. `dotbabel doctor` reports the entry before that happens.
 *
 * @param {unknown} path
 * @returns {boolean}
 */
export function isGovernablePath(path) {
  return typeof path === "string" && GOVERNED_PATH_RE.test(path) && !path.includes("..");
}

const marker = createMarker(ATTEST_MARKER_PREFIX);

/**
 * Field framing for the digest.
 *
 * Length-prefixed, not separator-joined. A single separator is ambiguous: with
 * it, path `"a b"` + content `"c"` digests identically to path `"a"` + content
 * `"b c"`, and a file whose content is literally the absent sentinel collides
 * with a missing file - the exact distinction the sentinel exists to preserve.
 * Prefixing each field with its byte length removes the ambiguity entirely.
 */
const ABSENT_TAG = 0;
const PRESENT_TAG = 1;

/**
 * Hash the governance files into one value both sides can compute.
 *
 * The path is hashed alongside the bytes so that moving content between two
 * governed files changes the hash, and an absent file hashes differently from
 * an empty one — otherwise deleting `.dotbabel.json` would look identical to
 * emptying it, and both would look identical to a repository that never had
 * one.
 *
 * @param {Array<{path: string, bytes: string|Uint8Array|null}>} entries
 *   `bytes` is null when the file does not exist at that revision.
 * @returns {string} `"sha256:<64 hex>"`
 */
export function hashGovernanceFiles(entries) {
  const list = Array.isArray(entries) ? [...entries] : [];
  list.sort((a, b) => (String(a?.path) < String(b?.path) ? -1 : String(a?.path) > String(b?.path) ? 1 : 0));
  const h = createHash("sha256");
  const field = (value) => {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length);
    h.update(len);
    h.update(buf);
  };
  for (const entry of list) {
    field(String(entry?.path ?? ""));
    const absent = entry?.bytes === null || entry?.bytes === undefined;
    // The presence tag is out of band, so no file content can impersonate it.
    h.update(Buffer.from([absent ? ABSENT_TAG : PRESENT_TAG]));
    if (!absent) field(entry.bytes);
  }
  return `sha256:${h.digest("hex")}`;
}

/**
 * Build the evidence payload for one attested run.
 *
 * `legs` is passed in already classified rather than derived here, so the
 * comment table, the audit log and this payload all read the same
 * `legStatus` output and cannot disagree about what happened.
 *
 * @param {{ headSha: string, mergeBase?: string|null, configHash?: string|null,
 *           legs: Array<{name: string, mode: string, status: string}>,
 *           toolchain?: object|null, toolVersion?: string, now?: Date }} input
 * @returns {object}
 */
export function buildAttestationPayload({ headSha, mergeBase, configHash, legs, toolchain, toolVersion, now }) {
  const list = Array.isArray(legs) ? legs : [];
  /** @type {any} */
  const payload = {
    schema_version: 1,
    tool: { name: "dotbabel", ...(toolVersion ? { version: toolVersion } : {}) },
    head_sha: headSha,
    generated_at: (now ?? new Date()).toISOString(),
    // A payload only ever rides on a comment that `shouldAttest` cleared, so
    // the verdict is derived from the legs rather than trusted from a caller.
    verdict: list.some((l) => l && l.mode === "hard" && l.status !== "pass" && l.status !== "skipped") ? "fail" : "pass",
    legs: list.map((l) => ({ name: l.name, mode: l.mode, status: l.status })),
  };
  if (mergeBase) payload.merge_base = mergeBase;
  if (configHash) payload.config_hash = configHash;
  if (toolchain && Object.keys(toolchain).length > 0) payload.toolchain = toolchain;
  return payload;
}

/**
 * Render the two fixed lines every attestation comment starts with.
 *
 * @param {object} payload
 * @returns {string}
 */
export function renderAttestationHeader(payload) {
  return `${marker.build(payload.head_sha)}\n${encodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, payload)}`;
}

/**
 * @typedef {object} ParsedAttestation
 * @property {"ok"|"not-attestation"|"no-payload"|"undecodable"|"sha-mismatch"} state
 * @property {string|null} sha
 * @property {object|null} payload
 * @property {string|null} detail
 */

/**
 * Parse one comment body into its marker SHA and attestation payload.
 *
 * `no-payload` is distinct from `undecodable`: a comment written by a tool
 * version that predates the payload is stale tooling, not a forgery, and the
 * gate reports the two differently. `sha-mismatch` mirrors the criteria
 * parser — the marker is what the gate greps and the payload is what it
 * believes, so letting them disagree would let a trusted-looking marker vouch
 * for another commit's results.
 *
 * @param {unknown} body
 * @returns {ParsedAttestation}
 */
export function parseAttestationComment(body) {
  const sha = marker.parseSha(body);
  if (sha === null) return { state: "not-attestation", sha: null, payload: null, detail: null };

  const decoded = decodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, body);
  if (decoded.state === "absent") {
    return { state: "no-payload", sha, payload: null, detail: decoded.detail };
  }
  if (decoded.state !== "ok") {
    return { state: "undecodable", sha, payload: null, detail: decoded.detail };
  }
  const payload = /** @type {any} */ (decoded.payload);
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
 * Shape-check a decoded payload against the fields the gate reads.
 *
 * Not the full JSON Schema — the gate is pure and synchronous. It checks
 * exactly what the gate touches, so a payload that passes here cannot make the
 * gate throw. `schemas/dotbabel.attestation-evidence.schema.json` stays
 * authoritative for producers.
 *
 * @param {unknown} payload
 * @returns {string|null} A reason it is invalid, or null when usable.
 */
export function attestationPayloadProblem(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return "payload is not an object";
  const p = /** @type {any} */ (payload);
  if (p.schema_version !== 1) return `unsupported schema_version: ${JSON.stringify(p.schema_version)}`;
  if (typeof p.head_sha !== "string" || !/^[0-9a-f]{40}$/i.test(p.head_sha)) return "head_sha is missing or malformed";
  if (typeof p.verdict !== "string") return "verdict is missing";
  if (!Array.isArray(p.legs)) return "legs is not an array";
  for (const leg of p.legs) {
    if (leg === null || typeof leg !== "object" || Array.isArray(leg)) return "a leg entry is not an object";
    if (typeof leg.name !== "string" || leg.name === "") return "a leg entry has no name";
    if (typeof leg.status !== "string" || leg.status === "") return `leg ${leg.name} has no status`;
  }
  return null;
}

/**
 * The leg names a payload reports as actually having passed.
 *
 * Only `pass` counts. `skipped` is deliberately excluded: a diff-scoped skip
 * is sound for CI parity, where the same job skips remotely, but it proves
 * nothing ran — and a required leg is required precisely because the merge
 * gate is about to stop checking it itself.
 *
 * @param {object} payload
 * @returns {Set<string>}
 */
export function passedLegs(payload) {
  const out = new Set();
  for (const leg of payload?.legs ?? []) {
    if (leg && leg.status === "pass" && typeof leg.name === "string") out.add(leg.name);
  }
  return out;
}

/**
 * True when a trusted, never-edited comment carries a passing attestation for
 * exactly this head.
 *
 * This is the conductor's question ("has the attest phase already happened for
 * this commit?"), not the merge gate's ("may this merge?"). It ignores
 * `attestation.enforce`, the governance hash and the required legs on purpose:
 * those decide whether `/merge-pr` may rely on the attestation, and a
 * repository that does not enforce still has a finished attest phase.
 *
 * @param {{ comments: Array<{body: string, authorAssociation: string, lastEditedAt?: string|null}>|null|undefined,
 *           headSha: unknown, trustedAssociations?: string[] }} input
 * @returns {boolean}
 */
export function hasCurrentAttestation({ comments, headSha, trustedAssociations }) {
  if (!Array.isArray(comments) || typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) return false;
  const trusted = new Set(trustedAssociations ?? ["OWNER"]);
  return comments.some((c) => {
    if (!c || !trusted.has(c.authorAssociation) || (c.lastEditedAt ?? null) !== null) return false;
    const parsed = parseAttestationComment(c.body);
    return (
      parsed.state === "ok" &&
      String(parsed.sha).toLowerCase() === headSha.toLowerCase() &&
      attestationPayloadProblem(parsed.payload) === null &&
      /** @type {any} */ (parsed.payload).verdict === "pass"
    );
  });
}
