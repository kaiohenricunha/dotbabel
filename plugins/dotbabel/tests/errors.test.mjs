import { describe, it, expect } from "vitest";
import {
  ValidationError,
  ERROR_CODES,
  formatError,
} from "../src/lib/errors.mjs";

describe("ERROR_CODES", () => {
  it("freezes the enum so consumer code cannot mutate it", () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it("exposes the SEC1-4 settings codes", () => {
    expect(ERROR_CODES.SETTINGS_SEC_1).toBe("SETTINGS_SEC_1");
    expect(ERROR_CODES.SETTINGS_SEC_2).toBe("SETTINGS_SEC_2");
    expect(ERROR_CODES.SETTINGS_SEC_3).toBe("SETTINGS_SEC_3");
    expect(ERROR_CODES.SETTINGS_SEC_4).toBe("SETTINGS_SEC_4");
  });

  it("exposes the load-bearing validator codes referenced by the remediation plan", () => {
    expect(ERROR_CODES.SPEC_STATUS_INVALID).toBeDefined();
    expect(ERROR_CODES.MANIFEST_CHECKSUM_MISMATCH).toBeDefined();
    expect(ERROR_CODES.COVERAGE_UNCOVERED).toBeDefined();
    expect(ERROR_CODES.DRIFT_TEAM_COUNT).toBeDefined();
  });
});

describe("ValidationError", () => {
  it("requires code and message", () => {
    expect(() => new ValidationError(/** @type {any} */ (null))).toThrow(TypeError);
    expect(() => new ValidationError(/** @type {any} */ ({ code: "X" }))).toThrow(TypeError);
    expect(() => new ValidationError(/** @type {any} */ ({ message: "oops" }))).toThrow(TypeError);
  });

  it("exposes structured properties", () => {
    const err = new ValidationError({
      code: "SPEC_STATUS_INVALID",
      message: "status must be one of draft|ready|done",
      file: "docs/specs/foo/spec.json",
      pointer: "/status",
      line: 3,
      expected: "draft|ready|done",
      got: "finished",
      hint: "Change status to 'done'",
      category: "spec",
    });
    expect(err.name).toBe("ValidationError");
    expect(err.code).toBe("SPEC_STATUS_INVALID");
    expect(err.file).toBe("docs/specs/foo/spec.json");
    expect(err.pointer).toBe("/status");
    expect(err.line).toBe(3);
    expect(err.expected).toBe("draft|ready|done");
    expect(err.got).toBe("finished");
    expect(err.hint).toBe("Change status to 'done'");
    expect(err.category).toBe("spec");
  });

  it("extends Error so existing catch blocks work unchanged", () => {
    const err = new ValidationError({ code: "X", message: "oops" });
    expect(err).toBeInstanceOf(Error);
  });

  it("toString() returns legacy '<file>: <message>' format", () => {
    const withFile = new ValidationError({
      code: "X",
      message: "oops",
      file: "a.json",
    });
    expect(withFile.toString()).toBe("a.json: oops");

    const noFile = new ValidationError({ code: "X", message: "oops" });
    expect(noFile.toString()).toBe("oops");
  });

  it("toJSON() returns only defined fields (no undefineds)", () => {
    const err = new ValidationError({
      code: "X",
      message: "oops",
      file: "a.json",
    });
    expect(err.toJSON()).toEqual({ code: "X", message: "oops", file: "a.json" });
  });

  it("round-trips through JSON.stringify", () => {
    const err = new ValidationError({
      code: "COVERAGE_UNCOVERED",
      message: "path not covered by any spec",
      file: "src/x.ts",
      hint: "Add to docs/specs/<name>/spec.json linked_paths",
    });
    const round = JSON.parse(JSON.stringify(err));
    expect(round.code).toBe("COVERAGE_UNCOVERED");
    expect(round.file).toBe("src/x.ts");
    expect(round.hint).toContain("linked_paths");
  });
});

describe("formatError", () => {
  it("renders a single-line message without verbose flag", () => {
    const err = new ValidationError({
      code: "X",
      message: "oops",
      file: "a.json",
      hint: "Try this",
    });
    expect(formatError(err)).toBe("a.json: oops");
  });

  it("renders structured detail lines with verbose flag", () => {
    const err = new ValidationError({
      code: "X",
      message: "oops",
      file: "a.json",
      hint: "Try this",
      expected: "foo",
      got: "bar",
    });
    const out = formatError(err, { verbose: true });
    expect(out).toContain("a.json: oops");
    expect(out).toContain("code:     X");
    expect(out).toContain("hint:     Try this");
    expect(out).toContain("expected: foo");
    expect(out).toContain("got:      bar");
  });

  it("handles plain Error instances without crashing", () => {
    const out = formatError(new Error("boom"));
    expect(out).toBe("boom");
  });
});
