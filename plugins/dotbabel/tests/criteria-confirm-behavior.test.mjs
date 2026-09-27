// Additive boundary tests for `criteria/confirm.mjs`, closing the gap
// between its existing (indirect, via criteria-verify.test.mjs) coverage
// and the TEST-1 mutation-score floor (baseline 82.07%, 145 mutants).
//
// Several mutants are documented as genuinely equivalent rather than
// chased, each confirmed empirically:
//   - 94:26-28 (`m[1] ?? m[2] ?? ""`, the final `""` swapped): the regex
//     readAttribute matches against is `(?:"([^"]*)"|'([^']*)')` — one of
//     the two alternatives, and therefore one of the two capture groups,
//     always fires whenever the outer match succeeds at all (verified
//     directly: `" name=\"\"".match(...)` and `" name=''".match(...)`
//     each leave exactly one group defined, even for an empty attribute
//     value). The final `?? ""` can never execute.
//   - 38:46-52 (`"utf8"` -> `""` on the report's readFileSync): identical
//     reasoning to the same mutant class in spec-file.mjs — the resulting
//     Buffer's default `.toString()` is utf8, so every regex `.test` /
//     `.match` / `.replace` call downstream (which coerce via ToString)
//     sees byte-identical text either way. Confirmed directly against a
//     representative JUnit fragment.
//   - 74:21-39 (`body === undefined ? "passed" : outcomeOf(body)` -> always
//     call `outcomeOf`): `outcomeOf(undefined)` coerces `undefined` to the
//     literal string `"undefined"` for its three regex tests, none of
//     which match, so it also returns `"passed"`. Confirmed directly.
//   - 119:23-68, 119:54-68, and the paired LogicalOperator swap at 119:23-68
//     (each way of forcing the `Number.isInteger(codePoint) && codePoint >=
//     0` half of the numeric-entity bounds check to `true`): every entity
//     this code ever sees comes from
//     a digits-only or hex-digits-only regex capture, so `codePoint` is
//     never negative and is only ever non-integer via overflow to
//     `Infinity` — and `Infinity` also fails the untouched upper bound
//     (`<= 0x10ffff`), so the upper bound alone already rejects every input
//     this half could have rejected. A differential run of the real
//     `unescapeXml` against 8 mutated variants over 10 probes (the exact
//     0 and 0x10FFFF boundaries, one past each, and 400-digit decimal/hex
//     overflow entities) found these two produce no observable difference
//     on any probe — full script:
//     scratchpad/equiv-confirm-line119.mjs (this session's scratchpad).
//
// The other line-119 mutants (the whole-expression and upper-bound
// "always true", and the `<=`/`>=` boundary swaps) DID differ on that same
// probe set and are pinned by tests below.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJUnitReport, parseJUnitText, junitNameMatches, confirmTest, CriteriaReportError } from "../src/criteria/confirm.mjs";

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "confirm-behavior-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return { dir, file };
}

describe("parseJUnitReport — MAX_REPORT_BYTES boundary", () => {
  it("accepts a report exactly at the 10 MiB limit (only STRICTLY over is rejected)", () => {
    const MAX_REPORT_BYTES = 10 * 1024 * 1024;
    const prefix = `<testsuites><testsuite name="s"><testcase name="t"/></testsuite><!--`;
    const suffix = `--></testsuites>`;
    const padLength = MAX_REPORT_BYTES - prefix.length - suffix.length;
    const xml = prefix + "x".repeat(padLength) + suffix;
    expect(Buffer.byteLength(xml, "utf8")).toBe(MAX_REPORT_BYTES);
    const { dir, file } = tmpFile("exact-limit.xml", xml);
    try {
      const result = parseJUnitReport(file);
      expect(result.testcases).toEqual([{ name: "t", outcome: "passed" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a report one byte over the 10 MiB limit", () => {
    const MAX_REPORT_BYTES = 10 * 1024 * 1024;
    const prefix = `<testsuites><testsuite name="s"><testcase name="t"/></testsuite><!--`;
    const suffix = `--></testsuites>`;
    const padLength = MAX_REPORT_BYTES - prefix.length - suffix.length + 1;
    const xml = prefix + "x".repeat(padLength) + suffix;
    const { dir, file } = tmpFile("over-limit.xml", xml);
    try {
      expect(() => parseJUnitReport(file)).toThrow(CriteriaReportError);
      expect(() => parseJUnitReport(file)).toThrow(/exceeds the 10 MiB limit/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseJUnitText — attribute name matching", () => {
  it("reads a testcase's name attribute case-insensitively", () => {
    const xml = `<testsuites><testsuite name="s"><testcase classname="c" Name="check"/></testsuite></testsuites>`;
    expect(parseJUnitText(xml).testcases).toEqual([{ name: "check", outcome: "passed" }]);
  });
});

describe("parseJUnitText — numeric and named XML entities", () => {
  it("decodes a multi-digit hex character reference (not just its first digit)", () => {
    // The emoji is U+1F600, a 5-hex-digit reference. A regex missing its `+`
    // quantifier (or one whose class is accidentally negated) cannot match
    // this at all and leaves the reference completely literal.
    const xml = `<testsuites><testsuite name="s"><testcase name="&#x1F600; party"/></testsuite></testsuites>`;
    expect(parseJUnitText(xml).testcases[0].name).toBe("\u{1F600} party");
  });

  it("resolves the exact top boundary of a valid code point, 0x10FFFF", () => {
    const xml = `<testsuites><testsuite name="s"><testcase name="&#x10FFFF;"/></testsuite></testsuites>`;
    expect(parseJUnitText(xml).testcases[0].name).toBe(String.fromCodePoint(0x10ffff));
  });

  it("leaves a code point one past the maximum (0x110000) unresolved, rather than throwing", () => {
    const xml = `<testsuites><testsuite name="s"><testcase name="&#x110000;"/></testsuite></testsuites>`;
    expect(parseJUnitText(xml).testcases[0].name).toBe("&#x110000;");
  });

  it("resolves the exact bottom boundary of a valid code point, 0", () => {
    const xml = `<testsuites><testsuite name="s"><testcase name="a&#0;b"/></testsuite></testsuites>`;
    expect(parseJUnitText(xml).testcases[0].name).toBe("a\u0000b");
  });

  it("decodes a plain decimal character reference distinctly from a hex one", () => {
    const xml = `<testsuites><testsuite name="s"><testcase name="&#65;"/></testsuite></testsuites>`;
    expect(parseJUnitText(xml).testcases[0].name).toBe("A");
  });
});

describe("junitNameMatches", () => {
  it("trims the reported name before an exact match, even with no separator present", () => {
    expect(junitNameMatches("  test  ", "test")).toBe(true);
  });

  it("trims the criterion name before an exact match, even with no separator present", () => {
    expect(junitNameMatches("test", "  test  ")).toBe(true);
  });

  it("does not treat an absent separator as if it were found at the start of the string", () => {
    // "Xtarget" contains none of the four separators. A bug that skips the
    // `index === -1 -> continue` guard would still try `.slice()` with a
    // stale index of -1 for each separator — for the "::" separator
    // (length 2) that computes slice(1), which happens to equal "target"
    // here and would wrongly report a match.
    expect(junitNameMatches("Xtarget", "target")).toBe(false);
  });

  it("does not match on separator position alone; the suffix after it must equal the target", () => {
    expect(junitNameMatches("suite > wrongName", "test")).toBe(false);
  });

  it("matches a real suffix after the last separator", () => {
    expect(junitNameMatches("describe block > it name", "it name")).toBe(true);
  });
});

describe("confirmTest", () => {
  const junitReport = { testcases: [{ name: "suite > passing test", outcome: "passed" }] };

  it("reports found_in_file true and confirmed_by junit when a JUnit testcase matches", () => {
    const result = confirmTest({ file: "f", name: "passing test" }, junitReport, "");
    expect(result).toEqual({ found_in_file: true, confirmed_by: "junit", result: "passed" });
  });

  it("still reports found_in_file true and confirmed_by junit when NO JUnit testcase matches", () => {
    // found_in_file describes whether the *report* was readable, not
    // whether this specific test name was found in it — a missing name is
    // "absent", not "not found_in_file".
    const result = confirmTest({ file: "f", name: "nonexistent test" }, junitReport, "");
    expect(result).toEqual({ found_in_file: true, confirmed_by: "junit", result: "absent" });
  });

  it("falls back to output-text confirmation when no report is available", () => {
    const result = confirmTest({ file: "f", name: "my test name" }, null, "... my test name ...");
    expect(result).toEqual({ found_in_file: true, confirmed_by: "output", result: "passed" });
  });
});
