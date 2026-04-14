import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { mkdtempSync, cpSync } from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { checkSpecCoverage } from "../src/check-spec-coverage.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

function iso() { const d = mkdtempSync(path.join(tmpdir(), "h-")); cpSync(FIXTURE_SRC, d, { recursive: true }); return d; }

describe("checkSpecCoverage", () => {
  it("passes when no protected paths changed", () => {
    const ctx = createHarnessContext({ repoRoot: iso() });
    const r = checkSpecCoverage(ctx, { changedFiles: ["src/App.jsx"], isPullRequest: true, body: "", actor: "human" });
    expect(r.ok).toBe(true);
  });

  it("passes when a covering spec exists for a changed protected file", () => {
    const ctx = createHarnessContext({ repoRoot: iso() });
    const r = checkSpecCoverage(ctx, { changedFiles: ["CLAUDE.md"], isPullRequest: true, body: "## Spec ID\nexample-spec\n", actor: "human" });
    expect(r.ok).toBe(true);
  });

  it("emits COVERAGE_UNCOVERED when protected path changes with no covering spec and no rationale", () => {
    const ctx = createHarnessContext({ repoRoot: iso() });
    const r = checkSpecCoverage(ctx, { changedFiles: [".github/workflows/ci.yml"], isPullRequest: true, body: "", actor: "human" });
    expect(r.ok).toBe(false);
    for (const err of r.errors) expect(err).toBeInstanceOf(ValidationError);
    expect(r.errors.some((e) => e.code === ERROR_CODES.COVERAGE_UNCOVERED)).toBe(true);
    expect(r.errors.some((e) => /without an approved/.test(e))).toBe(true);
  });

  it("passes when No-spec rationale is provided", () => {
    const ctx = createHarnessContext({ repoRoot: iso() });
    const r = checkSpecCoverage(ctx, { changedFiles: [".github/workflows/ci.yml"], isPullRequest: true, body: "## No-spec rationale\ntrivial config change\n", actor: "human" });
    expect(r.ok).toBe(true);
  });

  it("bypasses body contract for known bot actors", () => {
    const ctx = createHarnessContext({ repoRoot: iso() });
    const r = checkSpecCoverage(ctx, { changedFiles: [".github/workflows/ci.yml"], isPullRequest: true, body: "", actor: "dependabot[bot]" });
    expect(r.ok).toBe(true);
  });

  it("emits COVERAGE_UNKNOWN_SPEC_ID when PR body references an unknown Spec ID", () => {
    const ctx = createHarnessContext({ repoRoot: iso() });
    const r = checkSpecCoverage(ctx, { changedFiles: [], isPullRequest: true, body: "## Spec ID\nnonexistent-spec\n", actor: "human" });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toBeInstanceOf(ValidationError);
    expect(r.errors[0].code).toBe(ERROR_CODES.COVERAGE_UNKNOWN_SPEC_ID);
    expect(r.errors[0].message).toMatch(/unknown Spec ID/);
  });
});
