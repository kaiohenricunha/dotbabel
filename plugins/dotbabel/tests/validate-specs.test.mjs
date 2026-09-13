import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { validateSpecs } from "../src/validate-specs.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

function isolateFixture() {
  const dst = mkdtempSync(path.join(tmpdir(), "harness-spec-test-"));
  cpSync(FIXTURE_SRC, dst, { recursive: true });
  return dst;
}

function specJsonPath(root) {
  return path.join(root, "docs", "specs", "example-spec", "spec.json");
}

function readSpecJson(root) {
  return JSON.parse(readFileSync(specJsonPath(root), "utf8"));
}

function writeSpecJson(root, obj) {
  writeFileSync(specJsonPath(root), JSON.stringify(obj, null, 2) + "\n");
}

describe("validateSpecs", () => {
  it("passes on a valid spec", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("emits ValidationError instances with stable codes when spec is missing required field `title`", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const spec = readSpecJson(root);
    delete spec.title;
    writeSpecJson(root, spec);
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    for (const err of result.errors) expect(err).toBeInstanceOf(ValidationError);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD && /title/.test(e.message))).toBe(true);
    // Legacy string coercion keeps working (regex on toString()).
    expect(result.errors.some((e) => /title/.test(e))).toBe(true);
  });

  it("emits SPEC_STATUS_INVALID when `status` is not in the enum", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const spec = readSpecJson(root);
    spec.status = "foo";
    writeSpecJson(root, spec);
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_STATUS_INVALID)).toBe(true);
    expect(result.errors.some((e) => /status/.test(e))).toBe(true);
  });

  it("emits SPEC_ID_MISMATCH when `id` does not match the dir name", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const spec = readSpecJson(root);
    spec.id = "different-id";
    writeSpecJson(root, spec);
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_ID_MISMATCH)).toBe(true);
    expect(result.errors.some((e) => /id/.test(e))).toBe(true);
  });

  it("emits SPEC_DEPENDENCY_UNKNOWN when `depends_on_specs` references an unknown spec id", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const spec = readSpecJson(root);
    spec.depends_on_specs = ["nonexistent"];
    writeSpecJson(root, spec);
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_DEPENDENCY_UNKNOWN)).toBe(true);
    expect(result.errors.some((e) => /depends_on_specs|unknown/.test(e))).toBe(true);
  });

  it("emits SPEC_MISSING_REQUIRED_FIELD when `owners` is missing", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const spec = readSpecJson(root);
    delete spec.owners;
    writeSpecJson(root, spec);
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD && e.pointer === "owners")).toBe(true);
    expect(result.errors.some((e) => /owners/.test(e))).toBe(true);
  });

  it("emits SPEC_LINKED_PATH_MISSING when `linked_paths` is missing", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const spec = readSpecJson(root);
    delete spec.linked_paths;
    writeSpecJson(root, spec);
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_LINKED_PATH_MISSING)).toBe(true);
    expect(result.errors.some((e) => /linked_paths/.test(e))).toBe(true);
  });

  it("flags non-string entries inside linked_paths / acceptance_commands arrays and non-array active_prs", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const spec = readSpecJson(root);
    spec.linked_paths = ["ok.md", 42];
    spec.acceptance_commands = ["npm test", null];
    spec.active_prs = "not-an-array";
    writeSpecJson(root, spec);
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_LINKED_PATH_MISSING && e.pointer === "linked_paths[]")).toBe(true);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_ACCEPTANCE_EMPTY && e.pointer === "acceptance_commands[]")).toBe(true);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD && e.pointer === "active_prs")).toBe(true);
  });

  it("emits SPEC_JSON_INVALID when spec.json fails to parse", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    writeFileSync(specJsonPath(root), "{ not valid json");
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_JSON_INVALID)).toBe(true);
  });

  it("emits SPEC_JSON_INVALID when spec.json is missing for a listed dir", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    unlinkSync(specJsonPath(root));
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_JSON_INVALID && /missing spec\.json/.test(e.message))).toBe(true);
  });

  it("emits SPEC_ACCEPTANCE_EMPTY when `acceptance_commands` is empty", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const spec = readSpecJson(root);
    spec.acceptance_commands = [];
    writeSpecJson(root, spec);
    const result = validateSpecs(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_ACCEPTANCE_EMPTY)).toBe(true);
    expect(result.errors.some((e) => /acceptance_commands/.test(e))).toBe(true);
  });

  describe("§7 unquantified constraints", () => {
    function writeNfr(root, body) {
      const dir = path.join(root, "docs", "specs", "example-spec", "spec");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "7-non-functional-requirements.md"), body);
    }

    it("flags a constraint that promises a threshold without stating one", () => {
      const root = isolateFixture();
      writeNfr(root, "# §7\n\n- **PERF-1**: the read API must be fast under load.\n");
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED);
      expect(err).toBeDefined();
      expect(err.pointer).toBe("PERF-1");
    });

    it("flags the real-world case: an alarm with no metric or threshold", () => {
      const root = isolateFixture();
      writeNfr(root, "# §7\n\n- **REL-1**: a calibration drift alarm fires when accuracy is low.\n");
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED)).toBe(true);
    });

    it("accepts a constraint that states its value", () => {
      const root = isolateFixture();
      writeNfr(root, "# §7\n\n- **PERF-1**: p99 read latency must stay under 200ms; breach pages on-call.\n");
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED)).toEqual([]);
    });

    it("accepts an invariant that has no meaningful number", () => {
      const root = isolateFixture();
      writeNfr(root, "# §7\n\n- **REL-1**: All filesystem operations must be atomic at the individual file level.\n- **OPS-1**: Bootstrap must never overwrite a user-modified agent file.\n");
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED)).toEqual([]);
    });

    it("ignores scaffold guidance inside HTML comments", () => {
      const root = isolateFixture();
      writeNfr(root, "# §7\n\n<!--\n- **PERF-1**: must be fast\n-->\n\n- **PERF-1**: cold start under 2s.\n");
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED)).toEqual([]);
    });

    it("does not treat the constraint tag's own digit as the value", () => {
      const root = isolateFixture();
      writeNfr(root, "# §7\n\n- **PERF-9**: responses should be quick.\n");
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED)).toBe(true);
    });
  });

  describe("acceptance_criteria (P-A1, KD-1, KD-3, KD-15)", () => {
    function wellFormedCriterion(overrides = {}) {
      return {
        id: "AC-1",
        given: "a criterion command that exits 0",
        when: "every named test appears in the JUnit report without a failure",
        then: "the criterion passes and its evidence is pinned to the head commit",
        tests: [
          {
            file: "plugins/dotbabel/tests/criteria-verify.test.mjs",
            name: "passes a criterion only when the command exits 0 and every named test is confirmed",
          },
        ],
        argv: ["npx", "vitest", "run", "plugins/dotbabel/tests/criteria-verify.test.mjs"],
        ...overrides,
      };
    }

    it("accepts a spec without acceptance_criteria", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      expect(spec.acceptance_criteria).toBeUndefined();
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(true);
    });

    it("accepts a well-formed criterion with a junit-xml report", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({
          report: { format: "junit-xml", path: ".dotbabel/criteria/AC-1.junit.xml" },
        }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID)).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("accepts planned and active criterion status values", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ id: "AC-1", status: "planned" }),
        wellFormedCriterion({ id: "AC-2", status: "active" }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID)).toEqual([]);
    });

    it("emits SPEC_CRITERIA_INVALID when a criterion lacks given, when, or then", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      const criterion = wellFormedCriterion();
      delete criterion.given;
      spec.acceptance_criteria = [criterion];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/given");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID for a duplicate criterion id", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [wellFormedCriterion({ id: "AC-1" }), wellFormedCriterion({ id: "AC-1" })];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && /duplicate/i.test(e.message));
      expect(err).toBeDefined();
      expect(err.pointer).toBe("/acceptance_criteria/1/id");
    });

    it("emits SPEC_CRITERIA_INVALID for an id that does not match AC-<number>", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [wellFormedCriterion({ id: "criterion-1" })];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/id");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID for an unknown criterion status", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [wellFormedCriterion({ status: "done" })];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/status");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID when a test file path escapes the repository", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({
          tests: [{ file: "../../etc/passwd", name: "whatever" }],
        }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests/0/file");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID for an absolute test file path", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({
          tests: [{ file: "/etc/passwd", name: "whatever" }],
        }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests/0/file");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID when argv is empty or holds an empty string", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ id: "AC-1", argv: [] }),
        wellFormedCriterion({ id: "AC-2", argv: ["npx", ""] }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/argv")).toBe(true);
      expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/1/argv/1")).toBe(true);
    });

    it("emits SPEC_CRITERIA_INVALID when tests is missing or empty", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [wellFormedCriterion({ tests: [] })];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID for a report with an invalid format", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ report: { format: "tap", path: "out.tap" } }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/report/format");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID when a criterion entry is not an object", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = ["not-an-object"];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID when a tests[] entry is not an object", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [wellFormedCriterion({ tests: ["not-an-object"] })];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests/0");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID when a test name is missing", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ tests: [{ file: "plugins/dotbabel/tests/criteria-verify.test.mjs" }] }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests/0/name");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID when report is not an object", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [wellFormedCriterion({ report: "not-an-object" })];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/report");
      expect(err).toBeDefined();
    });

    it("emits SPEC_CRITERIA_INVALID when report.path traverses outside the repository", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ report: { format: "junit-xml", path: "../../etc/passwd" } }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/report/path");
      expect(err).toBeDefined();
    });

    it("rejects a Windows drive-letter absolute path even though it is not POSIX-absolute", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ tests: [{ file: "C:\\Windows\\System32\\config", name: "n" }] }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests/0/file");
      expect(err).toBeDefined();
    });

    it("rejects a backslash-separated traversal, which a bare host-separator split cannot see on Linux", () => {
      // toPosix() splits on path.sep, a no-op on this host, so a check that
      // relied on it alone would let "..\\..\\etc\\passwd" straight through.
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ tests: [{ file: "..\\..\\..\\etc\\passwd", name: "n" }] }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests/0/file");
      expect(err).toBeDefined();
    });

    it("rejects a UNC-style path", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ tests: [{ file: "\\\\server\\share\\payload.mjs", name: "n" }] }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests/0/file");
      expect(err).toBeDefined();
    });

    it("allows a Windows-style relative path with backslash separators", () => {
      // The normalization must reject a traversal or a UNC form without also
      // rejecting an ordinary relative path spelled with backslashes.
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ tests: [{ file: "plugins\\dotbabel\\tests\\criteria-verify.test.mjs", name: "n" }] }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID)).toEqual([]);
    });

    it("emits SPEC_CRITERIA_INVALID when acceptance_criteria is not an array", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = { "AC-1": {} };
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      const err = result.errors.find((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria");
      expect(err).toBeDefined();
    });

    it("emits a single error, not two, when a tests[] entry is an array rather than an object", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [wellFormedCriterion({ tests: [[]] })];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      const testErrors = result.errors.filter((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer.startsWith("/acceptance_criteria/0/tests/0"));
      expect(testErrors).toHaveLength(1);
      expect(testErrors[0].pointer).toBe("/acceptance_criteria/0/tests/0");
    });

    it("emits SPEC_CRITERIA_INVALID when a test file path is missing or empty", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({ tests: [{ name: "n" }] }),
        wellFormedCriterion({ id: "AC-2", tests: [{ file: "   ", name: "n" }] }),
      ];
      writeSpecJson(root, spec);
      const result = validateSpecs(ctx);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/0/tests/0/file")).toBe(true);
      expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID && e.pointer === "/acceptance_criteria/1/tests/0/file")).toBe(true);
    });

    it("never reads a named test file or runs a command while validating", () => {
      const root = isolateFixture();
      const ctx = createHarnessContext({ repoRoot: root });
      const spec = readSpecJson(root);
      spec.acceptance_criteria = [
        wellFormedCriterion({
          tests: [{ file: "plugins/dotbabel/tests/does-not-exist.test.mjs", name: "anything" }],
          argv: ["definitely-not-a-real-binary-xyz"],
        }),
      ];
      writeSpecJson(root, spec);
      // The shape check must pass even though the named file and command do
      // not exist on disk (Q-5: the validator never reads test files or runs
      // commands — that happens at verification time, not here).
      const result = validateSpecs(ctx);
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_CRITERIA_INVALID)).toEqual([]);
    });
  });
});
