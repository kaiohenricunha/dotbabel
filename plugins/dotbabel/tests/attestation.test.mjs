import { describe, it, expect } from "vitest";

import {
  ATTEST_MARKER_PREFIX,
  ATTEST_PAYLOAD_LINE_PREFIX,
  DEFAULT_GOVERNANCE_FILES,
  attestationPayloadProblem,
  buildAttestationPayload,
  hashGovernanceFiles,
  parseAttestationComment,
  passedLegs,
  renderAttestationHeader,
} from "../src/attestation.mjs";
import { decodePayloadLine, encodePayloadLine } from "../src/lib/evidence-payload.mjs";

const HEAD = "a".repeat(40);
const OLDER = "b".repeat(40);
const NOW = new Date("2026-01-01T00:00:00.000Z");

const legs = [
  { name: "test", mode: "hard", status: "pass" },
  { name: "knip", mode: "advisory", status: "advisory-fail" },
];

function payload(over = {}) {
  return buildAttestationPayload({ headSha: HEAD, legs, now: NOW, ...over });
}

describe("marker constants", () => {
  it("keeps the marker prefix byte-exact", () => {
    // `.github/workflows/test.yml` greps this string with `grep -qFx` against
    // a line it builds itself. A change here silently un-gates every
    // consumer's CI instead of failing anything.
    expect(ATTEST_MARKER_PREFIX).toBe("<!-- local-attest verified-sha=");
    expect(ATTEST_PAYLOAD_LINE_PREFIX).toBe("<!-- local-attest-payload ");
  });

  it("governs the local-attest config and the quality policy by default", () => {
    // .dotbabel.json is governed because it carries the quality thresholds:
    // without it, lowering coverage.changed_lines in a pull request would let
    // the quality leg pass under the weakened policy and still authorize.
    expect([...DEFAULT_GOVERNANCE_FILES]).toEqual([".local-attest.config.mjs", ".dotbabel.json"]);
  });
});

describe("hashGovernanceFiles", () => {
  const files = [
    { path: ".local-attest.config.mjs", bytes: "export default { matrix: [] };" },
    { path: ".dotbabel.json", bytes: '{"quality":{}}' },
  ];

  it("is deterministic and independent of input order", () => {
    expect(hashGovernanceFiles(files)).toBe(hashGovernanceFiles([...files].reverse()));
  });

  it("returns a sha256-prefixed hex digest", () => {
    expect(hashGovernanceFiles(files)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when any governed byte changes", () => {
    const tampered = [{ ...files[0], bytes: 'export default { matrix: [{ command: "true" }] };' }, files[1]];
    expect(hashGovernanceFiles(tampered)).not.toBe(hashGovernanceFiles(files));
  });

  it("distinguishes an absent file from an empty one", () => {
    const absent = [{ path: ".dotbabel.json", bytes: null }];
    const empty = [{ path: ".dotbabel.json", bytes: "" }];
    expect(hashGovernanceFiles(absent)).not.toBe(hashGovernanceFiles(empty));
  });

  it("changes when identical content moves between two governed files", () => {
    // The path is hashed alongside the bytes, so swapping two files' contents
    // is not a no-op.
    const a = [
      { path: ".dotbabel.json", bytes: "one" },
      { path: ".local-attest.config.mjs", bytes: "two" },
    ];
    const b = [
      { path: ".dotbabel.json", bytes: "two" },
      { path: ".local-attest.config.mjs", bytes: "one" },
    ];
    expect(hashGovernanceFiles(a)).not.toBe(hashGovernanceFiles(b));
  });

  it("accepts raw bytes as well as strings", () => {
    const asText = hashGovernanceFiles([{ path: "x", bytes: "abc" }]);
    const asBytes = hashGovernanceFiles([{ path: "x", bytes: Buffer.from("abc", "utf8") }]);
    expect(asBytes).toBe(asText);
  });

  it("orders three or more files identically whatever order they arrive in", () => {
    // Two entries cannot catch a comparator that always returns the same
    // answer, because the pair survives insertion order either way. The
    // producer builds this list from a config array and the gate from a JSON
    // array; if the two ever disagree on order, every attestation would read
    // as ATTESTATION_CONFIG_CHANGED.
    const files = [
      { path: "c.json", bytes: "3" },
      { path: "a.mjs", bytes: "1" },
      { path: "b.yml", bytes: "2" },
    ];
    const expected = hashGovernanceFiles(files);
    const permutations = [
      [files[1], files[2], files[0]],
      [files[2], files[0], files[1]],
      [files[0], files[2], files[1]],
      [...files].reverse(),
    ];
    for (const order of permutations) expect(hashGovernanceFiles(order)).toBe(expected);
  });

  it("does not throw on a malformed entry list", () => {
    // The list comes from configuration. A hole in it must produce a hash the
    // gate can compare and refuse, not an exception that reads as a tool bug.
    expect(hashGovernanceFiles([null, undefined])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashGovernanceFiles([{}])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashGovernanceFiles(null)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashGovernanceFiles("nonsense")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("hashes an entry with no path differently from one with an empty path", () => {
    expect(hashGovernanceFiles([{ bytes: "x" }])).toBe(hashGovernanceFiles([{ path: "", bytes: "x" }]));
    expect(hashGovernanceFiles([{ path: "a", bytes: "x" }])).not.toBe(hashGovernanceFiles([{ path: "", bytes: "x" }]));
  });

  it("treats undefined bytes exactly like an absent file", () => {
    expect(hashGovernanceFiles([{ path: "a" }])).toBe(hashGovernanceFiles([{ path: "a", bytes: null }]));
  });

  it("separates the fields, so concatenation cannot collide", () => {
    // Without a separator between path and bytes, {path:"ab",bytes:"c"} and
    // {path:"a",bytes:"bc"} would hash the same.
    expect(hashGovernanceFiles([{ path: "ab", bytes: "c" }])).not.toBe(
      hashGovernanceFiles([{ path: "a", bytes: "bc" }]),
    );
  });

  it("frames fields unambiguously, so a path cannot borrow bytes from content", () => {
    // Separator-joined framing made path "a b" + content "c" digest the same
    // as path "a" + content "b c". This digest is the only thing preventing a
    // pull request from authorizing its own weakened check, so the framing is
    // length-prefixed rather than delimited.
    expect(hashGovernanceFiles([{ path: "a b", bytes: "c" }])).not.toBe(
      hashGovernanceFiles([{ path: "a", bytes: "b c" }]),
    );
  });

  it("cannot have a file impersonate the absent marker through its contents", () => {
    // The presence tag is out of band, so no byte sequence a file can contain
    // collides with "this file does not exist".
    const sentinel = String.fromCharCode(0) + "absent";
    expect(hashGovernanceFiles([{ path: "x", bytes: null }])).not.toBe(
      hashGovernanceFiles([{ path: "x", bytes: sentinel }]),
    );
  });

  it("hashes the empty list to a stable value distinct from any single file", () => {
    expect(hashGovernanceFiles([])).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashGovernanceFiles([])).not.toBe(hashGovernanceFiles([{ path: "a", bytes: "" }]));
  });
});

describe("buildAttestationPayload", () => {
  it("derives a passing verdict when every hard leg passed", () => {
    // An advisory failure does not block, matching the gate semantics the
    // matrix mirrors.
    expect(payload().verdict).toBe("pass");
  });

  it("derives a failing verdict from a failed hard leg", () => {
    const p = payload({ legs: [{ name: "test", mode: "hard", status: "fail" }] });
    expect(p.verdict).toBe("fail");
  });

  it("treats a diff-skipped hard leg as non-failing", () => {
    const p = payload({ legs: [{ name: "test", mode: "hard", status: "skipped" }] });
    expect(p.verdict).toBe("pass");
  });

  it("treats a not-run hard leg as failing", () => {
    // fail-fast stopped before this leg launched. Reporting the run as a pass
    // would vouch for a check that never executed.
    const p = payload({ legs: [{ name: "bats", mode: "hard", status: "not-run" }] });
    expect(p.verdict).toBe("fail");
  });

  it("omits the optional fields rather than writing nulls", () => {
    const p = payload();
    expect(p).not.toHaveProperty("merge_base");
    expect(p).not.toHaveProperty("config_hash");
    expect(p).not.toHaveProperty("toolchain");
  });

  it("records the merge base, config hash and toolchain when given", () => {
    const p = payload({ mergeBase: OLDER, configHash: `sha256:${"c".repeat(64)}`, toolchain: { node: "22.22.2" } });
    expect(p.merge_base).toBe(OLDER);
    expect(p.config_hash).toBe(`sha256:${"c".repeat(64)}`);
    expect(p.toolchain).toEqual({ node: "22.22.2" });
  });

  it("carries only name, mode and status per leg", () => {
    const p = payload({ legs: [{ name: "test", mode: "hard", status: "pass", durationS: 9, tail: "secret" }] });
    expect(p.legs).toEqual([{ name: "test", mode: "hard", status: "pass" }]);
  });

  it("survives a missing or malformed leg list", () => {
    expect(payload({ legs: undefined }).legs).toEqual([]);
    expect(payload({ legs: "nope" }).legs).toEqual([]);
    // No legs means nothing failed, but requiredLegs then finds nothing
    // passing either — the gate blocks on ATTESTATION_INCOMPLETE, not here.
    expect(payload({ legs: [] }).verdict).toBe("pass");
  });

  it("names the tool, and omits the version when there is none", () => {
    expect(payload().tool).toEqual({ name: "dotbabel" });
    expect(payload({ toolVersion: "4.0.0" }).tool).toEqual({ name: "dotbabel", version: "4.0.0" });
  });

  it("omits an empty toolchain rather than recording an empty object", () => {
    expect(payload({ toolchain: {} })).not.toHaveProperty("toolchain");
    expect(payload({ toolchain: null })).not.toHaveProperty("toolchain");
  });

  it("stamps generated_at from the clock it is given", () => {
    expect(payload().generated_at).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("renderAttestationHeader / parseAttestationComment", () => {
  it("round-trips a payload through a comment body", () => {
    const p = payload({ mergeBase: OLDER });
    const body = `${renderAttestationHeader(p)}\n## Local Attestation`;
    const parsed = parseAttestationComment(body);
    expect(parsed.state).toBe("ok");
    expect(parsed.sha).toBe(HEAD);
    expect(parsed.payload).toEqual(p);
  });

  it("puts the marker on line 1 and the payload on line 2", () => {
    const lines = renderAttestationHeader(payload()).split("\n");
    expect(lines[0].startsWith(ATTEST_MARKER_PREFIX)).toBe(true);
    expect(lines[1].startsWith(ATTEST_PAYLOAD_LINE_PREFIX)).toBe(true);
  });

  it("reports not-attestation for an ordinary comment", () => {
    expect(parseAttestationComment("hello").state).toBe("not-attestation");
  });

  it("reports not-attestation when the marker is quoted further down", () => {
    // A marker inside a quotation is a quotation, not an attestation.
    const body = `some prose\n${renderAttestationHeader(payload())}`;
    expect(parseAttestationComment(body).state).toBe("not-attestation");
  });

  it("reports no-payload for a marker written before payloads existed", () => {
    const body = `${ATTEST_MARKER_PREFIX}${HEAD} -->\n## Local Attestation`;
    const parsed = parseAttestationComment(body);
    expect(parsed.state).toBe("no-payload");
    expect(parsed.sha).toBe(HEAD);
  });

  it("reports undecodable for a corrupt payload line", () => {
    const body = `${ATTEST_MARKER_PREFIX}${HEAD} -->\n${ATTEST_PAYLOAD_LINE_PREFIX}!!!not-base64!!! -->`;
    expect(parseAttestationComment(body).state).toBe("undecodable");
  });

  it("reports sha-mismatch when the payload names another commit than the marker", () => {
    const body = `${ATTEST_MARKER_PREFIX}${HEAD} -->\n${encodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, payload({ headSha: OLDER }))}`;
    const parsed = parseAttestationComment(body);
    expect(parsed.state).toBe("sha-mismatch");
    expect(parsed.detail).toContain(OLDER);
  });

  it("refuses to build a marker from a value that is not a SHA", () => {
    expect(() => renderAttestationHeader({ head_sha: "nope" })).toThrow(/invalid sha/);
  });
});

describe("attestationPayloadProblem", () => {
  const ok = payload({ mergeBase: OLDER });

  it("accepts a well-formed payload", () => {
    expect(attestationPayloadProblem(ok)).toBeNull();
  });

  it.each([
    ["a non-object", "nope", /not an object/],
    ["an array", [], /not an object/],
    ["null", null, /not an object/],
  ])("rejects %s", (_label, value, pattern) => {
    expect(attestationPayloadProblem(value)).toMatch(pattern);
  });

  it("rejects an unsupported schema version", () => {
    expect(attestationPayloadProblem({ ...ok, schema_version: 2 })).toMatch(/schema_version/);
  });

  it("rejects an abbreviated head_sha", () => {
    // The gate compares against a 40-character oid from gh; accepting a short
    // sha here would let an abbreviated marker match more than one commit.
    expect(attestationPayloadProblem({ ...ok, head_sha: "a".repeat(7) })).toMatch(/head_sha/);
  });

  it("rejects a missing verdict", () => {
    const { verdict, ...rest } = ok;
    expect(attestationPayloadProblem(rest)).toMatch(/verdict/);
  });

  it("rejects legs that are not an array", () => {
    expect(attestationPayloadProblem({ ...ok, legs: "test" })).toMatch(/legs/);
  });

  it("rejects a leg with no name or no status", () => {
    expect(attestationPayloadProblem({ ...ok, legs: [{ mode: "hard", status: "pass" }] })).toMatch(/no name/);
    expect(attestationPayloadProblem({ ...ok, legs: [{ name: "test", mode: "hard" }] })).toMatch(/no status/);
  });

  it("rejects an empty leg name or status, not merely a missing one", () => {
    expect(attestationPayloadProblem({ ...ok, legs: [{ name: "", status: "pass" }] })).toMatch(/no name/);
    expect(attestationPayloadProblem({ ...ok, legs: [{ name: "test", status: "" }] })).toMatch(/no status/);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "test"],
  ])("rejects %s as a leg entry", (_label, leg) => {
    expect(attestationPayloadProblem({ ...ok, legs: [leg] })).toMatch(/not an object/);
  });

  it("names the offending leg in the status message", () => {
    expect(attestationPayloadProblem({ ...ok, legs: [{ name: "bats" }] })).toBe("leg bats has no status");
  });

  it("anchors the head_sha pattern at both ends", () => {
    // Unanchored, a 41-character value or one with a prefix would pass here and
    // then never equal the 40-character oid the gate compares it against —
    // evidence that silently matches nothing.
    expect(attestationPayloadProblem({ ...ok, head_sha: `${"a".repeat(40)}b` })).toMatch(/head_sha/);
    expect(attestationPayloadProblem({ ...ok, head_sha: `x${"a".repeat(40)}` })).toMatch(/head_sha/);
    expect(attestationPayloadProblem({ ...ok, head_sha: "A".repeat(40) })).toBeNull();
  });

  it("accepts a payload with an empty leg list", () => {
    expect(attestationPayloadProblem({ ...ok, legs: [] })).toBeNull();
  });
});

describe("passedLegs", () => {
  it("returns only the legs that actually passed", () => {
    const p = payload({
      legs: [
        { name: "test", mode: "hard", status: "pass" },
        { name: "bats", mode: "hard", status: "skipped" },
        { name: "knip", mode: "advisory", status: "advisory-fail" },
        { name: "dogfood", mode: "hard", status: "not-run" },
      ],
    });
    expect([...passedLegs(p)]).toEqual(["test"]);
  });

  it("returns an empty set for a payload with no legs", () => {
    expect(passedLegs({}).size).toBe(0);
    expect(passedLegs(null).size).toBe(0);
    expect(passedLegs({ legs: null }).size).toBe(0);
  });

  it("ignores a leg entry that is not an object or has no name", () => {
    expect(passedLegs({ legs: [null, { status: "pass" }, { name: 7, status: "pass" }] }).size).toBe(0);
  });
});

describe("evidence-payload codec", () => {
  it("survives characters that Markdown would otherwise mangle", () => {
    const value = { note: "a|b `code` <tag> \n newline", schema_version: 1 };
    const line = encodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, value);
    expect(line).not.toContain("\n");
    expect(decodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, `line one\n${line}`).payload).toEqual(value);
  });

  it("separates an absent payload line from an undecodable one", () => {
    expect(decodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, "one\ntwo").state).toBe("absent");
    expect(decodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, `one\n${ATTEST_PAYLOAD_LINE_PREFIX}@@ -->`).state).toBe(
      "undecodable",
    );
  });

  it("rejects a payload that decodes to something other than an object", () => {
    const line = encodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, [1, 2, 3]);
    expect(decodePayloadLine(ATTEST_PAYLOAD_LINE_PREFIX, `one\n${line}`).state).toBe("undecodable");
  });

  const P = ATTEST_PAYLOAD_LINE_PREFIX;
  const body = (line, lead = "marker line") => `${lead}\n${line}`;

  it("treats a body that is not a string as absent, never as a crash", () => {
    // The gate hands this whatever GitHub returned. A null or a number must
    // produce a verdict, not a TypeError that reads as a tool bug.
    for (const value of [null, undefined, 42, {}, []]) {
      const r = decodePayloadLine(P, value);
      expect(r.state).toBe("absent");
      expect(r.payload).toBeNull();
      expect(r.detail).toBe("body is not a string");
    }
  });

  it("names the line it looked at, counting from 1", () => {
    expect(decodePayloadLine(P, body("not a payload")).detail).toBe("line 2 is not the payload comment");
    expect(decodePayloadLine(P, "a\nb\nc", 2).detail).toBe("line 3 is not the payload comment");
  });

  it("requires both the prefix and the closing marker", () => {
    // Either half alone is not a payload line. A body carrying the prefix but
    // no ` -->` is truncated, and slicing it would decode garbage.
    const encoded = Buffer.from(JSON.stringify({ a: 1 })).toString("base64url");
    expect(decodePayloadLine(P, body(`${P}${encoded}`)).state).toBe("absent");
    expect(decodePayloadLine(P, body(`${encoded} -->`)).state).toBe("absent");
    expect(decodePayloadLine(P, body(`${P}${encoded} -->`)).state).toBe("ok");
  });

  it("reads the payload from the requested line, not merely any line", () => {
    const line = encodePayloadLine(P, { a: 1 });
    expect(decodePayloadLine(P, `one\ntwo\n${line}`).state).toBe("absent");
    expect(decodePayloadLine(P, `one\ntwo\n${line}`, 2).payload).toEqual({ a: 1 });
  });

  it("tolerates whitespace around the encoded payload", () => {
    const encoded = Buffer.from(JSON.stringify({ a: 1 })).toString("base64url");
    expect(decodePayloadLine(P, body(`${P}  ${encoded}   -->`)).payload).toEqual({ a: 1 });
  });

  it("explains an undecodable payload rather than reporting it as absent", () => {
    // Absent means "no payload here", which a later comment could satisfy.
    // Undecodable means the line claims to be one and is not, and the two must
    // never collapse into each other.
    const notJson = Buffer.from("{ not json", "utf8").toString("base64url");
    const r = decodePayloadLine(P, body(`${P}${notJson} -->`));
    expect(r.state).toBe("undecodable");
    expect(r.payload).toBeNull();
    expect(r.detail).toMatch(/^payload did not decode: /);
  });

  it.each([
    ["a JSON array", [1, 2]],
    ["a bare string", "hello"],
    ["a number", 7],
    ["null", null],
  ])("rejects %s as a payload with a stated reason", (_label, value) => {
    const line = encodePayloadLine(P, value);
    const r = decodePayloadLine(P, body(line));
    expect(r.state).toBe("undecodable");
    expect(r.detail).toBe("payload is not an object");
  });

  it("round-trips through the exact prefix it was given", () => {
    // Producer and judge share this codec precisely so the two cannot drift
    // into writing one prefix and reading another.
    const other = "<!-- dotbabel-criteria-payload ";
    const line = encodePayloadLine(other, { a: 1 });
    expect(decodePayloadLine(other, body(line)).payload).toEqual({ a: 1 });
    expect(decodePayloadLine(P, body(line)).state).toBe("absent");
  });
});
