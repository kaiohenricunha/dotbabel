import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  POST_PR_REVIEW_FINDING_RE,
  POST_PR_REVIEW_RECEIPT_MARKER,
  REVIEW_MARKER_PREFIX,
  REVIEW_PAYLOAD_LINE_PREFIX,
  buildReviewPayload,
  checkReviewReceipt,
  evaluateReviewCompletion,
  evaluateReviewEvidence,
  parseReviewComment,
  renderReviewComment,
  reviewPayloadProblem,
} from "../src/review-evidence.mjs";
import { ATTEST_MARKER_PREFIX, buildAttestationPayload, renderAttestationHeader } from "../src/attestation.mjs";
import { decodePayloadLine, encodePayloadLine } from "../src/lib/evidence-payload.mjs";

const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const REVIEWED = "c".repeat(40);
const NOW = new Date("2026-01-01T00:00:00.000Z");

const payload = (over = {}) =>
  buildReviewPayload({
    headSha: HEAD,
    reviewedSha: REVIEWED,
    findings: { posted: 3, unresolved: 0 },
    otherOpenThreads: 1,
    now: NOW,
    ...over,
  });

const body = (p = payload()) => renderReviewComment(p);
const comment = (over = {}) => ({
  body: body(),
  authorAssociation: "OWNER",
  authorLogin: "kaio",
  lastEditedAt: null,
  ...over,
});

describe("marker constants", () => {
  it("keeps the marker and payload prefixes byte-exact", () => {
    // The guard hook and the conductor's re-entry both match these strings. A
    // silent change would leave a producer posting evidence its reader cannot find.
    expect(REVIEW_MARKER_PREFIX).toBe("<!-- review-complete verified-sha=");
    expect(REVIEW_PAYLOAD_LINE_PREFIX).toBe("<!-- review-complete-payload ");
    expect(POST_PR_REVIEW_RECEIPT_MARKER).toBe("<!-- post-pr-review:v1:receipt -->");
  });

  it("matches a finding marker but not the receipt marker", () => {
    expect(POST_PR_REVIEW_FINDING_RE.test("x <!-- post-pr-review:v1:0123456789abcdef --> y")).toBe(true);
    expect(POST_PR_REVIEW_FINDING_RE.test(POST_PR_REVIEW_RECEIPT_MARKER)).toBe(false);
    expect(POST_PR_REVIEW_FINDING_RE.test("<!-- post-pr-review:v1:0123456789abcde -->")).toBe(false);
  });
});

describe("buildReviewPayload / renderReviewComment / parseReviewComment", () => {
  it("records the head, the reviewed commit, and the counts the gate read", () => {
    const p = payload();
    expect(p).toMatchObject({
      schema_version: 1,
      head_sha: HEAD,
      reviewed_sha: REVIEWED,
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: { posted: 3, unresolved: 0 },
      other_open_threads: 1,
    });
    expect(p.tool.name).toBe("dotbabel");
  });

  it("includes the tool version only when supplied", () => {
    expect(payload().tool).toEqual({ name: "dotbabel" });
    expect(payload({ toolVersion: "9.9.9" }).tool).toEqual({ name: "dotbabel", version: "9.9.9" });
  });

  it("leads with the SHA-pinned marker and the payload, then human text", () => {
    const lines = body().split("\n");
    expect(lines[0]).toBe(`${REVIEW_MARKER_PREFIX}${HEAD} -->`);
    expect(lines[1].startsWith(REVIEW_PAYLOAD_LINE_PREFIX)).toBe(true);
    expect(decodePayloadLine(REVIEW_PAYLOAD_LINE_PREFIX, body()).payload).toEqual(payload());
    expect(body()).toContain("## Review complete");
    expect(body()).toContain(HEAD.slice(0, 8));
  });

  it("says plainly what the marker does and does not prove", () => {
    expect(body()).toMatch(/does not (prove|show)/i);
  });

  it("round-trips through a comment body", () => {
    const parsed = parseReviewComment(body());
    expect(parsed.state).toBe("ok");
    expect(parsed.sha).toBe(HEAD);
    expect(parsed.payload).toEqual(payload());
  });

  it("ignores comments from the other evidence families", () => {
    const attestation = `${renderAttestationHeader(
      buildAttestationPayload({ headSha: HEAD, legs: [{ name: "t", mode: "hard", status: "pass" }], now: NOW }),
    )}\n## Local Attestation`;
    expect(attestation.startsWith(ATTEST_MARKER_PREFIX)).toBe(true);
    expect(parseReviewComment(attestation).state).toBe("not-review");
    expect(parseReviewComment("just a comment").state).toBe("not-review");
    expect(parseReviewComment(undefined).state).toBe("not-review");
  });

  it("reports no-payload, undecodable, and sha-mismatch as distinct states", () => {
    expect(parseReviewComment(`${REVIEW_MARKER_PREFIX}${HEAD} -->\n## Review complete`).state).toBe("no-payload");
    expect(parseReviewComment(`${REVIEW_MARKER_PREFIX}${HEAD} -->\n${REVIEW_PAYLOAD_LINE_PREFIX}@@@ -->`).state).toBe("undecodable");
    const mismatch = `${REVIEW_MARKER_PREFIX}${OLDER} -->\n${encodePayloadLine(REVIEW_PAYLOAD_LINE_PREFIX, payload())}`;
    const parsed = parseReviewComment(mismatch);
    expect(parsed.state).toBe("sha-mismatch");
    expect(parsed.detail).toContain(HEAD);
    expect(parsed.detail).toContain(OLDER);
  });

  it("refuses to build a marker for something that is not a SHA", () => {
    expect(() => renderReviewComment(payload({ headSha: "not-a-sha" }))).toThrow();
  });
});

describe("reviewPayloadProblem", () => {
  it("accepts a well-formed payload", () => {
    expect(reviewPayloadProblem(payload())).toBeNull();
  });

  it("names the first thing wrong", () => {
    expect(reviewPayloadProblem(null)).toMatch(/not an object/);
    expect(reviewPayloadProblem([])).toMatch(/not an object/);
    expect(reviewPayloadProblem({ ...payload(), schema_version: 2 })).toMatch(/schema_version/);
    expect(reviewPayloadProblem({ ...payload(), head_sha: "abc" })).toMatch(/head_sha/);
    expect(reviewPayloadProblem({ ...payload(), reviewed_sha: "abc" })).toMatch(/reviewed_sha/);
    expect(reviewPayloadProblem({ ...payload(), findings: null })).toMatch(/findings/);
    expect(reviewPayloadProblem({ ...payload(), findings: { posted: -1, unresolved: 0 } })).toMatch(/findings/);
    expect(reviewPayloadProblem({ ...payload(), findings: { posted: 1.5, unresolved: 0 } })).toMatch(/findings/);
    expect(reviewPayloadProblem({ ...payload(), findings: { posted: 1, unresolved: "0" } })).toMatch(/findings/);
  });

  it("refuses a payload that records an unresolved finding", () => {
    // The producer refuses to post one, so a payload that says so is not ours.
    expect(reviewPayloadProblem({ ...payload(), findings: { posted: 2, unresolved: 1 } })).toMatch(/unresolved/);
  });
});

describe("evaluateReviewEvidence", () => {
  const evalWith = (comments, over = {}) => evaluateReviewEvidence({ comments, headSha: HEAD, ...over });

  it("reports reviewed for a current, trusted, unedited comment", () => {
    expect(evalWith([comment()])).toMatchObject({ state: "reviewed", code: null, sha: HEAD });
  });

  it("reports REVIEW_MISSING when no comment carries the marker", () => {
    expect(evalWith([])).toMatchObject({ state: "not-reviewed", code: "REVIEW_MISSING" });
    expect(evalWith([comment({ body: "hello" })])).toMatchObject({ code: "REVIEW_MISSING" });
  });

  it("ignores a marker quoted below line 1", () => {
    expect(evalWith([comment({ body: `quoting:\n${body()}` })])).toMatchObject({ code: "REVIEW_MISSING" });
  });

  it("reports REVIEW_UNTRUSTED for a non-owner and for an edited comment", () => {
    expect(evalWith([comment({ authorAssociation: "NONE" })])).toMatchObject({ code: "REVIEW_UNTRUSTED" });
    expect(evalWith([comment({ authorAssociation: "CONTRIBUTOR" })])).toMatchObject({ code: "REVIEW_UNTRUSTED" });
    expect(evalWith([comment({ lastEditedAt: "2026-01-02T00:00:00Z" })])).toMatchObject({ code: "REVIEW_UNTRUSTED" });
  });

  it("honors trustedAssociations, defaulting to OWNER alone", () => {
    expect(evalWith([comment({ authorAssociation: "MEMBER" })])).toMatchObject({ code: "REVIEW_UNTRUSTED" });
    expect(evalWith([comment({ authorAssociation: "MEMBER" })], { trustedAssociations: ["OWNER", "MEMBER"] })).toMatchObject({
      state: "reviewed",
    });
  });

  it("reports REVIEW_STALE, naming both commits, when a trusted comment names another head", () => {
    const stale = comment({ body: body(payload({ headSha: OLDER })) });
    const r = evalWith([stale]);
    expect(r).toMatchObject({ state: "not-reviewed", code: "REVIEW_STALE", sha: OLDER });
    expect(r.detail).toContain(OLDER.slice(0, 8));
    expect(r.detail).toContain(HEAD.slice(0, 8));
  });

  it("prefers a current comment over an older one, whatever the order", () => {
    const stale = comment({ body: body(payload({ headSha: OLDER })) });
    expect(evalWith([stale, comment()]).state).toBe("reviewed");
    expect(evalWith([comment(), stale]).state).toBe("reviewed");
  });

  it("does not let an untrusted current comment hide behind a trusted stale one", () => {
    const stale = comment({ body: body(payload({ headSha: OLDER })) });
    expect(evalWith([stale, comment({ authorAssociation: "NONE" })])).toMatchObject({ code: "REVIEW_STALE" });
  });

  it("reports REVIEW_INVALID for a payload that is absent, corrupt, mismatched, or malformed", () => {
    const cases = [
      `${REVIEW_MARKER_PREFIX}${HEAD} -->\n## Review complete`,
      `${REVIEW_MARKER_PREFIX}${HEAD} -->\n${REVIEW_PAYLOAD_LINE_PREFIX}@@@ -->`,
      `${REVIEW_MARKER_PREFIX}${HEAD} -->\n${encodePayloadLine(REVIEW_PAYLOAD_LINE_PREFIX, payload({ headSha: OLDER }))}`,
      `${REVIEW_MARKER_PREFIX}${HEAD} -->\n${encodePayloadLine(REVIEW_PAYLOAD_LINE_PREFIX, { ...payload(), schema_version: 9 })}`,
    ];
    for (const b of cases) {
      const r = evalWith([comment({ body: b })]);
      expect(r, b).toMatchObject({ state: "not-reviewed", code: "REVIEW_INVALID" });
      expect(r.detail).toBeTruthy();
    }
  });

  it("fails closed when the comment list could not be read", () => {
    expect(evalWith(null)).toMatchObject({ state: "not-reviewed", code: "REVIEW_INVALID" });
    expect(evalWith(undefined)).toMatchObject({ state: "not-reviewed", code: "REVIEW_INVALID" });
  });

  it("fails closed when the head SHA is unknown", () => {
    for (const headSha of [undefined, null, "", "short"]) {
      expect(evaluateReviewEvidence({ comments: [comment()], headSha })).toMatchObject({
        state: "not-reviewed",
        code: "REVIEW_INVALID",
      });
    }
  });

  it("skips null and non-object entries without throwing", () => {
    expect(evalWith([null, undefined, 3, comment()]).state).toBe("reviewed");
  });
});

describe("checkReviewReceipt", () => {
  const review = (over = {}) => ({
    body: `${POST_PR_REVIEW_RECEIPT_MARKER}\npost-pr-review: 2 posted`,
    authorAssociation: "OWNER",
    lastEditedAt: null,
    commitOid: REVIEWED,
    ...over,
  });
  const ancestors = (...oids) => (oid, head) => head === HEAD && oids.includes(oid);
  const check = (reviews, isAncestor = ancestors(REVIEWED, HEAD), over = {}) =>
    checkReviewReceipt({ reviews, headSha: HEAD, isAncestor, ...over });

  it("accepts a trusted, unedited receipt for an ancestor of the head", () => {
    expect(check([review()])).toEqual({ ok: true, reviewedSha: REVIEWED, code: null, detail: null });
  });

  it("accepts a receipt for the head itself", () => {
    expect(check([review({ commitOid: HEAD })]).reviewedSha).toBe(HEAD);
  });

  it("rejects a receipt for a commit that is not an ancestor of the head", () => {
    const r = check([review({ commitOid: OLDER })]);
    expect(r).toMatchObject({ ok: false, code: "REVIEW_NO_RECEIPT" });
    expect(r.detail).toContain(OLDER.slice(0, 8));
  });

  it("rejects untrusted and edited receipts", () => {
    expect(check([review({ authorAssociation: "NONE" })]).ok).toBe(false);
    expect(check([review({ lastEditedAt: "2026-01-02T00:00:00Z" })]).ok).toBe(false);
  });

  it("requires the receipt marker on the first line, so a quotation does not count", () => {
    expect(check([review({ body: `see ${POST_PR_REVIEW_RECEIPT_MARKER}` })]).ok).toBe(false);
    expect(check([review({ body: `text\n${POST_PR_REVIEW_RECEIPT_MARKER}` })]).ok).toBe(false);
    expect(check([review({ body: "no marker at all" })]).ok).toBe(false);
  });

  it("rejects a review with no usable commit", () => {
    for (const commitOid of [undefined, null, "", "abc", "z".repeat(40)]) {
      expect(check([review({ commitOid })]).ok, String(commitOid)).toBe(false);
    }
  });

  it("uses the most recent qualifying receipt", () => {
    const later = "d".repeat(40);
    const r = check([review(), review({ commitOid: later })], ancestors(REVIEWED, later));
    expect(r.reviewedSha).toBe(later);
  });

  it("skips a non-qualifying receipt and finds an earlier qualifying one", () => {
    const r = check([review(), review({ commitOid: OLDER })]);
    expect(r).toMatchObject({ ok: true, reviewedSha: REVIEWED });
  });

  it("fails closed when reviews could not be read or ancestry cannot be decided", () => {
    expect(check(null)).toMatchObject({ ok: false, code: "REVIEW_UNREADABLE" });
    expect(check([review()], () => {
      throw new Error("git failed");
    })).toMatchObject({ ok: false, code: "REVIEW_UNREADABLE" });
    // No ancestry function at all (not a default): the check cannot be made, so it is refused.
    expect(checkReviewReceipt({ reviews: [review()], headSha: HEAD })).toMatchObject({
      ok: false,
      code: "REVIEW_UNREADABLE",
    });
  });

  it("reports no receipt for an empty list", () => {
    expect(check([])).toMatchObject({ ok: false, code: "REVIEW_NO_RECEIPT" });
  });

  it("honors trustedAssociations", () => {
    expect(
      check([review({ authorAssociation: "MEMBER" })], ancestors(REVIEWED, HEAD), {
        trustedAssociations: ["OWNER", "MEMBER"],
      }).ok,
    ).toBe(true);
  });
});

describe("evaluateReviewCompletion", () => {
  const receipt = { ok: true, reviewedSha: REVIEWED, code: null, detail: null };
  const noReceipt = { ok: false, reviewedSha: null, code: "REVIEW_NO_RECEIPT", detail: "none" };
  const threads = (...bodies) => bodies.map((b) => ({ isResolved: false, rootBody: b }));
  const FINDING = "<!-- post-pr-review:v1:0123456789abcdef -->";

  it("passes when a receipt exists, no finding is open, and criteria are clear", () => {
    const r = evaluateReviewCompletion({ receipt, threads: [], criteriaReasons: [] });
    expect(r).toEqual({
      ok: true,
      reasons: [],
      counts: { findingsPosted: 0, findingsUnresolved: 0, otherOpenThreads: 0 },
    });
  });

  it("blocks without a receipt", () => {
    const r = evaluateReviewCompletion({ receipt: noReceipt, threads: [], criteriaReasons: [] });
    expect(r.ok).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_NO_RECEIPT"]);
  });

  it("blocks on an unresolved thread the review stage posted, and counts the rest", () => {
    const r = evaluateReviewCompletion({
      receipt,
      threads: [
        ...threads(`fix this ${FINDING}`),
        { isResolved: true, rootBody: `done ${FINDING}` },
        ...threads("a human's open question"),
      ],
      criteriaReasons: [],
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_FINDINGS_OPEN"]);
    expect(r.reasons[0].message).toContain("1");
    expect(r.counts).toEqual({ findingsPosted: 2, findingsUnresolved: 1, otherOpenThreads: 1 });
  });

  it("does not block on advisory or human threads, only reports them", () => {
    const r = evaluateReviewCompletion({ receipt, threads: threads("advisory: this test asserts nothing"), criteriaReasons: [] });
    expect(r.ok).toBe(true);
    expect(r.counts.otherOpenThreads).toBe(1);
  });

  it("blocks when the criteria half of the merge gate has a blocking reason", () => {
    const r = evaluateReviewCompletion({
      receipt,
      threads: [],
      criteriaReasons: [{ code: "CRITERIA_EVIDENCE_STALE", message: "stale" }],
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      { code: "REVIEW_CRITERIA_BLOCKED", message: expect.stringContaining("CRITERIA_EVIDENCE_STALE") },
    ]);
  });

  it("reports every failing condition together", () => {
    const r = evaluateReviewCompletion({
      receipt: noReceipt,
      threads: threads(FINDING),
      criteriaReasons: [{ code: "CRITERIA_FAILED", message: "x" }],
    });
    expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_NO_RECEIPT", "REVIEW_FINDINGS_OPEN", "REVIEW_CRITERIA_BLOCKED"]);
  });

  it("fails closed when threads could not be read", () => {
    const r = evaluateReviewCompletion({ receipt, threads: null, criteriaReasons: [] });
    expect(r.ok).toBe(false);
    expect(r.reasons.map((x) => x.code)).toEqual(["REVIEW_UNREADABLE"]);
  });
});

describe("review-evidence stays I/O-free", () => {
  it("imports no filesystem, process, or network module", () => {
    // Imports only: a mutation run instruments the source with its own `process`
    // references, so asserting on the body would test the instrumenter.
    const src = readFileSync(path.resolve(import.meta.dirname, "../src/review-evidence.mjs"), "utf8");
    const imports = [...src.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gms)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec, spec).not.toMatch(/^node:/);
  });
});

describe("dotbabel.review-evidence.schema.json", () => {
  const schema = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../../../schemas/dotbabel.review-evidence.schema.json"), "utf8"),
  );
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  it("validates what buildReviewPayload emits, so the producer and the schema cannot drift", () => {
    expect(validate(payload()), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(payload({ toolVersion: "1.2.3" })), JSON.stringify(validate.errors)).toBe(true);
  });

  it("agrees with reviewPayloadProblem on what is unusable", () => {
    const bad = [
      { ...payload(), schema_version: 2 },
      { ...payload(), head_sha: "abc" },
      { ...payload(), reviewed_sha: undefined },
      { ...payload(), findings: { posted: 1, unresolved: 1 } },
      { ...payload(), findings: { posted: -1, unresolved: 0 } },
      { ...payload(), extra: true },
    ];
    for (const p of bad) {
      expect(validate(p), JSON.stringify(p)).toBe(false);
    }
  });
});
