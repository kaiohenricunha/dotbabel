import { describe, it, expect } from "vitest";

import {
  ATTEST_MARKER_PREFIX,
  buildAttestMarker,
  buildAuditEntry,
  buildGateSnippet,
  findAttestComment,
  isAttested,
  parseArgs,
  renderComment,
  summarizeResults,
  tail,
} from "../src/local-attest-lib.mjs";

describe("buildAttestMarker", () => {
  it("accepts a full 40-char SHA", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(buildAttestMarker(sha)).toBe(`${ATTEST_MARKER_PREFIX}${sha} -->`);
  });

  it("accepts a short SHA (7+ chars)", () => {
    expect(buildAttestMarker("0123456")).toBe(`${ATTEST_MARKER_PREFIX}0123456 -->`);
  });

  it("accepts uppercase hex", () => {
    expect(buildAttestMarker("ABCDEF0")).toContain("ABCDEF0");
  });

  it("rejects empty string", () => {
    expect(() => buildAttestMarker("")).toThrow(/invalid sha/);
  });

  it("rejects non-hex characters", () => {
    expect(() => buildAttestMarker("zxywvut")).toThrow(/invalid sha/);
  });

  it("rejects too-short input (<7 chars)", () => {
    expect(() => buildAttestMarker("abc123")).toThrow(/invalid sha/);
  });

  it("rejects non-string input", () => {
    expect(() => buildAttestMarker(/** @type {any} */ (null))).toThrow(/invalid sha/);
    expect(() => buildAttestMarker(/** @type {any} */ (42))).toThrow(/invalid sha/);
  });
});

describe("isAttested", () => {
  const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const marker = `${ATTEST_MARKER_PREFIX}${SHA} -->`;

  it("returns true for an OWNER comment matching the SHA", () => {
    const comments = [
      { author_association: "OWNER", body: `${marker}\nbody text here` },
    ];
    expect(isAttested(comments, SHA)).toBe(true);
  });

  it("returns false for a stale SHA", () => {
    const staleMarker = `${ATTEST_MARKER_PREFIX}aaaaaaa -->`;
    const comments = [{ author_association: "OWNER", body: staleMarker }];
    expect(isAttested(comments, SHA)).toBe(false);
  });

  it("rejects non-OWNER authors by default", () => {
    const comments = [{ author_association: "CONTRIBUTOR", body: marker }];
    expect(isAttested(comments, SHA)).toBe(false);
  });

  it("accepts MEMBER when trust list widened", () => {
    const comments = [{ author_association: "MEMBER", body: marker }];
    expect(isAttested(comments, SHA, { trustedAssociations: ["OWNER", "MEMBER"] })).toBe(true);
  });

  it("returns false when marker missing", () => {
    const comments = [{ author_association: "OWNER", body: "just a normal comment" }];
    expect(isAttested(comments, SHA)).toBe(false);
  });

  it("returns false when marker is malformed (e.g. on line 2 only)", () => {
    const comments = [{ author_association: "OWNER", body: `> quoted reply\n${marker}` }];
    expect(isAttested(comments, SHA)).toBe(false);
  });

  it("returns false on non-array input", () => {
    expect(isAttested(/** @type {any} */ (null), SHA)).toBe(false);
    expect(isAttested(/** @type {any} */ ("[]"), SHA)).toBe(false);
  });

  it("returns false on empty headSha", () => {
    expect(isAttested([], "")).toBe(false);
  });

  it("finds a matching comment among several non-matching ones", () => {
    const comments = [
      { author_association: "CONTRIBUTOR", body: marker },
      { author_association: "OWNER", body: "just chat" },
      { author_association: "OWNER", body: `${marker}\nokay attestation` },
    ];
    expect(isAttested(comments, SHA)).toBe(true);
  });
});

describe("findAttestComment", () => {
  it("returns the first comment whose body contains the marker prefix", () => {
    const target = { author_association: "OWNER", body: `${ATTEST_MARKER_PREFIX}abc1234 -->` };
    expect(findAttestComment([{ body: "noise" }, target, { body: "more" }])).toBe(target);
  });

  it("returns null when no comment carries the prefix", () => {
    expect(findAttestComment([{ body: "x" }, { body: "y" }])).toBe(null);
  });

  it("returns null on non-array input", () => {
    expect(findAttestComment(/** @type {any} */ (null))).toBe(null);
  });
});

describe("parseArgs", () => {
  it("returns defaults when argv is empty", () => {
    expect(parseArgs([])).toEqual({
      pr: null,
      push: true,
      dryRun: false,
      config: null,
      help: false,
    });
  });

  it("parses --pr <N>", () => {
    expect(parseArgs(["--pr", "123"]).pr).toBe("123");
  });

  it("toggles --no-push", () => {
    expect(parseArgs(["--no-push"]).push).toBe(false);
  });

  it("toggles --dry-run", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
  });

  it("captures --config <path>", () => {
    expect(parseArgs(["--config", "/tmp/cfg.mjs"]).config).toBe("/tmp/cfg.mjs");
  });

  it("sets help on --help / -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects non-numeric --pr", () => {
    const die = (code, msg) => ({ code, msg });
    expect(parseArgs(["--pr", "abc"], die)).toEqual({ code: 64, msg: expect.stringContaining("--pr") });
  });

  it("rejects unknown flags", () => {
    const die = (code, msg) => ({ code, msg });
    expect(parseArgs(["--bogus"], die)).toEqual({ code: 64, msg: expect.stringContaining("unknown") });
  });

  it("rejects --config with no value", () => {
    const die = (code, msg) => ({ code, msg });
    expect(parseArgs(["--config"], die)).toEqual({ code: 64, msg: expect.stringContaining("--config") });
  });
});

describe("tail", () => {
  it("returns empty string for empty input", () => {
    expect(tail("")).toBe("");
  });

  it("returns all lines when fewer than n", () => {
    expect(tail("a\nb", 5)).toBe("a\nb");
  });

  it("returns exactly the last n lines when more available", () => {
    const input = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join("\n");
    expect(tail(input, 3)).toBe("L18\nL19\nL20");
  });

  it("strips trailing whitespace before splitting", () => {
    expect(tail("a\nb\n\n  \n", 5)).toBe("a\nb");
  });
});

describe("renderComment", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const results = [
    { name: "lint", mode: "hard", passed: true, durationS: 3, tail: "" },
    { name: "test", mode: "hard", passed: true, durationS: 12, tail: "" },
    { name: "knip", mode: "advisory", passed: false, durationS: 1, tail: "noise" },
  ];

  it("places the marker on line 1 (CI-gate invariant)", () => {
    const body = renderComment(results, {
      headSha: SHA,
      hostname: "host",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(body.split("\n")[0]).toBe(buildAttestMarker(SHA));
  });

  it("includes one row per leg with mode + status", () => {
    const body = renderComment(results, {
      headSha: SHA,
      hostname: "host",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(body).toContain("| lint | hard | pass | 3s |");
    expect(body).toContain("| test | hard | pass | 12s |");
    expect(body).toContain("| knip | advisory | fail (advisory) | 1s |");
  });

  it("uses 'FAIL' (uppercase) for hard failures", () => {
    const failed = [{ name: "lint", mode: "hard", passed: false, durationS: 4, tail: "" }];
    const body = renderComment(failed, {
      headSha: SHA,
      hostname: "h",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(body).toContain("| lint | hard | FAIL | 4s |");
  });

  it("includes host, timestamp, and SHA footer", () => {
    const body = renderComment(results, {
      headSha: SHA,
      hostname: "ci-laptop",
      now: new Date("2026-01-01T12:34:56Z"),
    });
    expect(body).toContain("- Host: `ci-laptop`");
    expect(body).toContain("- Attested at: `2026-01-01T12:34:56.000Z`");
    expect(body).toContain(`- Verified SHA: \`${SHA}\``);
  });
});

describe("buildAuditEntry", () => {
  it("produces the documented .local-attest-log.jsonl shape", () => {
    const e = buildAuditEntry({
      pr: "123",
      sha: "abc1234",
      hostname: "host",
      advisoryFails: ["knip"],
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(e).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      pr: 123,
      sha: "abc1234",
      host: "host",
      advisoryFails: ["knip"],
    });
  });

  it("copies the advisoryFails array (no shared reference)", () => {
    const src = ["a"];
    const e = buildAuditEntry({
      pr: 1,
      sha: "abc1234",
      hostname: "h",
      advisoryFails: src,
      now: new Date(),
    });
    src.push("b");
    expect(e.advisoryFails).toEqual(["a"]);
  });
});

describe("summarizeResults", () => {
  it("partitions hard fails, advisory fails, and totals durations", () => {
    const results = [
      { name: "a", mode: "hard", passed: true, durationS: 1, tail: "" },
      { name: "b", mode: "hard", passed: false, durationS: 2, tail: "" },
      { name: "c", mode: "advisory", passed: false, durationS: 3, tail: "" },
      { name: "d", mode: "advisory", passed: true, durationS: 4, tail: "" },
    ];
    const s = summarizeResults(results);
    expect(s.hardFails.map((r) => r.name)).toEqual(["b"]);
    expect(s.advisoryFails.map((r) => r.name)).toEqual(["c"]);
    expect(s.totalDurationS).toBe(10);
  });
});

describe("buildGateSnippet", () => {
  it("emits a single OWNER select for the default trust list", () => {
    const snippet = buildGateSnippet();
    expect(snippet).toContain('select(.author_association == "OWNER")');
    expect(snippet).toContain("MARKER=");
  });

  it("emits a multi-trust select for widened trust", () => {
    const snippet = buildGateSnippet({ trustedAssociations: ["OWNER", "MEMBER"] });
    expect(snippet).toContain(
      'select(.author_association == "OWNER" or .author_association == "MEMBER")',
    );
  });

  it("rejects empty or non-array trustedAssociations", () => {
    expect(() => buildGateSnippet({ trustedAssociations: [] })).toThrow(/non-empty array/);
    expect(() =>
      buildGateSnippet({ trustedAssociations: /** @type {any} */ ("OWNER") }),
    ).toThrow(/non-empty array/);
  });
});
