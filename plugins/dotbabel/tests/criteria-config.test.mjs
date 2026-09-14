import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCriteriaConfig } from "../src/criteria/config.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tempRepo(dotbabelJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "criteria-config-"));
  dirs.push(dir);
  if (dotbabelJson !== undefined) fs.writeFileSync(path.join(dir, ".dotbabel.json"), typeof dotbabelJson === "string" ? dotbabelJson : JSON.stringify(dotbabelJson));
  return dir;
}

describe("loadCriteriaConfig", () => {
  it("returns defaults when .dotbabel.json is absent", () => {
    const dir = tempRepo();
    expect(loadCriteriaConfig(dir)).toEqual({
      pass_env: [],
      timeout_seconds: 600,
      enforcement: "block",
      trusted_associations: ["OWNER"],
      require_ci_check: false,
    });
  });

  it("returns defaults when .dotbabel.json has no criteria key", () => {
    const dir = tempRepo({ quality: {} });
    expect(loadCriteriaConfig(dir).timeout_seconds).toBe(600);
  });

  it("accepts a fully-populated criteria key, including keys only a later unit consumes", () => {
    const dir = tempRepo({
      criteria: {
        pass_env: ["MY_VAR"],
        timeout_seconds: 120,
        enforcement: "warn",
        trusted_associations: ["OWNER", "MEMBER"],
        require_ci_check: true,
      },
    });
    expect(loadCriteriaConfig(dir)).toEqual({
      pass_env: ["MY_VAR"],
      timeout_seconds: 120,
      enforcement: "warn",
      trusted_associations: ["OWNER", "MEMBER"],
      require_ci_check: true,
    });
  });

  it("rejects invalid JSON", () => {
    const dir = tempRepo("not json");
    expect(() => loadCriteriaConfig(dir)).toThrow(/not valid JSON/);
  });

  it("rejects a non-object criteria key", () => {
    const dir = tempRepo({ criteria: "nope" });
    expect(() => loadCriteriaConfig(dir)).toThrow(/criteria must be an object/);
  });

  it("rejects a pass_env name that is not a valid environment-variable name", () => {
    const dir = tempRepo({ criteria: { pass_env: ["1BAD"] } });
    expect(() => loadCriteriaConfig(dir)).toThrow(/pass_env/);
  });

  it.each([0, 3601, 1.5, "600"])("rejects an out-of-range or non-integer timeout_seconds (%s)", (value) => {
    const dir = tempRepo({ criteria: { timeout_seconds: value } });
    expect(() => loadCriteriaConfig(dir)).toThrow(/timeout_seconds/);
  });

  it("rejects an enforcement value other than block or warn", () => {
    const dir = tempRepo({ criteria: { enforcement: "ignore" } });
    expect(() => loadCriteriaConfig(dir)).toThrow(/enforcement/);
  });

  it("rejects an empty trusted_associations array", () => {
    const dir = tempRepo({ criteria: { trusted_associations: [] } });
    expect(() => loadCriteriaConfig(dir)).toThrow(/trusted_associations/);
  });

  it("rejects a non-boolean require_ci_check", () => {
    const dir = tempRepo({ criteria: { require_ci_check: "yes" } });
    expect(() => loadCriteriaConfig(dir)).toThrow(/require_ci_check/);
  });
});
