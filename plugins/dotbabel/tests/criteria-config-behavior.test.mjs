// Behavioral boundaries of `criteria/config.mjs` (TEST-1, mutation floor 85).
//
// This validator decides which `criteria` block the merge gate judges every pull
// request under, and its whole job is to refuse a bad block loudly: a typo that
// loads cleanly leaves the gate running on a default nobody chose. The existing
// `criteria-config.test.mjs` goes through the file loader and checks one happy
// case and one rejection per field. What it never does is probe a boundary, name
// an unknown key, or check what a rejection says: which field, in which file,
// under which category. Those are what a person fixing a bad config reads.
//
// Every rejection is asserted by its structured fields (code, category, pointer,
// file), not by message text. Two parser-derived messages are compared with the
// parser's own output rather than a literal.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadCriteriaConfig, loadCriteriaConfigText, validateCriteriaConfig } from "../src/criteria/config.mjs";

const DEFAULTS = {
  pass_env: [],
  timeout_seconds: 600,
  enforcement: "block",
  trusted_associations: ["OWNER"],
  require_ci_check: false,
};

const KEYS = ["pass_env", "timeout_seconds", "enforcement", "trusted_associations", "require_ci_check"];

const validate = (criteria, file) => validateCriteriaConfig({ criteria }, file);
const caught = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

/** Assert a rejection by field, not by wording. */
function expectRejected(fn, pointer, file = ".dotbabel.json") {
  const error = caught(fn);
  expect(error, "expected a rejection").not.toBeNull();
  expect(error.name).toBe("ValidationError");
  expect(error.code).toBe("CRITERIA_CONFIG_INVALID");
  expect(error.category).toBe("criteria");
  expect(error.pointer).toBe(pointer);
  expect(error.file).toBe(file);
  return error;
}

describe("defaults", () => {
  it.each([
    ["no config at all", undefined],
    ["null", null],
    ["an empty object", {}],
    ["a config with no criteria key", { quality: {} }],
    ["a criteria key that is explicitly undefined", { criteria: undefined }],
    ["an empty criteria block", { criteria: {} }],
    ["an array at the top level", []],
  ])("returns the defaults for %s", (_label, parsed) => {
    expect(validateCriteriaConfig(parsed)).toEqual(DEFAULTS);
  });

  it("hands each caller its own arrays, so changing one result never changes the next", () => {
    const first = validateCriteriaConfig(undefined);
    first.pass_env.push("LEAK");
    first.trusted_associations.push("LEAK");
    first.trusted_associations[0] = "CHANGED";
    expect(validateCriteriaConfig(undefined)).toEqual(DEFAULTS);
    expect(validateCriteriaConfig({ criteria: {} })).toEqual(DEFAULTS);
  });

  it("fills in only what is missing", () => {
    expect(validate({ enforcement: "warn" })).toEqual({ ...DEFAULTS, enforcement: "warn" });
    expect(validate({ timeout_seconds: 30 })).toEqual({ ...DEFAULTS, timeout_seconds: 30 });
  });

  it("reads an explicit null as absent, for every key", () => {
    expect(validate(Object.fromEntries(KEYS.map((k) => [k, null])))).toEqual(DEFAULTS);
  });

  it("returns every value it was given", () => {
    const given = { pass_env: ["A", "B_2"], timeout_seconds: 90, enforcement: "warn", trusted_associations: ["OWNER", "MEMBER"], require_ci_check: true };
    expect(validate(given)).toEqual(given);
  });
});

describe("the criteria block itself", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["an array with entries", [{ enforcement: "warn" }]],
    ["a string", "block"],
    ["a number", 5],
    ["zero", 0],
    ["true", true],
    ["false", false],
  ])("rejects %s, pointing at /criteria", (_label, criteria) => {
    expectRejected(() => validate(criteria), "/criteria");
  });
});

describe("unknown keys", () => {
  it.each([
    "enforcment",
    "trusted_assocations",
    "Enforcement",
    "timeout",
    "",
    // Names that exist on every object but are not configuration.
    "toString",
    "constructor",
    "hasOwnProperty",
    "valueOf",
  ])("rejects %j and names it", (key) => {
    const error = expectRejected(() => validate({ [key]: 1 }), `/criteria/${key}`);
    expect(error.got).toBe(key);
    expect(error.message).toContain(key);
  });

  it("rejects a __proto__ key that JSON.parse created as an own property", () => {
    const error = caught(() => loadCriteriaConfigText('{"criteria":{"__proto__":{"enforcement":"warn"}}}'));
    expect(error?.code).toBe("CRITERIA_CONFIG_INVALID");
    expect(error?.pointer).toBe("/criteria/__proto__");
  });

  it("lists every valid key so the reader can fix the typo", () => {
    const error = caught(() => validate({ enforcment: "warn" }));
    for (const key of KEYS) expect(error.expected, `the hint omits ${key}`).toContain(key);
  });

  it("separates the valid keys, so each can be read and typed on its own", () => {
    // Run together they would read `pass_envtimeout_secondsenforcement...`: every
    // name is still "in" the hint, and none of them is usable.
    const { expected } = caught(() => validate({ enforcment: "warn" }));
    for (const key of KEYS) {
      expect(expected, `${key} is not set apart from its neighbours`).toMatch(new RegExp(`(^|[^A-Za-z_])${key}([^A-Za-z_]|$)`));
    }
  });

  it("reports the unknown key before it looks at any value, and the first one it meets", () => {
    expectRejected(() => validate({ enforcement: "not-valid", zzz: 1 }), "/criteria/zzz");
    expectRejected(() => validate({ first: 1, second: 2 }), "/criteria/first");
  });

  it("accepts all five known keys together", () => {
    expect(() => validate(Object.fromEntries(KEYS.map((k) => [k, DEFAULTS[k]])))).not.toThrow();
  });
});

describe("pass_env", () => {
  const passEnv = (value) => () => validate({ pass_env: value });

  it.each([["A"], ["a"], ["_"], ["_A"], ["Z9"], ["a_b_C_1"], ["PATH", "HOME", "_X"]])("accepts %j", (...names) => {
    expect(validate({ pass_env: names }).pass_env).toEqual(names);
  });

  it("accepts an empty list", () => {
    expect(validate({ pass_env: [] }).pass_env).toEqual([]);
  });

  it.each([
    ["an empty name", ""],
    ["a name starting with a digit", "1A"],
    ["a name with a dash", "A-B"],
    ["a name with a space", "A B"],
    ["a name with a dot", "A.B"],
    ["a name with a leading space", " A"],
    ["a name with a trailing space", "A "],
    ["a name with a trailing newline", "A\n"],
    ["a name with an equals sign", "A=1"],
    ["a name with a non-ASCII letter", "É"],
    ["a name with a slash", "A/B"],
  ])("rejects %s", (_label, name) => {
    expectRejected(passEnv([name]), "/criteria/pass_env");
    expectRejected(passEnv(["OK", name]), "/criteria/pass_env");
  });

  it.each([
    ["a number", 5],
    ["null inside the list", null],
    ["an object", {}],
    ["a nested list", ["A"]],
    ["a boolean", true],
  ])("rejects a list holding %s", (_label, entry) => {
    expectRejected(passEnv(["A", entry]), "/criteria/pass_env");
  });

  it.each([
    ["a string", "A"],
    ["an object", { A: 1 }],
    ["a number", 5],
    ["true", true],
  ])("rejects %s where a list belongs", (_label, value) => {
    expectRejected(passEnv(value), "/criteria/pass_env");
  });
});

describe("timeout_seconds", () => {
  const timeout = (value) => () => validate({ timeout_seconds: value });

  it.each([1, 2, 60, 600, 3599, 3600])("accepts %i, both ends of the range included", (seconds) => {
    expect(validate({ timeout_seconds: seconds }).timeout_seconds).toBe(seconds);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["one over the top", 3601],
    ["far over", 86400],
    ["fractional", 1.5],
    ["fractional inside the range", 600.5],
    ["a numeric string", "60"],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["true", true],
    ["a list", [60]],
  ])("rejects %s", (_label, value) => {
    expectRejected(timeout(value), "/criteria/timeout_seconds");
  });
});

describe("enforcement", () => {
  const enforcement = (value) => () => validate({ enforcement: value });

  it.each(["block", "warn"])("accepts %s", (value) => {
    expect(validate({ enforcement: value }).enforcement).toBe(value);
  });

  it.each([
    ["a different case", "BLOCK"],
    ["another different case", "Warn"],
    ["an empty string", ""],
    ["an unrelated word", "off"],
    ["with padding", " block"],
    ["a number", 1],
    ["true", true],
    ["a list", ["block"]],
  ])("rejects %s", (_label, value) => {
    expectRejected(enforcement(value), "/criteria/enforcement");
  });
});

describe("trusted_associations", () => {
  const trusted = (value) => () => validate({ trusted_associations: value });

  it("accepts one or several names, and returns them untouched", () => {
    expect(validate({ trusted_associations: ["MEMBER"] }).trusted_associations).toEqual(["MEMBER"]);
    expect(validate({ trusted_associations: ["OWNER", "MEMBER", "COLLABORATOR"] }).trusted_associations).toEqual(["OWNER", "MEMBER", "COLLABORATOR"]);
    // Only blank entries are refused; padding around a real one is kept as given.
    expect(validate({ trusted_associations: [" MEMBER "] }).trusted_associations).toEqual([" MEMBER "]);
  });

  it.each([
    ["an empty list", []],
    ["an empty string", [""]],
    ["a blank string", [" "]],
    ["a tab and a newline", ["\t\n"]],
    ["a valid name beside an empty one", ["OWNER", ""]],
    ["an empty one beside a valid name", ["", "OWNER"]],
    ["a valid name beside a blank one", ["OWNER", "  "]],
    ["a number", [1]],
    ["a valid name beside a number", ["OWNER", 5]],
    ["null", [null]],
    ["an object", [{}]],
    ["a bare string", "OWNER"],
    ["an object where a list belongs", { 0: "OWNER" }],
    ["a number where a list belongs", 5],
  ])("rejects %s", (_label, value) => {
    expectRejected(trusted(value), "/criteria/trusted_associations");
  });
});

describe("require_ci_check", () => {
  const requireCi = (value) => () => validate({ require_ci_check: value });

  it("accepts true and false, and keeps each", () => {
    expect(validate({ require_ci_check: true }).require_ci_check).toBe(true);
    expect(validate({ require_ci_check: false }).require_ci_check).toBe(false);
  });

  it.each([
    ["the string true", "true"],
    ["the string false", "false"],
    ["one", 1],
    ["zero", 0],
    ["an empty string", ""],
    ["a list", []],
    ["an object", {}],
  ])("rejects %s", (_label, value) => {
    expectRejected(requireCi(value), "/criteria/require_ci_check");
  });
});

describe("every rejection says where it happened", () => {
  const bad = {
    pass_env: "A",
    timeout_seconds: 0,
    enforcement: "off",
    trusted_associations: [],
    require_ci_check: "yes",
  };

  it.each(Object.keys(bad))("names the file it was given when %s is invalid", (key) => {
    expectRejected(() => validate({ [key]: bad[key] }, "abc123:.dotbabel.json"), `/criteria/${key}`, "abc123:.dotbabel.json");
  });

  it("falls back to .dotbabel.json when no file name is given", () => {
    expectRejected(() => validate({ enforcement: "off" }), "/criteria/enforcement", ".dotbabel.json");
    expectRejected(() => validate(5), "/criteria", ".dotbabel.json");
    expectRejected(() => validate({ zzz: 1 }), "/criteria/zzz", ".dotbabel.json");
  });

  it("carries a supplied file name on the block-level and unknown-key rejections too", () => {
    expectRejected(() => validate(5, "x:.dotbabel.json"), "/criteria", "x:.dotbabel.json");
    expectRejected(() => validate({ zzz: 1 }, "x:.dotbabel.json"), "/criteria/zzz", "x:.dotbabel.json");
  });
});

describe("loadCriteriaConfigText", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("selects the defaults for %s content", (_label, text) => {
    expect(loadCriteriaConfigText(text)).toEqual(DEFAULTS);
  });

  it("does not treat whitespace as missing content: it is invalid JSON", () => {
    expectRejected(() => loadCriteriaConfigText("   "), undefined);
    expectRejected(() => loadCriteriaConfigText("\n"), undefined);
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "5"],
    ["a string", '"criteria"'],
    ["an object with no criteria key", '{"quality":{}}'],
  ])("selects the defaults for valid JSON that is %s", (_label, text) => {
    expect(loadCriteriaConfigText(text)).toEqual(DEFAULTS);
  });

  it("parses and validates a real block", () => {
    const text = JSON.stringify({ criteria: { enforcement: "warn", timeout_seconds: 45 } });
    expect(loadCriteriaConfigText(text)).toEqual({ ...DEFAULTS, enforcement: "warn", timeout_seconds: 45 });
  });

  it("reports invalid JSON with the file and the parser's own reason, and no pointer", () => {
    const text = '{"criteria": ';
    const reason = caught(() => JSON.parse(text)).message;
    const error = caught(() => loadCriteriaConfigText(text, "sha:.dotbabel.json"));
    expect(error.code).toBe("CRITERIA_CONFIG_INVALID");
    expect(error.category).toBe("criteria");
    expect(error.file).toBe("sha:.dotbabel.json");
    expect(error.pointer).toBeUndefined();
    expect(error.message).toContain("sha:.dotbabel.json");
    expect(error.message).toContain(reason);
  });

  it("names .dotbabel.json when no file name is given", () => {
    const error = caught(() => loadCriteriaConfigText("{"));
    expect(error.file).toBe(".dotbabel.json");
    expect(error.message).toContain(".dotbabel.json");
  });

  it("passes the file name through to a validation failure", () => {
    expectRejected(() => loadCriteriaConfigText('{"criteria":{"enforcement":"off"}}', "ref:.dotbabel.json"), "/criteria/enforcement", "ref:.dotbabel.json");
  });
});

describe("loadCriteriaConfig from disk", () => {
  const dirs = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  const temp = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "criteria-config-behavior-"));
    dirs.push(dir);
    return dir;
  };

  it("answers with the defaults only when the file or its directory does not exist", () => {
    const dir = temp();
    expect(loadCriteriaConfig(dir)).toEqual(DEFAULTS);
    expect(loadCriteriaConfig(path.join(dir, "no", "such", "place"))).toEqual(DEFAULTS);
  });

  it("does not swallow any other read failure as though the file were absent", () => {
    // A directory where the file belongs, and a file where the directory belongs:
    // both are real failures, and reading them as "no configuration" would run
    // the merge gate on defaults over a repository that has a config it cannot read.
    const isDirectory = temp();
    fs.mkdirSync(path.join(isDirectory, ".dotbabel.json"));
    expect(caught(() => loadCriteriaConfig(isDirectory))?.code).toBe("EISDIR");

    const root = temp();
    const notADirectory = path.join(root, "a-file");
    fs.writeFileSync(notADirectory, "x");
    expect(caught(() => loadCriteriaConfig(notADirectory))?.code).toBe("ENOTDIR");
  });

  it("reads and validates the file, and reports a bad one under .dotbabel.json", () => {
    const good = temp();
    fs.writeFileSync(path.join(good, ".dotbabel.json"), JSON.stringify({ criteria: { require_ci_check: true } }));
    expect(loadCriteriaConfig(good)).toEqual({ ...DEFAULTS, require_ci_check: true });

    const badJson = temp();
    fs.writeFileSync(path.join(badJson, ".dotbabel.json"), "{ nope");
    expect(caught(() => loadCriteriaConfig(badJson))?.code).toBe("CRITERIA_CONFIG_INVALID");

    const badValue = temp();
    fs.writeFileSync(path.join(badValue, ".dotbabel.json"), JSON.stringify({ criteria: { timeout_seconds: 0 } }));
    expect(caught(() => loadCriteriaConfig(badValue))?.pointer).toBe("/criteria/timeout_seconds");
  });

  it("treats an empty file as no configuration", () => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, ".dotbabel.json"), "");
    expect(loadCriteriaConfig(dir)).toEqual(DEFAULTS);
  });
});
