import { describe, it, expect } from "vitest";
import * as barrel from "../src/index.mjs";

describe("package barrel — @kaiohenricunha/dotclaude", () => {
  it("exports at least 24 named symbols (public API surface guard)", () => {
    expect(Object.keys(barrel).length).toBeGreaterThanOrEqual(24);
  });

  it("exports the spec-harness-lib surface (18 helpers)", () => {
    const expected = [
      "createHarnessContext",
      "toPosix",
      "readJson",
      "readText",
      "pathExists",
      "git",
      "loadFacts",
      "listSpecDirs",
      "listRepoPaths",
      "escapeRegex",
      "globToRegExp",
      "matchesGlob",
      "anyPathMatches",
      "extractTemplateSection",
      "isMeaningfulSection",
      "getPullRequestContext",
      "isBotActor",
      "getChangedFiles",
    ];
    for (const name of expected) expect(barrel[name]).toBeTypeOf("function");
  });

  it("exports the 6 validator entry points", () => {
    for (const name of [
      "validateSpecs",
      "validateManifest",
      "refreshChecksums",
      "checkInstructionDrift",
      "checkSpecCoverage",
      "scaffoldHarness",
    ]) {
      expect(barrel[name]).toBeTypeOf("function");
    }
  });

  it("exports ValidationError, ERROR_CODES, formatError, EXIT_CODES, version", () => {
    expect(barrel.ValidationError).toBeTypeOf("function");
    expect(barrel.ERROR_CODES).toBeTypeOf("object");
    expect(barrel.formatError).toBeTypeOf("function");
    expect(barrel.EXIT_CODES).toBeTypeOf("object");
    expect(barrel.version).toBeTypeOf("string");
  });

  it("version string matches package.json", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, resolve } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "..", "..", "package.json"), "utf8")
    );
    expect(barrel.version).toBe(pkg.version);
  });

  it("EXIT_CODES is frozen with the documented convention", () => {
    expect(Object.isFrozen(barrel.EXIT_CODES)).toBe(true);
    expect(barrel.EXIT_CODES).toEqual({ OK: 0, VALIDATION: 1, ENV: 2, USAGE: 64 });
  });
});
