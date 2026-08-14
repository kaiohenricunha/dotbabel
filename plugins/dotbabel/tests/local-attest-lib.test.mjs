import { describe, it, expect } from "vitest";

import {
  ATTEST_MARKER_PREFIX,
  buildAttestMarker,
  buildAuditEntry,
  buildGateSnippet,
  filterMatrix,
  findAttestComment,
  goMajorMinorFromGoMod,
  goMajorMinorFromVersion,
  isAttested,
  globToRegExp,
  legStatus,
  markSkips,
  nodeMajorFromPin,
  nodeMajorOf,
  parseArgs,
  renderComment,
  shouldAttest,
  summarizeResults,
  tail,
  toolchainProblems,
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
    const comments = [{ author_association: "OWNER", body: `${marker}\nbody text here` }];
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
      only: [],
      from: null,
      failFast: false,
      init: false,
      force: false,
    });
  });

  it("parses --init and --force; both default off so a bare run never scaffolds", () => {
    expect(parseArgs(["--init"]).init).toBe(true);
    expect(parseArgs(["--init", "--force"]).force).toBe(true);
    expect(parseArgs(["--dry-run"]).init).toBe(false);
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
    expect(parseArgs(["--pr", "abc"], die)).toEqual({
      code: 64,
      msg: expect.stringContaining("--pr"),
    });
  });

  it("rejects unknown flags", () => {
    const die = (code, msg) => ({ code, msg });
    expect(parseArgs(["--bogus"], die)).toEqual({
      code: 64,
      msg: expect.stringContaining("unknown"),
    });
  });

  it("rejects --config with no value", () => {
    const die = (code, msg) => ({ code, msg });
    expect(parseArgs(["--config"], die)).toEqual({
      code: 64,
      msg: expect.stringContaining("--config"),
    });
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
  const RESULTS = [
    { name: "lint", mode: "hard", passed: true, durationS: 3, tail: "" },
    { name: "test", mode: "hard", passed: false, durationS: 7, tail: "boom" },
    { name: "knip", mode: "advisory", passed: false, durationS: 2, tail: "" },
    { name: "bats", mode: "hard", passed: false, notRun: true, durationS: 0, tail: "" },
  ];

  it("keeps every legacy field byte-compatible (pre-change lines imply attested)", () => {
    const e = buildAuditEntry({
      result: "attested",
      pr: "123",
      sha: "abc1234",
      hostname: "host",
      advisoryFails: ["knip"],
      results: RESULTS,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(e).toMatchObject({
      ts: "2026-01-01T00:00:00.000Z",
      pr: 123,
      sha: "abc1234",
      host: "host",
      advisoryFails: ["knip"],
    });
  });

  it("records the run outcome and per-leg statuses", () => {
    const e = buildAuditEntry({
      result: "hard-fail",
      pr: 9,
      sha: "abc1234",
      hostname: "h",
      advisoryFails: ["knip"],
      results: RESULTS,
      now: new Date(),
    });
    expect(e.result).toBe("hard-fail");
    expect(e.legs).toEqual([
      { name: "lint", mode: "hard", status: "pass", durationS: 3 },
      { name: "test", mode: "hard", status: "fail", durationS: 7 },
      { name: "knip", mode: "advisory", status: "advisory-fail", durationS: 2 },
      { name: "bats", mode: "hard", status: "not-run", durationS: 0 },
    ]);
  });

  it("records flags and diagnostic dirtiness; a missing pr stays null, not 0", () => {
    const e = buildAuditEntry({
      result: "diagnostic",
      pr: null,
      sha: null,
      hostname: "h",
      advisoryFails: [],
      results: RESULTS.slice(0, 1),
      flags: { only: ["lint"], from: null, failFast: false, push: false },
      dirty: true,
      now: new Date(),
    });
    expect(e.pr).toBeNull();
    expect(e.sha).toBeNull();
    expect(e.dirty).toBe(true);
    expect(e.flags).toEqual({
      only: ["lint"],
      from: null,
      failFast: false,
      push: false,
      dryRun: false,
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

  it("does not count not-run legs as failures — they were never executed", () => {
    const results = [
      { name: "a", mode: "hard", passed: false, durationS: 2, tail: "" },
      { name: "b", mode: "hard", passed: false, notRun: true, durationS: 0, tail: "" },
      { name: "c", mode: "advisory", passed: false, notRun: true, durationS: 0, tail: "" },
    ];
    const s = summarizeResults(results);
    expect(s.hardFails.map((r) => r.name)).toEqual(["a"]);
    expect(s.advisoryFails).toEqual([]);
  });
});

describe("legStatus", () => {
  it("classifies every terminal state, one source of truth for renderer and audit", () => {
    expect(legStatus({ mode: "hard", passed: true })).toBe("pass");
    expect(legStatus({ mode: "hard", passed: false })).toBe("fail");
    expect(legStatus({ mode: "advisory", passed: false })).toBe("advisory-fail");
    expect(legStatus({ mode: "hard", passed: false, notRun: true })).toBe("not-run");
    expect(legStatus({ mode: "hard", passed: true, skipped: true })).toBe("skipped");
    expect(legStatus(undefined)).toBe("not-run");
  });
});

describe("globToRegExp", () => {
  it("matches ** across separators, * and ? within one segment", () => {
    expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("**/*.md")).toBeTruthy();
    expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("src/Bolao*.jsx").test("src/BolaoList.jsx")).toBe(true);
    expect(globToRegExp("src/Bolao*.jsx").test("src/Bolao/List.jsx")).toBe(false);
    expect(globToRegExp("api/**").test("api2/x.go")).toBe(false);
    expect(globToRegExp("package.json").test("package.json")).toBe(true);
    expect(globToRegExp("package.json").test("sub/package.json")).toBe(false);
  });
});

describe("markSkips", () => {
  const MATRIX = [
    { name: "always", mode: "hard", command: "a" },
    { name: "gated", mode: "hard", command: "b", when: { changedPaths: ["api/**", "pkg.json"] } },
    { name: "diffy", mode: "hard", command: "c", skipWhenDiffOnly: ["docs/**", "**/*.md"] },
  ];

  it("fail-open: a null or empty changed-files list runs everything", () => {
    for (const files of [null, undefined, []]) {
      const out = markSkips(MATRIX, files);
      expect(out.map((l) => l.skipped === true)).toEqual([false, false, false]);
    }
  });

  it("when: the leg skips when no changed file matches, runs when one does", () => {
    expect(markSkips(MATRIX, ["src/app.js"])[1].skipped).toBe(true);
    expect(markSkips(MATRIX, ["api/main.go"])[1].skipped).toBe(false);
    expect(markSkips(MATRIX, ["pkg.json"])[1].skipped).toBe(false);
  });

  it("skipWhenDiffOnly: skips only when EVERY changed file matches the globs", () => {
    expect(markSkips(MATRIX, ["docs/a.md", "README.md"])[2].skipped).toBe(true);
    expect(markSkips(MATRIX, ["docs/a.md", "src/app.js"])[2].skipped).toBe(false);
  });

  it("never removes a leg and does not mutate the input matrix", () => {
    const out = markSkips(MATRIX, ["docs/a.md"]);
    expect(out).toHaveLength(3);
    expect(MATRIX[1].skipped).toBeUndefined();
  });
});

describe("shouldAttest with skipped legs", () => {
  it("refuses an all-skipped run — zero legs executed verifies nothing", () => {
    const results = [
      { name: "a", mode: "hard", passed: true, skipped: true, durationS: 0, tail: "" },
      { name: "b", mode: "hard", passed: true, skipped: true, durationS: 0, tail: "" },
    ];
    expect(shouldAttest({ diagnostic: false, results, expectedLegs: 2 })).toBe(false);
  });

  it("a record flagged both skipped and notRun is rejected — notRun wins", () => {
    const results = [
      { name: "a", mode: "hard", passed: true, durationS: 1, tail: "" },
      {
        name: "b",
        mode: "hard",
        passed: false,
        skipped: true,
        notRun: true,
        durationS: 0,
        tail: "",
      },
    ];
    expect(shouldAttest({ diagnostic: false, results, expectedLegs: 2 })).toBe(false);
    expect(legStatus(results[1])).toBe("not-run");
  });

  it("skipped legs are attestable — CI skips the same jobs", () => {
    const results = [
      { name: "a", mode: "hard", passed: true, durationS: 1, tail: "" },
      { name: "b", mode: "hard", passed: true, skipped: true, durationS: 0, tail: "" },
    ];
    expect(shouldAttest({ diagnostic: false, results, expectedLegs: 2 })).toBe(true);
  });
});

describe("renderComment skipped honesty", () => {
  const SHA = "abc1234abc1234abc1234abc1234abc1234abc12";

  it("a skipped leg renders as skipped with no duration, and the headline says so", () => {
    const results = [
      { name: "lint", mode: "hard", passed: true, durationS: 2, tail: "" },
      { name: "e2e", mode: "hard", passed: true, skipped: true, durationS: 0, tail: "" },
    ];
    const body = renderComment(results, { headSha: SHA, hostname: "h", now: new Date() });
    expect(body).toContain(
      "| e2e | hard | skipped (diff-scoped) | \u2014 |".replace("\\u2014", "\u2014"),
    );
    expect(body).toContain("1 leg(s) were skipped for this diff");
    expect(body).not.toContain("The full CI check matrix ran");
  });

  it("no skips keeps the full-matrix headline", () => {
    const results = [{ name: "lint", mode: "hard", passed: true, durationS: 2, tail: "" }];
    const body = renderComment(results, { headSha: SHA, hostname: "h", now: new Date() });
    expect(body).toContain("The full CI check matrix ran locally");
  });
});

describe("parseArgs diagnostic flags", () => {
  it("defaults include only/from/failFast", () => {
    const a = parseArgs([]);
    expect(a.only).toEqual([]);
    expect(a.from).toBeNull();
    expect(a.failFast).toBe(false);
  });

  it("accumulates repeatable --only", () => {
    const a = parseArgs(["--only", "lint", "--only", "test"]);
    expect(a.only).toEqual(["lint", "test"]);
  });

  it("captures --from once and rejects a repeat", () => {
    expect(parseArgs(["--from", "test"]).from).toBe("test");
    expect(() => parseArgs(["--from", "a", "--from", "b"])).toThrow(/--from given more than once/);
  });

  it("rejects --only together with --from", () => {
    expect(() => parseArgs(["--only", "lint", "--from", "test"])).toThrow(/mutually exclusive/);
  });

  it("rejects --only and --from with no value", () => {
    expect(() => parseArgs(["--only"])).toThrow(/requires a leg name/);
    expect(() => parseArgs(["--from"])).toThrow(/requires a leg name/);
  });

  it("toggles --fail-fast", () => {
    expect(parseArgs(["--fail-fast"]).failFast).toBe(true);
  });
});

describe("filterMatrix", () => {
  const MATRIX = [
    { name: "npm ci", mode: "hard", command: "npm ci" },
    { name: "lint, strict", mode: "hard", command: "x" },
    { name: "test", mode: "hard", command: "y" },
    { name: "bats", mode: "hard", command: "z" },
  ];

  it("returns the matrix untouched with no filters", () => {
    expect(filterMatrix(MATRIX, {})).toEqual(MATRIX);
  });

  it("--only selects by exact name, preserving matrix order", () => {
    const out = filterMatrix(MATRIX, { only: ["bats", "npm ci"] });
    expect(out.map((l) => l.name)).toEqual(["npm ci", "bats"]);
  });

  it("splits comma-separated --only values", () => {
    const out = filterMatrix(MATRIX, { only: ["test,bats"] });
    expect(out.map((l) => l.name)).toEqual(["test", "bats"]);
  });

  it("never splits a token that is itself a leg name containing a comma", () => {
    const out = filterMatrix(MATRIX, { only: ["lint, strict"] });
    expect(out.map((l) => l.name)).toEqual(["lint, strict"]);
  });

  it("--from selects the suffix from the named leg's index", () => {
    const out = filterMatrix(MATRIX, { from: "test" });
    expect(out.map((l) => l.name)).toEqual(["test", "bats"]);
  });

  it("unknown names fail with every valid name listed; matching is case-sensitive", () => {
    expect(() => filterMatrix(MATRIX, { only: ["nope"] })).toThrow(/npm ci.*test.*bats/s);
    expect(() => filterMatrix(MATRIX, { only: ["Test"] })).toThrow(/unknown leg/);
    expect(() => filterMatrix(MATRIX, { from: "nope" })).toThrow(/unknown leg/);
  });
});

describe("shouldAttest", () => {
  const pass = (name, mode = "hard") => ({ name, mode, passed: true, durationS: 1, tail: "" });

  it("attests a full clean run, advisory failures included", () => {
    const results = [
      pass("a"),
      { name: "k", mode: "advisory", passed: false, durationS: 1, tail: "" },
    ];
    expect(shouldAttest({ diagnostic: false, results })).toBe(true);
  });

  it("never attests a diagnostic run, even all-green", () => {
    expect(shouldAttest({ diagnostic: true, results: [pass("a")] })).toBe(false);
  });

  it("never attests when any leg was not run", () => {
    const results = [
      pass("a"),
      { name: "b", mode: "hard", passed: false, notRun: true, durationS: 0, tail: "" },
    ];
    expect(shouldAttest({ diagnostic: false, results })).toBe(false);
  });

  it("rejects a subset record via expectedLegs even when the diagnostic flag lies", () => {
    // Control flow is the first defense; this clause is the second. A filtered
    // matrix yields fewer results than the config declares, so even a run that
    // wrongly reports diagnostic: false cannot attest on a subset.
    const results = [pass("a")];
    expect(shouldAttest({ diagnostic: false, results, expectedLegs: 3 })).toBe(false);
    expect(shouldAttest({ diagnostic: false, results, expectedLegs: 1 })).toBe(true);
  });

  it("never attests on a hard failure, an empty matrix, or an unsettled hole", () => {
    expect(
      shouldAttest({
        diagnostic: false,
        results: [{ name: "a", mode: "hard", passed: false, durationS: 1, tail: "" }],
      }),
    ).toBe(false);
    expect(shouldAttest({ diagnostic: false, results: [] })).toBe(false);
    expect(shouldAttest({ diagnostic: false, results: [pass("a"), undefined] })).toBe(false);
  });
});

describe("toolchain helpers", () => {
  it("parses node majors from pins and versions", () => {
    for (const pin of ["22", "22.x", ">=22", "^22.1.0"]) {
      expect(nodeMajorFromPin(pin)).toBe(22);
    }
    expect(nodeMajorFromPin("")).toBeNull();
    expect(nodeMajorFromPin("abc")).toBeNull();
    expect(nodeMajorOf("22.11.0")).toBe(22);
    expect(nodeMajorOf("junk")).toBeNull();
  });

  it("parses go major.minor from `go version` output and go.mod text", () => {
    expect(goMajorMinorFromVersion("go version go1.26.5 linux/amd64")).toBe("1.26");
    expect(goMajorMinorFromVersion("garbage")).toBeNull();
    expect(goMajorMinorFromGoMod("module x\n\ngo 1.26.5\n")).toBe("1.26");
    expect(goMajorMinorFromGoMod("")).toBeNull();
  });

  it("toolchainProblems: match is silent, mismatch and unparseable are problems (fail-closed)", () => {
    const ok = toolchainProblems({
      pin: { node: "22" },
      nodeVersion: "22.11.0",
    });
    expect(ok).toEqual([]);

    const bad = toolchainProblems({
      pin: { node: "22", goMod: "api/go.mod" },
      nodeVersion: "20.1.0",
      goVersionOutput: "go version go1.25.0 linux/amd64",
      goModText: "go 1.26.5\n",
    });
    expect(bad.length).toBe(2);

    const unparseable = toolchainProblems({
      pin: { node: "22" },
      nodeVersion: "junk",
    });
    expect(unparseable.length).toBe(1);
  });

  it("no pin means no problems — the check is opt-in per config", () => {
    expect(toolchainProblems({ pin: null, nodeVersion: "junk" })).toEqual([]);
    expect(toolchainProblems({ pin: undefined, nodeVersion: "junk" })).toEqual([]);
  });
});

describe("renderComment toolchain line", () => {
  const SHA = "abc1234abc1234abc1234abc1234abc1234abc12";
  const RESULTS = [{ name: "lint", mode: "hard", passed: true, durationS: 1, tail: "" }];

  it("records the certified toolchain when pins were measured", () => {
    const body = renderComment(RESULTS, {
      headSha: SHA,
      hostname: "h",
      toolchain: { node: "22.11.0", go: "1.26" },
      now: new Date(),
    });
    expect(body).toContain("- Toolchain: node 22.11.0 · go 1.26");
  });

  it("omits the line when no pins are configured", () => {
    const body = renderComment(RESULTS, { headSha: SHA, hostname: "h", now: new Date() });
    expect(body).not.toContain("Toolchain:");
  });
});

describe("renderComment not-run defense", () => {
  it("renders a not-run leg as not run, never as pass", () => {
    const SHA = "abc1234abc1234abc1234abc1234abc1234abc12";
    const body = renderComment(
      [{ name: "bats", mode: "hard", passed: false, notRun: true, durationS: 0, tail: "" }],
      { headSha: SHA, hostname: "h", now: new Date() },
    );
    expect(body).toContain("not run (fail-fast)");
    expect(body).not.toMatch(/\| bats \| hard \| pass/);
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
    expect(() => buildGateSnippet({ trustedAssociations: /** @type {any} */ ("OWNER") })).toThrow(
      /non-empty array/,
    );
  });
});
