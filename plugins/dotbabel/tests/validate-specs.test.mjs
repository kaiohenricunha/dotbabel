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
    expect(
      result.errors.some(
        (e) => e.code === ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD && /title/.test(e.message),
      ),
    ).toBe(true);
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
    expect(
      result.errors.some(
        (e) => e.code === ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD && e.pointer === "owners",
      ),
    ).toBe(true);
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
    expect(
      result.errors.some(
        (e) => e.code === ERROR_CODES.SPEC_LINKED_PATH_MISSING && e.pointer === "linked_paths[]",
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (e) =>
          e.code === ERROR_CODES.SPEC_ACCEPTANCE_EMPTY && e.pointer === "acceptance_commands[]",
      ),
    ).toBe(true);
    expect(
      result.errors.some(
        (e) => e.code === ERROR_CODES.SPEC_MISSING_REQUIRED_FIELD && e.pointer === "active_prs",
      ),
    ).toBe(true);
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
    expect(
      result.errors.some(
        (e) => e.code === ERROR_CODES.SPEC_JSON_INVALID && /missing spec\.json/.test(e.message),
      ),
    ).toBe(true);
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
      writeNfr(
        root,
        "# §7\n\n- **REL-1**: a calibration drift alarm fires when accuracy is low.\n",
      );
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.errors.some((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED)).toBe(true);
    });

    it("accepts a constraint that states its value", () => {
      const root = isolateFixture();
      writeNfr(
        root,
        "# §7\n\n- **PERF-1**: p99 read latency must stay under 200ms; breach pages on-call.\n",
      );
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED)).toEqual([]);
    });

    it("accepts an invariant that has no meaningful number", () => {
      const root = isolateFixture();
      writeNfr(
        root,
        "# §7\n\n- **REL-1**: All filesystem operations must be atomic at the individual file level.\n- **OPS-1**: Bootstrap must never overwrite a user-modified agent file.\n",
      );
      const result = validateSpecs(createHarnessContext({ repoRoot: root }));
      expect(result.errors.filter((e) => e.code === ERROR_CODES.SPEC_NFR_UNQUANTIFIED)).toEqual([]);
    });

    it("ignores scaffold guidance inside HTML comments", () => {
      const root = isolateFixture();
      writeNfr(
        root,
        "# §7\n\n<!--\n- **PERF-1**: must be fast\n-->\n\n- **PERF-1**: cold start under 2s.\n",
      );
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
});
