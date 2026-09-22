// Additive boundary tests for `criteria/preconditions.mjs`, written to close
// the gap between its shipped test file and the TEST-1 mutation-score floor
// (baseline 78.13%, 128 mutants / 28 non-killed). Every test here pins an
// exact behavior a Stryker mutant on the source exposed as unverified; none
// of them duplicate `criteria-preconditions.test.mjs`'s existing coverage.
//
// Three mutants are documented as genuinely equivalent rather than chased:
//   - 77:13-79:6 (BlockStatement): the catch body's `prAssociation = null;`
//     is redundant — `let prAssociation = null;` on line 73 already sets it,
//     and the catch only runs when the try block threw *before* line 76's
//     reassignment, so the value is unchanged either way.
//   - 43:37-46 (Regex, `^` anchor removed): proven equivalent by differential
//     testing (scratchpad/equiv-preconditions-regex.mjs) — when the anchor
//     is dropped, any leading whitespace the anchored regex would have left
//     untouched is *also* left untouched by the unanchored one (a leading
//     whitespace character is never `\S`, so neither regex's `\S+` can start
//     consuming from position 0 in that case), so the two regexes always
//     agree on the one thing downstream code reads: whether the replaced
//     string starts with ".dotbabel/".
//   - 60:54-56 (StringLiteral, the `?? ""` fallback replaced with "Stryker
//     was here!"): `prJson.body` feeds exactly one call, `parseSpecIds`,
//     which returns `[]` for any string without a "## Spec ID" heading —
//     both fallback strings lack one, so both fallbacks produce the
//     identical observable `specIds: []`. Confirmed directly: `parseSpecIds("")`
//     and `parseSpecIds("Stryker was here!")` both return `[]`.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "criteria-preconditions-behavior-"));
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

const BODY = "## Spec ID\n\nexample\n";
const TRUST_ALL = { CHECK_ON_STOP_TRUST_ALL: "1" };

function args(dir, overrides = {}) {
  return { ctx: createHarnessContext({ repoRoot: dir }), pr: 7, repo: "o/r", allowProjectCommands: false, env: TRUST_ALL, ...overrides };
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

/**
 * Same shape as the shipped test file's `fakeDeps`, but every call is
 * intercepted explicitly (no shared default) so each test's synthetic
 * `git status`/`git ls-tree`/`gh api` answers are visible at the call site
 * rather than hidden behind a helper's defaults.
 */
function customDeps(dir, overrides) {
  return {
    capture(argv) {
      for (const [match, respond] of overrides) {
        if (match(argv)) return respond(argv);
      }
      if (argv[0] === "git") return execFileSync("git", argv.slice(1), { cwd: dir, encoding: "utf8" }).trim();
      throw new Error(`no fake response for: ${argv.join(" ")}`);
    },
  };
}

const isGhPrView = (argv) => argv[0] === "gh" && argv[1] === "pr" && argv[2] === "view";
const isGhApiAssociation = (argv) => argv[0] === "gh" && argv[1] === "api" && /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(argv[2]);
const isGitStatus = (argv) => argv[0] === "git" && argv[1] === "status";
const isGitRevParseHead = (argv) => argv[0] === "git" && argv[1] === "rev-parse" && argv[2] === "HEAD";
const isGitLsTree = (argv) => argv[0] === "git" && argv[1] === "ls-tree";

function prViewResponder(prView) {
  return () => JSON.stringify(prView);
}

describe("checkPrPreconditions — additional boundaries", () => {
  it("tags every thrown precondition error with category criteria", () => {
    const { dir, head } = cleanRepo();
    fs.writeFileSync(path.join(dir, "stray.txt"), "x");
    const deps = customDeps(dir, [[isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })]]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error.category).toBe("criteria");
  });

  it("treats a missing pull request body as linking no specs, rather than throwing", () => {
    const { dir, head } = cleanRepo();
    // JSON.stringify drops an `undefined` property, so this reproduces a
    // real `gh pr view --json ...body` response for a PR with no body.
    const deps = customDeps(dir, [[isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: undefined })]]);
    expect(checkPrPreconditions(deps, args(dir)).specIds).toEqual([]);
  });

  it("does not exempt a directory that merely ends in .dotbabel/ from the dirty-worktree check", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    fs.mkdirSync(path.join(dir, "nested"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", "tracked.txt"), "x");
    const head = commit(dir, "base with a tracked nested directory");
    fs.mkdirSync(path.join(dir, "nested", ".dotbabel"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nested", ".dotbabel", "junk.txt"), "x");
    const deps = customDeps(dir, [[isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })]]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_WORKTREE_DIRTY });
    expect(error.message).toContain("nested/.dotbabel/");
  });

  it("does not exempt a .dotbabel/ change whose status code is separated from the path by more than one space", () => {
    // "M  " (two spaces) is the real porcelain format for an index-only
    // change — `git status --porcelain=v1` always separates the two-letter
    // XY code from the path with exactly one space, and a staged-only
    // modification's XY is "M " (M + a literal space), so the line reads
    // "M  path" (M, space, space, path). The prefix-stripping regex must
    // consume both spaces, not just one, to reach ".dotbabel/".
    const { dir, head } = cleanRepo();
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })],
      [isGitStatus, () => "M  .dotbabel/report.xml"],
    ]);
    expect(checkPrPreconditions(deps, args(dir)).headSha).toBe(head);
  });

  it("filters out a status line that is nothing but whitespace, rather than treating it as a dirty entry", () => {
    const { dir, head } = cleanRepo();
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })],
      [isGitStatus, () => "   "],
    ]);
    expect(checkPrPreconditions(deps, args(dir)).headSha).toBe(head);
  });

  it("separates each entry in the CRITERIA_WORKTREE_DIRTY message onto its own line", () => {
    const { dir, head } = cleanRepo();
    fs.writeFileSync(path.join(dir, "stray1.txt"), "x");
    fs.writeFileSync(path.join(dir, "stray2.txt"), "x");
    const deps = customDeps(dir, [[isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })]]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_WORKTREE_DIRTY });
    // Header line + one line per dirty entry. If the entries were joined
    // with "" instead of "\n" they would collapse onto the header's line.
    expect(error.message.split("\n")).toHaveLength(3);
  });

  it("shows only the first 8 hex characters of each sha in the head-mismatch message", () => {
    const { dir, head } = cleanRepo();
    const otherHead = "f".repeat(40);
    const deps = customDeps(dir, [[isGhPrView, prViewResponder({ headRefOid: otherHead, baseRefOid: head, isCrossRepository: false, body: BODY })]]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_HEAD_MISMATCH });
    expect(error.message).toBe(`local HEAD (${head.slice(0, 8)}) differs from PR #7 head (${otherHead.slice(0, 8)})`);
  });

  it("trims the local HEAD sha before comparing it to the pull request head", () => {
    const { dir, head } = cleanRepo();
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })],
      // Raw, untrimmed — a real `git rev-parse HEAD` also ends in "\n".
      [isGitRevParseHead, () => `${head}\n`],
    ]);
    expect(checkPrPreconditions(deps, args(dir)).headSha).toBe(head);
  });

  it("passes the exact argv for the gh pr view and gh api association lookups", () => {
    const { dir, head } = cleanRepo();
    const calls = [];
    const deps = customDeps(dir, [
      [isGhPrView, (argv) => { calls.push(argv); return JSON.stringify({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY }); }],
      [isGhApiAssociation, (argv) => { calls.push(argv); return "OWNER"; }],
    ]);
    checkPrPreconditions(deps, args(dir));
    expect(calls).toContainEqual(["gh", "pr", "view", "7", "--json", "headRefOid,baseRefOid,isCrossRepository,body"]);
    expect(calls).toContainEqual(["gh", "api", "repos/o/r/pulls/7", "--jq", ".author_association"]);
  });

  it("finds the base .dotbabel.json with some rather than every, when the ls-tree pathspec listing has other lines", () => {
    // The real `git ls-tree ... -- .dotbabel.json` pathspec can only ever
    // return that one path or nothing, so `.some` and `.every` agree on
    // real output. This synthesizes a multi-line answer to pin the intent
    // (find any matching line) rather than the incidental real-world shape.
    const { dir, head } = cleanRepo();
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })],
      [isGitLsTree, () => "unrelated-noise-line\n.dotbabel.json"],
      [(argv) => argv[0] === "git" && argv[1] === "show" && argv[2] === `${head}:.dotbabel.json`, () => JSON.stringify({ criteria: { timeout_seconds: 42 } })],
    ]);
    expect(checkPrPreconditions(deps, args(dir)).config.timeout_seconds).toBe(42);
  });

  it("trims whitespace around an ls-tree line before matching it against the config filename", () => {
    const { dir, head } = cleanRepo();
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })],
      [isGitLsTree, () => "  .dotbabel.json  "],
      [(argv) => argv[0] === "git" && argv[1] === "show" && argv[2] === `${head}:.dotbabel.json`, () => JSON.stringify({ criteria: { timeout_seconds: 42 } })],
    ]);
    expect(checkPrPreconditions(deps, args(dir)).config.timeout_seconds).toBe(42);
  });

  it("names the base commit and file in the config error when the base .dotbabel.json is invalid JSON", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    fs.writeFileSync(path.join(dir, ".dotbabel.json"), "{ not json");
    const head = commit(dir, "base with broken config");
    const deps = customDeps(dir, [[isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: head, isCrossRepository: false, body: BODY })]]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_CONFIG_INVALID });
    expect(error.message).toContain(`${head}:.dotbabel.json`);
  });

  it("reports the association as (unavailable), not blank or NULL, when the raw answer is an empty string", () => {
    const { dir, base, head } = argvChangeRepo();
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: base, isCrossRepository: false, body: BODY })],
      [isGhApiAssociation, () => ""],
    ]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
    expect(error.message).toContain("association (unavailable)");
  });

  it("reports the association as (unavailable), not the literal string NULL, when the raw answer is the text null", () => {
    const { dir, base, head } = argvChangeRepo();
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: base, isCrossRepository: false, body: BODY })],
      [isGhApiAssociation, () => "null"],
    ]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
    expect(error.message).toContain("association (unavailable)");
    expect(error.message).not.toContain("NULL");
  });

  it("trims the raw pull request association before comparing it to the empty and null sentinels", () => {
    const { dir, base, head } = argvChangeRepo();
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: base, isCrossRepository: false, body: BODY })],
      // A single space is neither "" nor "null" until trimmed, so an
      // untrimmed comparison falls through to `raw.toUpperCase()` and the
      // association reads as a literal space instead of unavailable.
      [isGhApiAssociation, () => " "],
    ]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
    expect(error.message).toContain("association (unavailable)");
  });

  it("names the subject as executable criteria, not a criterion's argv, when the head spec fails to parse", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", status: "active", argv: ["a"] }]);
    const base = commit(dir, "base");
    fs.writeFileSync(path.join(dir, "docs", "specs", "example", "spec.json"), "{ not json");
    const head = commit(dir, "break spec json at head");
    const deps = customDeps(dir, [
      [isGhPrView, prViewResponder({ headRefOid: head, baseRefOid: base, isCrossRepository: false, body: BODY })],
      [isGhApiAssociation, () => "CONTRIBUTOR"],
    ]);
    const error = thrown(() => checkPrPreconditions(deps, args(dir)));
    expect(error).toMatchObject({ code: ERROR_CODES.CRITERIA_UNTRUSTED_ARGV_CHANGE });
    expect(error.message).toContain("executable criteria");
    expect(error.message).not.toContain("'s argv");
  });
});
