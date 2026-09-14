import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findUntrustedArgvChange } from "../src/criteria/trust-check.mjs";

const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trust-check-"));
  dirs.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

function specFile(dir, specId = "example") {
  return path.join(dir, "docs", "specs", specId, "spec.json");
}

function writeSpec(dir, criteria, specId = "example") {
  fs.mkdirSync(path.dirname(specFile(dir, specId)), { recursive: true });
  fs.writeFileSync(specFile(dir, specId), JSON.stringify({ id: specId, acceptance_criteria: criteria }));
}

function commit(dir, message) {
  git(dir, ["add", "-A"]);
  git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** A capture() that runs git with an argument array in the fixture repository and records each call. */
function gitDeps(dir, calls) {
  return {
    capture(argv) {
      calls.push(argv);
      if (!Array.isArray(argv) || argv[0] !== "git") throw new Error(`unexpected command: ${JSON.stringify(argv)}`);
      return execFileSync("git", argv.slice(1), { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    },
  };
}

function check(dir, { base, head, specIds = ["example"], prAssociation = "CONTRIBUTOR", trustedAssociations = ["OWNER"], calls = [] }) {
  return findUntrustedArgvChange(gitDeps(dir, calls), { baseSha: base, headSha: head, specIds, prAssociation, trustedAssociations });
}

function repoWithChange(before, after) {
  const dir = initRepo();
  writeSpec(dir, before);
  const base = commit(dir, "base");
  writeSpec(dir, after);
  const head = commit(dir, "head");
  return { dir, base, head };
}

const SPEC_PATH = "docs/specs/example/spec.json";

describe("findUntrustedArgvChange", () => {
  it("returns null without reading git when the pull request author is trusted", () => {
    const { dir, base, head } = repoWithChange([{ id: "AC-1", status: "active", argv: ["a"] }], [{ id: "AC-1", status: "active", argv: ["b"] }]);
    const calls = [];
    expect(check(dir, { base, head, prAssociation: "OWNER", calls })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("flags an active criterion whose argv changed when the pull request author is not trusted", () => {
    const { dir, base, head } = repoWithChange([{ id: "AC-1", status: "active", argv: ["a"] }], [{ id: "AC-1", status: "active", argv: ["b"] }]);
    expect(check(dir, { base, head })).toEqual({ specId: "example", specPath: SPEC_PATH, criterionId: "AC-1", reason: "argv changed" });
  });

  it("treats a criterion without a status field as active", () => {
    const { dir, base, head } = repoWithChange([{ id: "AC-1", argv: ["a"] }], [{ id: "AC-1", argv: ["b"] }]);
    expect(check(dir, { base, head })).toEqual({ specId: "example", specPath: SPEC_PATH, criterionId: "AC-1", reason: "argv changed" });
  });

  it("treats an absent pull request association as untrusted", () => {
    const { dir, base, head } = repoWithChange([{ id: "AC-1", argv: ["a"] }], [{ id: "AC-1", argv: ["b"] }]);
    expect(check(dir, { base, head, prAssociation: null })).toMatchObject({ criterionId: "AC-1", reason: "argv changed" });
  });

  it("flags a new active criterion that does not exist at the base", () => {
    const { dir, base, head } = repoWithChange([{ id: "AC-1", argv: ["a"] }], [{ id: "AC-1", argv: ["a"] }, { id: "AC-2", argv: ["c"] }]);
    expect(check(dir, { base, head })).toEqual({ specId: "example", specPath: SPEC_PATH, criterionId: "AC-2", reason: "new active criterion" });
  });

  it("flags every active criterion of a spec that does not exist at the base", () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, "README"), "x");
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }]);
    const head = commit(dir, "add spec");
    expect(check(dir, { base, head })).toEqual({ specId: "example", specPath: SPEC_PATH, criterionId: "AC-1", reason: "new active criterion" });
  });

  it("flags a planned criterion promoted to active even when its argv is the same", () => {
    const { dir, base, head } = repoWithChange([{ id: "AC-1", status: "planned", argv: ["a"] }], [{ id: "AC-1", status: "active", argv: ["a"] }]);
    expect(check(dir, { base, head })).toEqual({ specId: "example", specPath: SPEC_PATH, criterionId: "AC-1", reason: "new active criterion" });
  });

  it("returns null when only a planned criterion's argv changed", () => {
    const { dir, base, head } = repoWithChange([{ id: "AC-1", status: "planned", argv: ["a"] }], [{ id: "AC-1", status: "planned", argv: ["b"] }]);
    expect(check(dir, { base, head })).toBeNull();
  });

  it("returns null when an active criterion's argv is unchanged even though the spec file changed", () => {
    const { dir, base, head } = repoWithChange([{ id: "AC-1", argv: ["a"], given: "g1" }], [{ id: "AC-1", argv: ["a"], given: "g2 — only prose changed" }]);
    expect(check(dir, { base, head })).toBeNull();
  });

  it("inspects only the linked spec ids", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }]);
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }], "other");
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", argv: ["b"] }], "other");
    const head = commit(dir, "change the unlinked spec");
    expect(check(dir, { base, head, specIds: ["example"] })).toBeNull();
  });

  it("fails closed when spec.json does not parse at the head", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }]);
    const base = commit(dir, "base");
    fs.writeFileSync(specFile(dir), "not json");
    const head = commit(dir, "break spec.json");
    expect(check(dir, { base, head })).toEqual({ specId: "example", specPath: SPEC_PATH, criterionId: null, reason: "spec.json does not parse at head" });
  });

  it("fails closed for a spec.json that is a symbolic link at the head", () => {
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }]);
    fs.writeFileSync(path.join(dir, "outside.json"), JSON.stringify({ id: "example", acceptance_criteria: [{ id: "AC-1", argv: ["a"] }] }));
    const base = commit(dir, "base");
    fs.rmSync(specFile(dir));
    fs.symlinkSync("../../../outside.json", specFile(dir));
    const head = commit(dir, "replace spec.json with a symbolic link");
    expect(check(dir, { base, head })).toMatchObject({ specId: "example", criterionId: null, reason: "spec.json does not parse at head" });
  });

  it("runs git with argument arrays, so a spec directory name cannot reach a shell", () => {
    const specId = "evil;touch>PWNED;#";
    const dir = initRepo();
    writeSpec(dir, [{ id: "AC-1", argv: ["a"] }], specId);
    const base = commit(dir, "base");
    writeSpec(dir, [{ id: "AC-1", argv: ["b"] }], specId);
    const head = commit(dir, "head");
    const calls = [];
    expect(check(dir, { base, head, specIds: [specId], calls })).toMatchObject({ specId, criterionId: "AC-1", reason: "argv changed" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((argv) => Array.isArray(argv))).toBe(true);
    expect(fs.existsSync(path.join(dir, "PWNED"))).toBe(false);
  });
});
