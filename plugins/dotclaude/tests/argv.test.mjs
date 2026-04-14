import { describe, it, expect } from "vitest";
import { parse, helpText, HARNESS_FLAGS } from "../src/lib/argv.mjs";

describe("parse — harness-wide flags", () => {
  it("recognizes --help and short -h", () => {
    expect(parse(["--help"]).help).toBe(true);
    expect(parse(["-h"]).help).toBe(true);
  });

  it("recognizes --version and short -V", () => {
    expect(parse(["--version"]).version).toBe(true);
    expect(parse(["-V"]).version).toBe(true);
  });

  it("recognizes --json, --verbose, --no-color", () => {
    const r = parse(["--json", "--verbose", "--no-color"]);
    expect(r.json).toBe(true);
    expect(r.verbose).toBe(true);
    expect(r.noColor).toBe(true);
  });

  it("returns positional args", () => {
    const r = parse(["pos1", "pos2"]);
    expect(r.positional).toEqual(["pos1", "pos2"]);
  });

  it("throws an error with code USAGE_UNKNOWN_FLAG on unknown flag", () => {
    let caught;
    try {
      parse(["--not-a-real-flag"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe("USAGE_UNKNOWN_FLAG");
  });
});

describe("parse — bin-specific flags", () => {
  it("merges caller spec with HARNESS_FLAGS", () => {
    const r = parse(["--base", "main", "--json"], {
      base: { type: "string" },
    });
    expect(r.flags.base).toBe("main");
    expect(r.json).toBe(true);
  });
});

describe("helpText", () => {
  it("includes synopsis, description, options, exit codes", () => {
    const text = helpText({
      name: "harness-foo",
      synopsis: "harness-foo [OPTIONS] <spec-id>",
      description: "Do the thing.",
      flags: { base: { type: "string" } },
    });
    expect(text).toContain("harness-foo [OPTIONS] <spec-id>");
    expect(text).toContain("Do the thing.");
    expect(text).toContain("--base");
    expect(text).toContain("--help");
    expect(text).toContain("--json");
    expect(text).toContain("Exit codes:");
  });
});

describe("HARNESS_FLAGS", () => {
  it("is frozen so callers cannot mutate shared state", () => {
    expect(Object.isFrozen(HARNESS_FLAGS)).toBe(true);
  });
});
