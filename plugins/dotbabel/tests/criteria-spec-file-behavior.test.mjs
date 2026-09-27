// `criteria/spec-file.mjs` had zero dedicated tests before this file — its
// 43.24% baseline mutation score came entirely from incidental coverage in
// higher-level suites (criteria-list.test.mjs, verifyCriteria tests) that
// only ever exercise readCriteriaSpec's happy path with a valid, in-repo,
// non-symlinked spec. This file drives the function directly.
//
// Three mutants are documented as genuinely equivalent rather than chased,
// each confirmed empirically (scratchpad probes / differential scripts),
// not by inspection:
//   - 23:15-17 (ArrayDeclaration, `[]` -> `["Stryker was here"]`) and
//     29:7-30 (ConditionalExpression, the unknown-spec `if` -> `false`):
//     both mutants can only change behavior on a specId that is NOT in
//     `known`, and for every such specId the function reaches the SAME
//     `throw specError(specId)` call — either directly (line 29) or by
//     falling through to the lstat catch (line 39) once the nonexistent
//     spec directory fails to stat — and `specError`'s default message is
//     identical either way: `unknown spec: ${specId}`. A differential run
//     of the real function against a hand-mutated copy over 7 probes
//     (missing docs/specs, a docs/specs that excludes the target, and
//     edge-case ids including the literal mutant string) found zero
//     observable difference in the thrown `{ code, message }` for either
//     mutant.
//   - 51:47-53 (StringLiteral, `"utf8"` -> `""`): `fs.readFileSync(f, "")`
//     returns a Buffer (empty string is not a recognized encoding), and
//     `JSON.parse(buffer)` coerces it via `Buffer.prototype.toString()`,
//     which itself defaults to utf8 — the same decoding `"utf8"` requests
//     explicitly. The two are observably identical for every input.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCriteriaSpec } from "../src/criteria/spec-file.mjs";
import { ERROR_CODES } from "../src/lib/errors.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function tmpRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spec-file-behavior-"));
  dirs.push(repoRoot);
  return repoRoot;
}

/** A repo whose docs/specs/<specId>/spec.json is a real file with real JSON. */
function repoWithSpec(specId, content = { id: specId, acceptance_criteria: [] }) {
  const repoRoot = tmpRepo();
  const specDir = path.join(repoRoot, "docs", "specs", specId);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "spec.json"), JSON.stringify(content));
  return { repoRoot, specDir, ctx: { repoRoot, specsRoot: path.join(repoRoot, "docs", "specs") } };
}

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected readCriteriaSpec to throw");
}

describe("readCriteriaSpec", () => {
  it("returns the parsed spec.json for a real, known, in-repo spec", () => {
    const { ctx } = repoWithSpec("example", { id: "example", acceptance_criteria: [{ id: "AC-1" }] });
    expect(readCriteriaSpec(ctx, "example")).toEqual({ id: "example", acceptance_criteria: [{ id: "AC-1" }] });
  });

  it("tags every thrown error with category criteria", () => {
    const { ctx } = repoWithSpec("example");
    const error = thrown(() => readCriteriaSpec(ctx, "nonexistent"));
    expect(error.category).toBe("criteria");
  });

  it("throws CRITERIA_UNKNOWN_SPEC naming the id when docs/specs exists but does not list it", () => {
    const { ctx } = repoWithSpec("example");
    const error = thrown(() => readCriteriaSpec(ctx, "nonexistent"));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
    expect(error.message).toBe("unknown spec: nonexistent");
  });

  it("propagates a non-ENOENT error from listing docs/specs, rather than treating it as an unknown spec", () => {
    const repoRoot = tmpRepo();
    // docs/specs is a FILE, not a directory: readdirSync throws ENOTDIR,
    // which the code's `error?.code !== "ENOENT"` guard must rethrow.
    fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "docs", "specs"), "not a directory");
    const ctx = { repoRoot, specsRoot: path.join(repoRoot, "docs", "specs") };
    const error = thrown(() => readCriteriaSpec(ctx, "example"));
    expect(error.code).toBe("ENOTDIR");
    expect(error).not.toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
  });

  it("throws CRITERIA_UNKNOWN_SPEC, not a raw ENOENT, when docs/specs itself does not exist", () => {
    const repoRoot = tmpRepo();
    // docs/specs was never created: readdirSync throws ENOENT, which must be
    // swallowed (not rethrown) so the function falls through to the
    // unknown-spec path instead of crashing on a repo with no specs yet.
    const ctx = { repoRoot, specsRoot: path.join(repoRoot, "docs", "specs") };
    const error = thrown(() => readCriteriaSpec(ctx, "example"));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
    expect(error.message).toBe("unknown spec: example");
  });

  it("throws CRITERIA_UNKNOWN_SPEC when the spec directory is listed but has no spec.json", () => {
    const repoRoot = tmpRepo();
    // The directory exists (so listSpecDirs finds it and known.includes
    // passes), but spec.json inside it was never written.
    fs.mkdirSync(path.join(repoRoot, "docs", "specs", "example"), { recursive: true });
    const ctx = { repoRoot, specsRoot: path.join(repoRoot, "docs", "specs") };
    const error = thrown(() => readCriteriaSpec(ctx, "example"));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
    expect(error.message).toBe("unknown spec: example");
  });

  it("rejects a spec.json that is a symbolic link, even though the spec directory itself is not", () => {
    const { repoRoot, specDir, ctx } = repoWithSpec("example");
    const realFile = path.join(specDir, "spec.json");
    const linkTarget = path.join(repoRoot, "real-payload.json");
    fs.renameSync(realFile, linkTarget);
    fs.symlinkSync(linkTarget, realFile);
    // dirStat.isSymbolicLink() is false here and fileStat.isSymbolicLink()
    // is true — an `&&` in place of the real `||` would let this through.
    const error = thrown(() => readCriteriaSpec(ctx, "example"));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
    expect(error.message).toBe("spec example uses a symbolic link for its directory or spec.json");
  });

  it("rejects a spec.json path that resolves to a directory, not a file", () => {
    const { specDir, ctx } = repoWithSpec("example");
    fs.rmSync(path.join(specDir, "spec.json"));
    fs.mkdirSync(path.join(specDir, "spec.json"));
    // dirStat.isDirectory() is true and fileStat.isFile() is false — an
    // `&&` in place of the real `||` would let this through, since neither
    // half alone is false-and-false.
    const error = thrown(() => readCriteriaSpec(ctx, "example"));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
    expect(error.message).toBe("unknown spec: example");
  });

  it("rethrows exactly what listSpecDirs threw, even when that value has no .code property to read", async () => {
    // `error?.code` and `error.code` agree for every real thrown Error, so no
    // fixture built on a genuine listSpecDirs failure can distinguish them.
    // Only a non-Error throw (impossible from a real fs call, but not
    // impossible in general) tells them apart: `error.code` on `undefined`
    // throws a TypeError from inside the catch block itself, while
    // `error?.code` short-circuits to `undefined` and rethrows the original
    // value unchanged.
    vi.resetModules();
    vi.doMock("../src/spec-harness-lib.mjs", () => ({
      listSpecDirs: () => {
        throw undefined;
      },
    }));
    const { readCriteriaSpec: mockedReadCriteriaSpec } = await import("../src/criteria/spec-file.mjs");
    let caught = "not-thrown";
    try {
      mockedReadCriteriaSpec({ repoRoot: "/tmp/does-not-matter", specsRoot: "/tmp/does-not-matter/docs/specs" }, "example");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUndefined();
    vi.doUnmock("../src/spec-harness-lib.mjs");
    vi.resetModules();
  });

  it("rejects a spec.json that resolves outside the repository, even when nothing lstats as a symlink", () => {
    const repoRoot = tmpRepo();
    const specsRoot = tmpRepo(); // a wholly separate directory, not under repoRoot
    fs.mkdirSync(path.join(specsRoot, "example"), { recursive: true });
    fs.writeFileSync(path.join(specsRoot, "example", "spec.json"), JSON.stringify({ id: "example" }));
    const ctx = { repoRoot, specsRoot };
    const error = thrown(() => readCriteriaSpec(ctx, "example"));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
    expect(error.message).toBe("spec example resolves outside the repository");
  });
});
