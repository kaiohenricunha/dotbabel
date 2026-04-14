import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from "fs";
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
});
