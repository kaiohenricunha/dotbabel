import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import { checkPrPreconditions } from "../src/criteria/preconditions.mjs";
import { ERROR_CODES } from "../src/lib/errors.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "criteria-preconditions-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

function writeSpec(dir, criteria, specId = "example") {
  const specDir = path.join(dir, "docs", "specs", specId);
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "spec.json"), JSON.stringify({ id: specId, acceptance_criteria: criteria }));
}

function commit(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

const DEFAULT_CONFIG = { pass_env: [], timeout_seconds: 600, enforcement: "block", trusted_associations: ["OWNER"], require_ci_check: false };
const BODY = "## Spec ID\n\nexample\n";

/**
 * Real git runs in the fixture repository with argument arrays. `gh pr view`
 * and the pull request association lookup answer from fakes. Pass an Error as
 * `association` to make that lookup fail.
 */
function fakeDeps(dir, { prView, association = "OWNER", calls = [] }) {
  return {
    capture(argv) {
      calls.push(argv);
      if (!Array.isArray(argv)) throw new Error(`expected an argument array, got ${JSON.stringify(argv)}`);
      if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view") return JSON.stringify(prView);
      if (argv[0] === "gh" && argv[1] === "api" && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(argv[2])) {
        if (association instanceof Error) throw association;
        return association;
      }
      if (argv[0] === "git") return execFileSync("git", argv.slice(1), { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      throw new Error(`no fake response for: ${argv.join(" ")}`);
    },
  };
}

// Tests never read the user's real trust allowlist: trust comes from env only.
const TRUST_ALL = { CHECK_ON_STOP_TRUST_ALL: "1" };

function untrustedEnv(dir) {
  return { CHECK_ON_STOP_TRUSTED_FILE: path.join(dir, "no-such-trust-file") };
}

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected checkPrPreconditions to throw");
}

function cleanRepo() {
  const dir = initRepo();
  writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
  const head = commit(dir, "base");
  return { dir, head };
}

function argvChangeRepo() {
  const dir = initRepo();
  writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
  const base = commit(dir, "base");
  writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["b"] }]);
  const head = commit(dir, "change argv");
  return { dir, base, head };
}

function args(dir, overrides = {}) {
  return { ctx: createHarnessContext({ repoRoot: dir }), pr: 7, repo: "o/r", allowProjectCommands: false, env: TRUST_ALL, ...overrides };
}

describe("checkPrPreconditions", () => {
  it("throws CRITERIA_TRUST_REQUIRED when the repository is untrusted and allowProjectCommands is false", () => {
    const { dir, head } = cleanRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY } });
    expect(thrown(() => checkPrPreconditions(deps, args(dir, { env: untrustedEnv(dir) })))).toMatchObject({ code: ERROR_CODES.CRITERIA_TRUST_REQUIRED });
  });

  it("returns the head, base, fork flag, linked spec ids, and the base config when every precondition passes", () => {
    const { dir, head } = cleanRepo();
    const calls = [];
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY }, calls });
    expect(checkPrPreconditions(deps, args(dir))).toEqual({ headSha: head, baseSha: head, isCrossRepository: false, specIds: ["example"], config: DEFAULT_CONFIG });
    expect(calls.every((argv) => Array.isArray(argv))).toBe(true);
  });

  it("ignores uncommitted changes under .dotbabel/ when it checks the worktree", () => {
    const { dir, head } = cleanRepo();
    fs.mkdirSync(path.join(dir, ".dotbabel"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".dotbabel", "report.xml"), "<testsuites/>");
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY } });
    expect(checkPrPreconditions(deps, args(dir)).headSha).toBe(head);
  });

  it("throws CRITERIA_WORKTREE_DIRTY for an uncommitted change outside .dotbabel/", () => {
    const { dir, head } = cleanRepo();
    fs.writeFileSync(path.join(dir, "stray.txt"), "x");
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY } });
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_WORKTREE_DIRTY });
    expect(error.message).toContain("stray.txt");
  });

  it("throws CRITERIA_HEAD_MISMATCH when local HEAD differs from the pull request head", () => {
    const { dir, head } = cleanRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: "f".repeat(40), baseRefOid: head, isCrossRepository: false, body: BODY } });
    expect(thrown(() => checkPrPreconditions(deps, args(dir)))).toMatchObject({ code: ERROR_CODES.CRITERIA_HEAD_MISMATCH });
  });

  it("throws CRITERIA_FORK_PR for a pull request from a fork", () => {
    const { dir, head } = cleanRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: true, body: BODY } });
    expect(thrown(() => checkPrPreconditions(deps, args(dir)))).toMatchObject({ code: ERROR_CODES.CRITERIA_FORK_PR });
  });

  it("throws CRITERIA_UNKNOWN_SPEC for a Spec ID that is not a directory under docs/specs/", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }]);
    fs.mkdirSync(path.join(dir, "evil"), { recursive: true });
    fs.writeFileSync(path.join(dir, "evil", "spec.json"), JSON.stringify({ id: "evil", acceptance_criteria: [{ id: "AC-1", argv: ["x"] }] }));
    const head = commit(dir, "base");
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false, body: "## Spec ID\n\n../../evil\n" } });
    expect(thrown(() => checkPrPreconditions(deps, args(dir)))).toMatchObject({ code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC });
  });

  it("removes quoted and duplicate Spec IDs before it validates them", () => {
    const { dir, head } = cleanRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false, body: '## Spec ID\n\n"example", example\n' } });
    expect(checkPrPreconditions(deps, args(dir)).specIds).toEqual(["example"]);
  });

  it("throws CRITERIA_UNTRUSTED_ARGV_CHANGE naming the spec, the criterion, and the association", () => {
    const { dir, base, head } = argvChangeRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: base, isCrossRepository: false, body: BODY }, association: "CONTRIBUTOR" });
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
    expect(error.message).toContain("AC-1");
    expect(error.message).toContain("docs/specs/example/spec.json");
    expect(error.message).toContain("CONTRIBUTOR");
  });

  it("fails closed when the pull request association lookup fails", () => {
    const { dir, base, head } = argvChangeRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: base, isCrossRepository: false, body: BODY }, association: new Error("gh failed") });
    expect(thrown(() => checkPrPreconditions(deps, args(dir)))).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
  });

  it("judges trust with trusted_associations from the base commit, not the head", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }]);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", argv: ["b"] }]);
    fs.writeFileSync(path.join(dir, ".dotbabel.json"), JSON.stringify({ criteria: { trusted_associations: ["OWNER", "CONTRIBUTOR"] } }));
    const head = commit(dir, "change argv and widen trust");
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: base, isCrossRepository: false, body: BODY }, association: "CONTRIBUTOR" });
    expect(thrown(() => checkPrPreconditions(deps, args(dir)))).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
  });

  it("returns the criteria config from the base commit even when the head changes it", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }]);
    fs.writeFileSync(path.join(dir, ".dotbabel.json"), JSON.stringify({ criteria: { timeout_seconds: 120 } }));
    const base = commit(dir, "base");
    fs.writeFileSync(path.join(dir, ".dotbabel.json"), JSON.stringify({ criteria: { timeout_seconds: 30, pass_env: ["SECRET"] } }));
    const head = commit(dir, "change config");
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: base, isCrossRepository: false, body: BODY } });
    expect(checkPrPreconditions(deps, args(dir)).config).toEqual({ ...DEFAULT_CONFIG, timeout_seconds: 120 });
  });

  it("allows a fork and an untrusted argv change when allowProjectCommands is set, without looking up the association", () => {
    const { dir, base, head } = argvChangeRepo();
    const calls = [];
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: base, isCrossRepository: true, body: BODY }, association: new Error("must not be looked up"), calls });
    const result = checkPrPreconditions(deps, args(dir, { allowProjectCommands: true, env: untrustedEnv(dir) }));
    expect(result).toEqual({ headSha: head, baseSha: base, isCrossRepository: true, specIds: ["example"], config: DEFAULT_CONFIG });
    expect(calls.some((argv) => argv[0] === "gh" && argv[1] === "api")).toBe(false);
  });
});
