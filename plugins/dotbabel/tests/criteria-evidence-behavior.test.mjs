// Behavioral boundaries of `criteria/evidence.mjs` (TEST-1, mutation floor 85).
//
// `criteria-evidence.test.mjs` proves the round trip through the real renderer
// and the happy-path payload shape checks. This file is additive and sits on
// the edges that round trip never reaches: a hand-crafted comment whose second
// line is almost-but-not-quite the payload line, a payload whose `head_sha`
// disagrees with its marker in case only, garbage that fails to decode rather
// than fails to parse, and every type boundary `evidencePayloadProblem` and
// `payloadCoverage` check. The body here is attacker-influenced text, so each
// failure mode has to land on its own state rather than collapsing into a
// different, more permissive one.
//
// Assertions read `state`, `sha` and `payload` (what the gate branches on) and,
// where a literal in `detail` is itself the thing under test, the text of
// `detail` — never the wording of a message nobody branches on.

import { describe, expect, it } from "vitest";

import { CRITERIA_MARKER_PREFIX } from "../src/criteria/comment.mjs";
import { evidencePayloadProblem, parseEvidenceComment, payloadCoverage } from "../src/criteria/evidence.mjs";

const SHA = "a".repeat(40);
const marker = (sha = SHA) => `${CRITERIA_MARKER_PREFIX}${sha} -->`;
const PAYLOAD_PREFIX = "<!-- dotbabel-criteria-payload ";

const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const payloadLine = (value) => `${PAYLOAD_PREFIX}${encode(value)} -->`;
const comment = (markerLine, second) => `${markerLine}\n${second}`;

const basePayload = (over = {}) => ({
  schema_version: 1,
  tool: { name: "dotbabel", version: "3.4.0" },
  head_sha: SHA,
  pr: 42,
  generated_at: "2026-01-01T00:00:00.000Z",
  verdict: "pass",
  specs: [{ id: "example", criteria: [{ id: "AC-1", status: "pass" }] }],
  ...over,
});

describe("parseEvidenceComment: finding the payload line", () => {
  it("is not-evidence when there is no marker at all, whatever the body is", () => {
    for (const body of ["", "some text", "no marker here\nor here"]) {
      expect(parseEvidenceComment(body)).toEqual({ state: "not-evidence", sha: null, payload: null, detail: null });
    }
  });

  it("is undecodable, not not-evidence, when the marker line has no second line", () => {
    // A single-line body still identifies a SHA, so the gate must not read this
    // as "no evidence" — a later, genuinely evidence-free comment could then
    // satisfy that weaker state.
    expect(parseEvidenceComment(marker())).toMatchObject({ state: "undecodable", sha: SHA, payload: null });
  });

  it("is undecodable when the second line starts correctly but does not end with the closing marker", () => {
    // Exact detail, not just the state: a line that fails only the suffix check
    // still reaches the decode step if that check is ever skipped, and a
    // truncated payload usually still fails to decode -- landing on the SAME
    // state through a different path with a DIFFERENT detail. Only the exact
    // detail proves the early return, not a later accident, produced it.
    const noSuffix = { state: "undecodable", sha: SHA, payload: null, detail: "line 2 is not the payload comment" };
    expect(parseEvidenceComment(comment(marker(), `${PAYLOAD_PREFIX}${encode(basePayload())}`))).toEqual(noSuffix);
    expect(parseEvidenceComment(comment(marker(), `${PAYLOAD_PREFIX}${encode(basePayload())} --`))).toEqual(noSuffix);
  });

  it("is undecodable when the second line ends correctly but does not start with the payload prefix", () => {
    const noPrefix = { state: "undecodable", sha: SHA, payload: null, detail: "line 2 is not the payload comment" };
    expect(parseEvidenceComment(comment(marker(), `not the payload ${encode(basePayload())} -->`))).toEqual(noPrefix);
    // A reply someone typed by hand, coincidentally ending the same way.
    expect(parseEvidenceComment(comment(marker(), "looks like it might work -->"))).toEqual(noPrefix);
  });

  it("names line 2 as the problem, for a reader debugging a broken comment", () => {
    expect(parseEvidenceComment(comment(marker(), "someone replied here")).detail).toBe("line 2 is not the payload comment");
  });

  it("trims incidental whitespace around the encoded payload before decoding", () => {
    const encoded = encode(basePayload());
    expect(parseEvidenceComment(comment(marker(), `${PAYLOAD_PREFIX}  ${encoded}  -->`))).toMatchObject({ state: "ok", payload: basePayload() });
  });
});

describe("parseEvidenceComment: decoding the payload", () => {
  it("is undecodable when the encoded text is not valid base64url content, and says why", () => {
    const body = comment(marker(), `${PAYLOAD_PREFIX}not valid base64!! -->`);
    const parsed = parseEvidenceComment(body);
    expect(parsed).toMatchObject({ state: "undecodable", sha: SHA, payload: null });
    expect(parsed.detail).toMatch(/^payload did not decode: /);
  });

  it("is undecodable when the decoded bytes are valid text but not JSON", () => {
    const encoded = Buffer.from("not { json", "utf8").toString("base64url");
    expect(parseEvidenceComment(comment(marker(), `${PAYLOAD_PREFIX}${encoded} -->`))).toMatchObject({ state: "undecodable", sha: SHA });
  });

  it.each([
    ["an array", "[1,2]"],
    ["a number", "5"],
    ["a string", '"hello"'],
    ["null", "null"],
    ["a boolean", "true"],
  ])("is undecodable with an exact reason when the decoded JSON is %s, not an object", (_label, json) => {
    const encoded = Buffer.from(json, "utf8").toString("base64url");
    expect(parseEvidenceComment(comment(marker(), `${PAYLOAD_PREFIX}${encoded} -->`))).toMatchObject({ state: "undecodable", sha: SHA, payload: null, detail: "payload is not an object" });
  });

  it("decodes an ordinary object payload, whatever fields it carries", () => {
    expect(parseEvidenceComment(comment(marker(), payloadLine({ head_sha: SHA, extra: "field" })))).toMatchObject({ state: "ok", payload: { head_sha: SHA, extra: "field" } });
  });
});

describe("parseEvidenceComment: the marker binds the payload to one commit", () => {
  it("is sha-mismatch, not ok, when the payload omits head_sha entirely", () => {
    const p = basePayload();
    delete p.head_sha;
    expect(parseEvidenceComment(comment(marker(), payloadLine(p)))).toMatchObject({ state: "sha-mismatch", sha: SHA, payload: p });
  });

  it("is sha-mismatch when the two shas differ only in letter case", () => {
    // The marker's own case is preserved, not normalised, so this is an exact
    // string comparison, not a case-insensitive commit-id comparison.
    const upper = SHA.toUpperCase();
    const p = basePayload({ head_sha: SHA });
    expect(parseEvidenceComment(comment(marker(upper), payloadLine(p)))).toMatchObject({ state: "sha-mismatch", sha: upper });
  });

  it("names both shas in the detail, in the order marker-names-are-believed then payload-says", () => {
    const other = "b".repeat(40);
    const p = basePayload({ head_sha: other });
    const parsed = parseEvidenceComment(comment(marker(SHA), payloadLine(p)));
    expect(parsed.detail).toBe(`payload head_sha ${other} does not match marker ${SHA}`);
  });

  it("is ok, carrying the payload through unchanged, when the shas agree", () => {
    const p = basePayload({ head_sha: SHA });
    expect(parseEvidenceComment(comment(marker(SHA), payloadLine(p)))).toEqual({ state: "ok", sha: SHA, payload: p, detail: null });
  });
});

describe("evidencePayloadProblem: the payload itself", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "x"],
    ["a number", 5],
    ["a boolean", true],
    ["undefined", undefined],
  ])("rejects %s as not an object", (_label, value) => {
    expect(evidencePayloadProblem(value)).toBe("payload is not an object");
  });

  it("accepts a bare object with only the required shape", () => {
    expect(evidencePayloadProblem(basePayload())).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["the string \"1\"", "1"],
    ["1.5", 1.5],
    ["0", 0],
    ["2", 2],
  ])("rejects schema_version when it is %s", (_label, value) => {
    expect(evidencePayloadProblem(basePayload({ schema_version: value }))).toMatch(/schema_version/);
  });

  it("accepts schema_version exactly 1", () => {
    expect(evidencePayloadProblem(basePayload({ schema_version: 1 }))).toBeNull();
  });
});

describe("evidencePayloadProblem: head_sha", () => {
  const withSha = (head_sha) => evidencePayloadProblem(basePayload({ head_sha }));

  it.each([
    ["missing", undefined],
    ["39 characters", "a".repeat(39)],
    ["41 characters", "a".repeat(41)],
    ["a non-hex character", `${"a".repeat(39)}g`],
    ["a number", 5],
    ["null", null],
    ["a trailing newline", `${SHA}\n`],
  ])("rejects a head_sha with %s", (_label, value) => {
    expect(withSha(value)).toMatch(/head_sha/);
  });

  it("accepts 40 hex characters in either letter case", () => {
    expect(withSha(SHA)).toBeNull();
    expect(withSha(SHA.toUpperCase())).toBeNull();
  });

  it("rejects a non-string value even when it implicitly stringifies to a valid-looking sha", () => {
    // `RegExp.prototype.test` coerces its argument with `String(...)` before
    // matching. A single-element array's `toString` is its one element's own
    // string, so `[SHA].toString() === SHA` -- a regex test alone cannot tell
    // this apart from the real thing. The `typeof` check exists for exactly
    // this: `head_sha` must BE a string, not merely coerce to look like one.
    expect(withSha([SHA])).toMatch(/head_sha/);
    expect(withSha({ toString: () => SHA })).toMatch(/head_sha/);
  });
});

describe("evidencePayloadProblem: specs and criteria", () => {
  const withSpecs = (specs) => evidencePayloadProblem(basePayload({ specs }));

  it("accepts an empty specs list", () => {
    expect(withSpecs([])).toBeNull();
  });

  it.each([
    ["a string", "nope"],
    ["null", null],
    ["a number", 5],
    ["an array", []],
  ])("rejects a spec entry that is %s", (_label, entry) => {
    expect(withSpecs([entry])).toBe("a spec entry is not an object");
  });

  it.each([
    ["missing", undefined],
    ["an empty string", ""],
    ["a number", 5],
  ])("rejects a spec whose id is %s", (_label, id) => {
    expect(withSpecs([{ id, criteria: [] }])).toBe("a spec entry has no id");
  });

  it.each([
    ["missing", undefined],
    ["a string", "nope"],
    ["an object", {}],
  ])("rejects a spec whose criteria is %s, and names the spec", (_label, criteria) => {
    expect(withSpecs([{ id: "example", criteria }])).toBe("spec example has no criteria array");
  });

  it("accepts an empty criteria list", () => {
    expect(withSpecs([{ id: "example", criteria: [] }])).toBeNull();
  });

  it.each([
    ["a string", "nope"],
    ["null", null],
    ["an array", []],
  ])("rejects a criterion that is %s, and names the spec it is in", (_label, entry) => {
    expect(withSpecs([{ id: "example", criteria: [entry] }])).toBe("a criterion of example is not an object");
  });

  it.each([
    ["missing", undefined],
    ["an empty string", ""],
    ["a number", 5],
  ])("rejects a criterion whose id is %s, and names its spec", (_label, id) => {
    expect(withSpecs([{ id: "example", criteria: [{ id, status: "pass" }] }])).toBe("a criterion of example has no id");
  });

  it.each([
    ["missing", undefined],
    ["a number", 5],
    ["null", null],
  ])("rejects a criterion whose status is %s, and names both spec and criterion", (_label, status) => {
    expect(withSpecs([{ id: "example", criteria: [{ id: "AC-1", status }] }])).toBe("criterion example/AC-1 has no status");
  });

  it("accepts any string status, since only the caller of payloadCoverage cares which one", () => {
    for (const status of ["pass", "fail", "error", "pending", "unconfirmed", "anything"]) {
      expect(withSpecs([{ id: "example", criteria: [{ id: "AC-1", status }] }])).toBeNull();
    }
  });

  it("reports the first problem it finds, in spec-then-criterion order", () => {
    expect(withSpecs([{ id: "ok", criteria: [] }, "not an object"])).toBe("a spec entry is not an object");
    expect(withSpecs([{ id: "example", criteria: [{ id: "AC-1", status: "pass" }, { id: "AC-2" }] }])).toBe("criterion example/AC-2 has no status");
  });
});

describe("payloadCoverage", () => {
  const coverage = (specs) => payloadCoverage(basePayload({ specs }));
  const setOf = (map, id) => [...(map.get(id) ?? [])].sort();

  it("counts only pass, excluding every other status a producer can emit", () => {
    const map = coverage([{ id: "example", criteria: [
      { id: "AC-1", status: "pass" },
      { id: "AC-2", status: "fail" },
      { id: "AC-3", status: "error" },
      { id: "AC-4", status: "pending" },
      { id: "AC-5", status: "unconfirmed" },
    ] }]);
    expect(setOf(map, "example")).toEqual(["AC-1"]);
  });

  it("keeps each spec's criteria in its own set, even when two specs share a criterion id", () => {
    const map = coverage([
      { id: "spec-a", criteria: [{ id: "AC-1", status: "pass" }] },
      { id: "spec-b", criteria: [{ id: "AC-1", status: "fail" }] },
    ]);
    expect(setOf(map, "spec-a")).toEqual(["AC-1"]);
    expect(setOf(map, "spec-b")).toEqual([]);
  });

  it("gives an empty set to a spec with no criteria, rather than omitting it", () => {
    const map = coverage([{ id: "example", criteria: [] }]);
    expect(map.has("example")).toBe(true);
    expect(setOf(map, "example")).toEqual([]);
  });

  it("does not throw on a spec with no criteria array at all", () => {
    const map = coverage([{ id: "example" }]);
    expect(setOf(map, "example")).toEqual([]);
  });

  it("does not throw on a payload with no specs array at all", () => {
    const map = payloadCoverage({ head_sha: SHA });
    expect(map.size).toBe(0);
  });

  it("returns an empty map for a payload with an empty specs list", () => {
    expect(coverage([]).size).toBe(0);
  });
});
