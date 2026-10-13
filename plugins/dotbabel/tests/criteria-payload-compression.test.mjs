// The compressed (z1) criteria payload line.
//
// Pull request #465 carried 57 active criteria across two specs and 137 named
// tests. Its evidence payload was 49,516 characters of JSON, and 66,022 once
// base64url-encoded, so `dotbabel criteria verify --post` refused to post it:
// the marker and payload lines alone were over the 60,000-character comment
// cap. Raw deflate before base64url brought that payload to 9,647 characters.
// `pr465SizedPayload()` below is a size match for it, not that payload: it has
// the same counts of criteria and named tests, with generated names. The tests
// assert size ranges, not exact figures.
//
// Three things are pinned here. The writer emits the compressed form behind
// its own prefix, deterministically. The reader still accepts the plain form,
// because evidence already posted on open pull requests must stay valid. And
// an unreadable compressed line (corrupt, not JSON, or inflating past the
// bound) lands on the SAME `undecodable` state the gate already maps to
// CRITERIA_EVIDENCE_INVALID — never on a pass, and never on "no evidence".

import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  buildCriteriaMarker,
  encodeCriteriaPayloadLine,
  renderEvidenceComment,
  MAX_PAYLOAD_JSON_BYTES,
  PAYLOAD_LINE_PREFIX,
  PAYLOAD_LINE_PREFIX_Z1,
} from "../src/criteria/comment.mjs";
import { parseEvidenceComment } from "../src/criteria/evidence.mjs";
import { checkMergeGate } from "../src/pr-gates.mjs";

const LIMIT = 60000;
const SHA = "a".repeat(40);
const SUFFIX = " -->";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const plainLine = (json) => `${PAYLOAD_LINE_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}${SUFFIX}`;
const z1Line = (bytes) => `${PAYLOAD_LINE_PREFIX_Z1}${deflateRawSync(bytes, { level: 9 }).toString("base64url")}${SUFFIX}`;
const comment = (line) => `${buildCriteriaMarker(SHA)}\n${line}`;

function samplePayload(over = {}) {
  return {
    schema_version: 1,
    tool: { name: "dotbabel", version: "4.0.0" },
    head_sha: SHA,
    pr: 42,
    generated_at: "2026-01-01T00:00:00.000Z",
    verdict: "pass",
    specs: [{ id: "example", criteria: [{ id: "AC-1", status: "pass", tests: [{ file: "t.mjs", name: "passes", found_in_file: true, confirmed_by: "junit", result: "passed" }], output_sha256: "0".repeat(64) }] }],
    ...over,
  };
}

/** A JSON object of exactly `bytes` UTF-8 bytes that still names the head. */
function jsonOfBytes(bytes) {
  const base = JSON.stringify({ head_sha: SHA, pad: "" }).length;
  return JSON.stringify({ head_sha: SHA, pad: "x".repeat(bytes - base) });
}

// --- a payload the size of #465 --------------------------------------------
//
// Test names are drawn from a fixed vocabulary with a seeded generator, so the
// fixture compresses like real English test names do and is the same on every
// run. Each criterion carries a 64-hex output hash, which deflate cannot
// shrink — the part that keeps the measurement honest.

const WORDS = (
  "accepts rejects the payload line when marker criteria gate evidence comment head commit refuses posts reads writes " +
  "spec test named junit report every active pending pass fail error trusted author association edit stale older newer " +
  "minimizes hides rows tails output redacted limit characters shrinks keeps drops details table budget fixture stub fake " +
  "graphql pages checks conclusion success failure attestation config hash base merge ref branch stack parent child rebase " +
  "retarget review complete receipt finding thread resolved unresolved schema version verdict tool name argv exit code " +
  "duration timeout truncated confirmed found file path glob linked paths coverage rationale a an of on in for with " +
  "without before after only never still once"
).split(" ");

function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pr465SizedPayload() {
  const rand = mulberry32(465);
  const pick = () => WORDS[Math.floor(rand() * WORDS.length)];
  const names = new Set();
  const nextName = () => {
    let name;
    do name = Array.from({ length: 11 + Math.floor(rand() * 6) }, pick).join(" ");
    while (names.has(name));
    names.add(name);
    return name;
  };
  let index = 0;
  const specs = [
    ["qa-verification-harness", 27],
    ["unforgeable-evidence", 30],
  ].map(([id, count]) => ({
    id,
    criteria: Array.from({ length: count }, (_, i) => {
      const acId = `AC-${i + 1}`;
      const file = `plugins/dotbabel/tests/${pick()}-${pick()}.test.mjs`;
      // 23 criteria with three tests and 34 with two: 137 in all.
      const testCount = index++ < 23 ? 3 : 2;
      return {
        id: acId,
        status: "pass",
        argv: ["npx", "vitest", "run", file, "--reporter=junit", `--outputFile=.dotbabel/criteria/${acId}.junit.xml`],
        exit_code: 0,
        duration_ms: 1000 + Math.floor(rand() * 9000),
        timed_out: false,
        truncated: false,
        tests: Array.from({ length: testCount }, () => ({ file, name: nextName(), found_in_file: true, confirmed_by: "junit", result: "passed" })),
        output_sha256: sha256(`${id}/${acId}`),
      };
    }),
  }));
  return { schema_version: 1, tool: { name: "dotbabel", version: "4.0.0" }, head_sha: SHA, pr: 465, generated_at: "2026-10-13T00:00:00.000Z", verdict: "pass", specs };
}

// --- the merge gate, end to end --------------------------------------------

const GATE_BODY = "## Summary\n\n- does a thing\n\n## Test plan\n\n- [x] npm test\n\n## Spec ID\n\nexample\n";
const gate = (body, requiredCriteria = { example: ["AC-1"] }) =>
  checkMergeGate({
    body: GATE_BODY,
    headRefOid: SHA,
    requiredCriteria,
    comments: [{ body, authorAssociation: "OWNER", authorLogin: "owner", lastEditedAt: null }],
  });
const codes = (result) => result.reasons.map((r) => r.code);

describe("the z1 payload line the writer emits", () => {
  it("uses a prefix that extends the plain one with a version tag outside the base64url alphabet", () => {
    // `:` can never start a plain base64url payload, so the two forms cannot be confused.
    expect(PAYLOAD_LINE_PREFIX_Z1).toBe(`${PAYLOAD_LINE_PREFIX}z1:`);
    const line = encodeCriteriaPayloadLine(samplePayload());
    expect(line.startsWith(PAYLOAD_LINE_PREFIX_Z1)).toBe(true);
    expect(line.endsWith(SUFFIX)).toBe(true);
    expect(line.slice(PAYLOAD_LINE_PREFIX_Z1.length, -SUFFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("carries base64url of a raw deflate stream of the payload JSON", () => {
    // Decoded here with zlib directly, not with the reader, so the format the
    // spec documents is pinned independently of the code that parses it.
    const p = samplePayload();
    const line = encodeCriteriaPayloadLine(p);
    const inflated = inflateRawSync(Buffer.from(line.slice(PAYLOAD_LINE_PREFIX_Z1.length, -SUFFIX.length), "base64url"));
    expect(JSON.parse(inflated.toString("utf8"))).toEqual(p);
    expect(inflated.toString("utf8")).toBe(JSON.stringify(p));
  });

  it("puts the z1 line on line 2 and leaves the marker on line 1 byte-identical", () => {
    const lines = renderEvidenceComment(samplePayload(), {}).split("\n");
    expect(lines[0]).toBe(`<!-- dotbabel-criteria verified-sha=${SHA} -->`);
    expect(lines[1]).toBe(encodeCriteriaPayloadLine(samplePayload()));
  });

  it("round-trips through the renderer and the reader the gate uses", () => {
    const p = samplePayload();
    expect(parseEvidenceComment(renderEvidenceComment(p, { example: { "AC-1": "some output" } }))).toEqual({ state: "ok", sha: SHA, payload: p, detail: null });
  });

  it("writes the same bytes for the same payload", () => {
    const p = samplePayload();
    expect(encodeCriteriaPayloadLine(structuredClone(p))).toBe(encodeCriteriaPayloadLine(p));
    expect(renderEvidenceComment(structuredClone(p), {})).toBe(renderEvidenceComment(p, {}));
    const big = pr465SizedPayload();
    expect(encodeCriteriaPayloadLine(pr465SizedPayload())).toBe(encodeCriteriaPayloadLine(big));
  });
});

describe("the plain payload line an older version posted", () => {
  it("still parses, so evidence already on open pull requests stays valid", () => {
    const p = samplePayload();
    expect(parseEvidenceComment(comment(plainLine(JSON.stringify(p))))).toEqual({ state: "ok", sha: SHA, payload: p, detail: null });
  });

  it("reads to the same result as the z1 form of the same payload", () => {
    const p = samplePayload();
    const plain = parseEvidenceComment(comment(plainLine(JSON.stringify(p))));
    const z1 = parseEvidenceComment(comment(z1Line(Buffer.from(JSON.stringify(p)))));
    expect(z1).toEqual(plain);
  });

  it("passes the merge gate in either form", () => {
    const p = samplePayload();
    expect(gate(comment(plainLine(JSON.stringify(p)))).ok).toBe(true);
    expect(gate(renderEvidenceComment(p, {})).ok).toBe(true);
  });
});

describe("a payload the size of pull request #465", () => {
  const p = pr465SizedPayload();
  const json = JSON.stringify(p);

  it("is a representative fixture: 57 criteria, 137 named tests, and about 49,500 characters of JSON", () => {
    const criteria = p.specs.flatMap((s) => s.criteria);
    expect(criteria).toHaveLength(57);
    expect(criteria.reduce((n, c) => n + c.tests.length, 0)).toBe(137);
    expect(new Set(criteria.flatMap((c) => c.tests.map((t) => t.name))).size).toBe(137);
    expect(json.length).toBeGreaterThan(45000);
    expect(json.length).toBeLessThan(55000);
  });

  it("does not fit under the comment cap in the plain form", () => {
    expect(buildCriteriaMarker(SHA).length + 1 + plainLine(json).length).toBeGreaterThan(LIMIT);
  });

  it("fits under the comment cap compressed, with every row of the readable table", () => {
    const body = renderEvidenceComment(p, {});
    const lines = body.split("\n");
    expect(body.length).toBeLessThanOrEqual(LIMIT);
    expect(lines[1].startsWith(PAYLOAD_LINE_PREFIX_Z1)).toBe(true);
    // Under a quarter of the plain line: the room the readable part needs.
    expect(lines[1].length).toBeLessThan(plainLine(json).length / 4);
    expect(body).not.toMatch(/more criteria not shown/);
    expect(lines.filter((l) => /^\| (qa-verification-harness|unforgeable-evidence) \| AC-\d+ \|/.test(l))).toHaveLength(57);
  });

  it("round-trips and passes the gate for every one of its criteria", () => {
    const body = renderEvidenceComment(p, {});
    expect(parseEvidenceComment(body)).toEqual({ state: "ok", sha: SHA, payload: p, detail: null });
    const required = Object.fromEntries(p.specs.map((s) => [s.id, s.criteria.map((c) => c.id)]));
    expect(gate(body, required).ok).toBe(true);
  });
});

describe("an unreadable z1 line is refused like any unreadable payload", () => {
  const undecodable = (line) => {
    const parsed = parseEvidenceComment(comment(line));
    expect(parsed).toMatchObject({ state: "undecodable", sha: SHA, payload: null });
    return parsed.detail;
  };

  it("refuses bytes that are not a deflate stream", () => {
    expect(undecodable(`${PAYLOAD_LINE_PREFIX_Z1}${Buffer.from("not a deflate stream at all").toString("base64url")}${SUFFIX}`)).toMatch(/^payload did not decode: /);
  });

  it("refuses a deflate stream cut short", () => {
    const whole = deflateRawSync(Buffer.from(JSON.stringify(samplePayload())), { level: 9 });
    const cut = whole.subarray(0, whole.length - 4).toString("base64url");
    expect(undecodable(`${PAYLOAD_LINE_PREFIX_Z1}${cut}${SUFFIX}`)).toMatch(/^payload did not decode: /);
  });

  it("refuses a stream that inflates to text that is not JSON", () => {
    expect(undecodable(z1Line(Buffer.from("not { json", "utf8")))).toMatch(/^payload did not decode: /);
  });

  it.each([
    ["an array", "[1,2]"],
    ["a number", "5"],
    ["null", "null"],
  ])("refuses a stream that inflates to JSON that is %s, with the exact reason", (_label, text) => {
    expect(undecodable(z1Line(Buffer.from(text, "utf8")))).toBe("payload is not an object");
  });

  it("reads a payload of exactly the bound, and refuses one byte more", () => {
    const atBound = jsonOfBytes(MAX_PAYLOAD_JSON_BYTES);
    expect(Buffer.byteLength(atBound)).toBe(MAX_PAYLOAD_JSON_BYTES);
    expect(parseEvidenceComment(comment(z1Line(Buffer.from(atBound))))).toMatchObject({ state: "ok", sha: SHA });

    const overBound = jsonOfBytes(MAX_PAYLOAD_JSON_BYTES + 1);
    expect(undecodable(z1Line(Buffer.from(overBound)))).toMatch(/^payload did not decode: /);
  });

  it("refuses a decompression bomb small enough to post", () => {
    // 16 MiB of spaces deflates to a line that fits in one comment.
    const line = z1Line(Buffer.alloc(16 * 1024 * 1024, 0x20));
    expect(line.length).toBeLessThan(LIMIT);
    expect(undecodable(line)).toMatch(/^payload did not decode: /);
  });

  it("does not guess the form: a z1 prefix over plain base64url, or a plain prefix over deflate, is refused", () => {
    const json = JSON.stringify(samplePayload());
    expect(undecodable(`${PAYLOAD_LINE_PREFIX_Z1}${Buffer.from(json).toString("base64url")}${SUFFIX}`)).toMatch(/^payload did not decode: /);
    expect(undecodable(`${PAYLOAD_LINE_PREFIX}${deflateRawSync(Buffer.from(json)).toString("base64url")}${SUFFIX}`)).toMatch(/^payload did not decode: /);
  });

  it("trims incidental whitespace around the encoded z1 text, like the plain form", () => {
    const encoded = deflateRawSync(Buffer.from(JSON.stringify(samplePayload()))).toString("base64url");
    expect(parseEvidenceComment(comment(`${PAYLOAD_LINE_PREFIX_Z1}  ${encoded}  ${SUFFIX}`))).toMatchObject({ state: "ok", payload: samplePayload() });
  });

  it("makes the gate report CRITERIA_EVIDENCE_INVALID, never a pass, for each of them", () => {
    const bad = [
      `${PAYLOAD_LINE_PREFIX_Z1}${Buffer.from("garbage").toString("base64url")}${SUFFIX}`,
      z1Line(Buffer.from("not { json")),
      z1Line(Buffer.from(jsonOfBytes(MAX_PAYLOAD_JSON_BYTES + 1))),
      z1Line(Buffer.alloc(16 * 1024 * 1024, 0x20)),
    ];
    for (const line of bad) {
      const result = gate(comment(line));
      expect(result.ok).toBe(false);
      expect(codes(result)).toContain("CRITERIA_EVIDENCE_INVALID");
      expect(codes(result)).not.toContain("CRITERIA_EVIDENCE_MISSING");
    }
  });
});

describe("a payload line with an encoding tag that this version does not know", () => {
  // A later format would add its own tag, as z1 did. This version cannot read
  // it, and the operator must see a version gap, not a corrupt comment.
  const tagged = (tag) => `${PAYLOAD_LINE_PREFIX}${tag}:${deflateRawSync(Buffer.from(JSON.stringify(samplePayload()))).toString("base64url")}${SUFFIX}`;
  const unknown = (tag) => `payload encoding ${tag} is not known to this dotbabel version; upgrade dotbabel and run the gate again`;

  it("is refused as undecodable, with a detail that names the tag and the fix", () => {
    expect(parseEvidenceComment(comment(tagged("z2")))).toEqual({ state: "undecodable", sha: SHA, payload: null, detail: unknown("z2") });
  });

  it("makes the gate report CRITERIA_EVIDENCE_INVALID with that detail, never CRITERIA_EVIDENCE_MISSING", () => {
    const result = gate(comment(tagged("z2")));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContainEqual(expect.objectContaining({ code: "CRITERIA_EVIDENCE_INVALID", detail: unknown("z2") }));
    expect(codes(result)).not.toContain("CRITERIA_EVIDENCE_MISSING");
  });

  it("reads a tag of up to 16 letters and digits, and treats longer text as a corrupt payload", () => {
    const longest = "v".repeat(15) + "9";
    expect(parseEvidenceComment(comment(tagged(longest))).detail).toBe(unknown(longest));
    expect(parseEvidenceComment(comment(tagged(`${longest}x`))).detail).toMatch(/^payload did not decode: /);
  });

  it("never reads a tag into the z1 form or into a plain payload", () => {
    const p = samplePayload();
    expect(parseEvidenceComment(renderEvidenceComment(p, {}))).toMatchObject({ state: "ok", payload: p });
    expect(parseEvidenceComment(comment(plainLine(JSON.stringify(p))))).toMatchObject({ state: "ok", payload: p });
  });
});

describe("the writer and the reader share one bound", () => {
  it("is one mebibyte", () => {
    expect(MAX_PAYLOAD_JSON_BYTES).toBe(1024 * 1024);
  });

  it("refuses to write a payload its own reader would refuse, even when it compresses under the comment cap", () => {
    const over = samplePayload({ filler: "a".repeat(MAX_PAYLOAD_JSON_BYTES) });
    expect(Buffer.byteLength(JSON.stringify(over))).toBeGreaterThan(MAX_PAYLOAD_JSON_BYTES);
    const size = Buffer.byteLength(JSON.stringify(over));
    // The refusal happens while the writer encodes, before any post, so the
    // message says so and gives the size against the limit.
    const refusal = `criteria evidence payload JSON is ${size} bytes, over the 1048576-byte limit; refused while encoding the payload line, so nothing was posted`;
    expect(() => encodeCriteriaPayloadLine(over)).toThrow(refusal);
    expect(() => renderEvidenceComment(over, {})).toThrow(refusal);
    expect(() => encodeCriteriaPayloadLine(over)).not.toThrow(/decode/);
  });

  it("writes a payload of exactly the bound, and the reader takes it back", () => {
    const base = Buffer.byteLength(JSON.stringify(samplePayload({ filler: "" })));
    const exact = samplePayload({ filler: "a".repeat(MAX_PAYLOAD_JSON_BYTES - base) });
    expect(Buffer.byteLength(JSON.stringify(exact))).toBe(MAX_PAYLOAD_JSON_BYTES);
    expect(parseEvidenceComment(renderEvidenceComment(exact, {}))).toMatchObject({ state: "ok", payload: exact });
  });

  it("counts the bound in UTF-8 bytes, not in characters", () => {
    // Each `é` is one character but two bytes: a character count would let
    // this payload through and the reader would then refuse it.
    const base = Buffer.byteLength(JSON.stringify(samplePayload({ filler: "" })));
    const chars = Math.ceil((MAX_PAYLOAD_JSON_BYTES - base) / 2) + 1;
    const wide = samplePayload({ filler: "é".repeat(chars) });
    expect(JSON.stringify(wide).length).toBeLessThan(MAX_PAYLOAD_JSON_BYTES);
    expect(() => encodeCriteriaPayloadLine(wide)).toThrow(`is ${Buffer.byteLength(JSON.stringify(wide))} bytes, over the 1048576-byte limit`);
  });
});
