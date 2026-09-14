import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function writeSpec(dir, criteria) {
  const specDir = path.join(dir, "docs", "specs", "example");
  fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(path.join(specDir, "spec.json"), JSON.stringify({ id: "example", acceptance_criteria: criteria }));
}

function commit(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Real git runs in the fixture repository; `gh pr view` and `gh api` answer from fakes. */
function fakeDeps(dir, { prView, gh = {} }) {
  return {
    capture(cmd) {
      if (cmd.startsWith("gh pr view")) return JSON.stringify(prView);
      if (cmd.startsWith("gh api")) {
        for (const [pattern, value] of Object.entries(gh)) {
          if (new RegExp(pattern).test(cmd)) return value;
        }
        throw new Error(`no fake gh response for: ${cmd}`);
      }
      return execFileSync(cmd, { cwd: dir, encoding: "utf8", shell: true }).trim();
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
  return { repoRoot: dir, pr: 7, repo: "o/r", allowProjectCommands: false, trustedAssociations: ["OWNER"], env: TRUST_ALL, ...overrides };
}

describe("checkPrPreconditions", () => {
  it("throws CRITERIA_TRUST_REQUIRED when the repository is untrusted and allowProjectCommands is false", () => {
    const { dir, head } = cleanRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false } });
    expect(thrown(() => checkPrPreconditions(deps, args(dir, { env: untrustedEnv(dir) })))).toMatchObject({ code: ERROR_CODES.CRITERIA_TRUST_REQUIRED });
  });

  it("returns the head, base, fork flag, and an empty body when every precondition passes", () => {
    const { dir, head } = cleanRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false } });
    expect(checkPrPreconditions(deps, args(dir))).toEqual({ headSha: head, baseSha: head, prHeadSha: head, isCrossRepository: false, body: "" });
  });

  it("ignores uncommitted changes under .dotbabel/ when it checks the worktree", () => {
    const { dir, head } = cleanRepo();
    fs.mkdirSync(path.join(dir, ".dotbabel"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".dotbabel", "report.xml"), "<testsuites/>");
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false } });
    expect(checkPrPreconditions(deps, args(dir)).headSha).toBe(head);
  });

  it("throws CRITERIA_WORKTREE_DIRTY for an uncommitted change outside .dotbabel/", () => {
    const { dir, head } = cleanRepo();
    fs.writeFileSync(path.join(dir, "stray.txt"), "x");
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: false } });
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_WORKTREE_DIRTY });
    expect(error.message).toContain("stray.txt");
  });

  it("throws CRITERIA_HEAD_MISMATCH when local HEAD differs from the pull request head", () => {
    const { dir, head } = cleanRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: "f".repeat(40), baseRefOid: head, isCrossRepository: false } });
    expect(thrown(() => checkPrPreconditions(deps, args(dir)))).toMatchObject({ code: ERROR_CODES.CRITERIA_HEAD_MISMATCH });
  });

  it("throws CRITERIA_FORK_PR for a pull request from a fork", () => {
    const { dir, head } = cleanRepo();
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: head, isCrossRepository: true } });
    expect(thrown(() => checkPrPreconditions(deps, args(dir)))).toMatchObject({ code: ERROR_CODES.CRITERIA_FORK_PR });
  });

  it("allows a fork and an untrusted argv change when allowProjectCommands is set", () => {
    const { dir, base, head } = argvChangeRepo();
    // Without fake gh responses the argv check would report this change as
    // untrusted, so a returned result proves the check did not run.
    const deps = fakeDeps(dir, { prView: { headRefOid: head, baseRefOid: base, isCrossRepository: true, body: "## Spec ID\n\nexample" } });
    const result = checkPrPreconditions(deps, args(dir, { allowProjectCommands: true, env: untrustedEnv(dir) }));
    expect(result).toEqual({ headSha: head, baseSha: base, prHeadSha: head, isCrossRepository: true, body: "## Spec ID\n\nexample" });
  });

  it("throws CRITERIA_UNTRUSTED_ARGV_CHANGE naming the criterion, the commit, and the author", () => {
    const { dir, base, head } = argvChangeRepo();
    const deps = fakeDeps(dir, {
      prView: { headRefOid: head, baseRefOid: base, isCrossRepository: false },
      gh: { "commits/[0-9a-f]+ --jq \\.author\\.login": "outside-contributor", "collaborators/outside-contributor/permission": "READ" },
    });
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
    expect(error.message).toContain("AC-1");
    expect(error.message).toContain(head.slice(0, 8));
    expect(error.message).toContain("outside-contributor");
  });

  it("names the author as unattributable when GitHub has no login for the commit", () => {
    const { dir, base, head } = argvChangeRepo();
    const deps = fakeDeps(dir, {
      prView: { headRefOid: head, baseRefOid: base, isCrossRepository: false },
      gh: { "commits/[0-9a-f]+ --jq \\.author\\.login": "null" },
    });
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
    expect(error.message).toContain("(unattributable)");
  });
});
