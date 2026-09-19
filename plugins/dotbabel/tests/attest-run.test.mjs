import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  attestRunPath,
  createRunManifest,
  decideReuse,
  readRunManifest,
  recordLeg,
  sha256File,
  writeRunManifest,
} from "../src/attest-run.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOW = new Date("2026-01-01T00:00:00.000Z");
const H1 = `sha256:${"1".repeat(64)}`;

const dirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dotbabel-attest-run-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A manifest in which leg `test` passed and produced one report. */
function passedManifest(over = {}) {
  let m = createRunManifest({ headSha: HEAD, now: NOW });
  m = recordLeg(m, {
    name: "test",
    mode: "hard",
    status: "pass",
    produces: [{ path: "coverage/lcov.info", sha256: H1 }],
    now: NOW,
  });
  return { ...m, ...over };
}

const ok = (over = {}) => ({
  manifest: passedManifest(),
  headSha: HEAD,
  treeClean: true,
  leg: "test",
  reportPaths: ["coverage/lcov.info"],
  hashFile: () => H1,
  ...over,
});

describe("manifest construction", () => {
  it("starts empty and pinned to the head it was created for", () => {
    const m = createRunManifest({ headSha: HEAD, now: NOW });
    expect(m).toEqual({ schema_version: 1, head_sha: HEAD, started_at: NOW.toISOString(), legs: {} });
  });

  it("records a leg without mutating the manifest it was given", () => {
    const before = createRunManifest({ headSha: HEAD, now: NOW });
    const after = recordLeg(before, { name: "lint", mode: "hard", status: "pass", now: NOW });
    expect(before.legs).toEqual({});
    expect(after.legs.lint).toEqual({
      mode: "hard",
      status: "pass",
      finished_at: NOW.toISOString(),
      produces: [],
    });
  });

  it("keeps the newest record when a leg name repeats", () => {
    let m = createRunManifest({ headSha: HEAD, now: NOW });
    m = recordLeg(m, { name: "test", mode: "hard", status: "fail", now: NOW });
    m = recordLeg(m, { name: "test", mode: "hard", status: "pass", now: NOW });
    expect(m.legs.test.status).toBe("pass");
  });
});

describe("manifest persistence", () => {
  it("round-trips through the repository-relative path", () => {
    const root = tempDir();
    const m = passedManifest();
    writeRunManifest(root, m);
    expect(fs.existsSync(attestRunPath(root))).toBe(true);
    expect(readRunManifest(root)).toEqual(m);
  });

  it("leaves no temporary file behind — the write is a rename", () => {
    const root = tempDir();
    writeRunManifest(root, passedManifest());
    expect(fs.readdirSync(path.dirname(attestRunPath(root)))).toEqual([path.basename(attestRunPath(root))]);
  });

  it("replaces an earlier manifest wholesale, so a stale leg cannot survive a new run", () => {
    const root = tempDir();
    writeRunManifest(root, passedManifest());
    writeRunManifest(root, createRunManifest({ headSha: OTHER, now: NOW }));
    expect(readRunManifest(root).legs).toEqual({});
  });

  it("reads a missing manifest as null, not an error", () => {
    expect(readRunManifest(tempDir())).toBeNull();
  });

  it.each([
    ["not JSON", "{ nope"],
    ["an array", "[]"],
    ["the wrong schema version", JSON.stringify({ schema_version: 2, head_sha: HEAD, legs: {} })],
    ["no head", JSON.stringify({ schema_version: 1, legs: {} })],
    ["a malformed head", JSON.stringify({ schema_version: 1, head_sha: "abc", legs: {} })],
    ["legs that are not an object", JSON.stringify({ schema_version: 1, head_sha: HEAD, legs: [] })],
  ])("reads %s as null, never as a manifest", (_label, text) => {
    const root = tempDir();
    fs.mkdirSync(path.dirname(attestRunPath(root)), { recursive: true });
    fs.writeFileSync(attestRunPath(root), text);
    expect(readRunManifest(root)).toBeNull();
  });
});

describe("sha256File", () => {
  it("hashes file contents into the sha256-prefixed form the manifest records", () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    expect(sha256File(path.join(root, "a.txt"))).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("throws on a missing file rather than hashing nothing", () => {
    expect(() => sha256File(path.join(tempDir(), "absent"))).toThrow();
  });
});

describe("decideReuse", () => {
  it("accepts a passed leg at this head on a clean tree whose report is unchanged", () => {
    expect(decideReuse(ok())).toEqual({ ok: true, headSha: HEAD, leg: "test" });
  });

  it("accepts a leg that produced no report when the capability needs none", () => {
    let m = createRunManifest({ headSha: HEAD, now: NOW });
    m = recordLeg(m, { name: "lint", mode: "hard", status: "pass", now: NOW });
    expect(decideReuse(ok({ manifest: m, leg: "lint", reportPaths: [] })).ok).toBe(true);
  });

  // Every refusal below is the fail-safe direction: the caller falls back to
  // running the tool itself, which is slower and never wrong.
  it.each([
    ["there is no manifest", { manifest: null }, "NO_MANIFEST"],
    ["the manifest is for another commit", { headSha: OTHER }, "HEAD_MISMATCH"],
    ["the tree is dirty", { treeClean: false }, "DIRTY_TREE"],
    ["the tree state is unknown", { treeClean: undefined }, "DIRTY_TREE"],
    ["the leg is not in the manifest", { leg: "lint" }, "LEG_MISSING"],
  ])("refuses when %s", (_label, over, reason) => {
    expect(decideReuse(ok(over))).toEqual({ ok: false, reason });
  });

  it.each(["fail", "advisory-fail", "skipped", "not-run"])("refuses a leg whose status is %s", (status) => {
    let m = createRunManifest({ headSha: HEAD, now: NOW });
    m = recordLeg(m, { name: "test", mode: "hard", status, now: NOW });
    expect(decideReuse(ok({ manifest: m, reportPaths: [] }))).toEqual({ ok: false, reason: "LEG_NOT_PASSED" });
  });

  it("refuses a report the leg never declared it produced", () => {
    expect(decideReuse(ok({ reportPaths: ["coverage/other.info"] }))).toEqual({
      ok: false,
      reason: "REPORT_NOT_PRODUCED",
    });
  });

  it("refuses a report whose contents changed after the leg recorded it", () => {
    // The staleness this whole design exists to rule out: a file at the right
    // path that is not the file the leg wrote.
    expect(decideReuse(ok({ hashFile: () => `sha256:${"2".repeat(64)}` }))).toEqual({
      ok: false,
      reason: "REPORT_CHANGED",
    });
  });

  it("refuses a report that cannot be read", () => {
    const hashFile = () => {
      throw new Error("ENOENT");
    };
    expect(decideReuse(ok({ hashFile }))).toEqual({ ok: false, reason: "REPORT_UNREADABLE" });
  });

  it("checks every report the capability needs, not only the first", () => {
    let m = createRunManifest({ headSha: HEAD, now: NOW });
    m = recordLeg(m, {
      name: "test",
      mode: "hard",
      status: "pass",
      produces: [
        { path: "a.info", sha256: H1 },
        { path: "b.info", sha256: H1 },
      ],
      now: NOW,
    });
    const hashFile = (p) => (p === "b.info" ? `sha256:${"3".repeat(64)}` : H1);
    expect(decideReuse({ manifest: m, headSha: HEAD, treeClean: true, leg: "test", reportPaths: ["a.info", "b.info"], hashFile })).toEqual({
      ok: false,
      reason: "REPORT_CHANGED",
    });
  });

  it("does not reach the filesystem when an earlier check already refused", () => {
    let calls = 0;
    decideReuse(ok({ headSha: OTHER, hashFile: () => (calls++, H1) }));
    expect(calls).toBe(0);
  });

  it("compares the full head, so an abbreviated one never matches", () => {
    expect(decideReuse(ok({ headSha: HEAD.slice(0, 12) }))).toEqual({ ok: false, reason: "HEAD_MISMATCH" });
  });
});

describe("where the manifest lives", () => {
  const git = (root, ...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  /** A committed repository with NO .gitignore — the case a consumer is in by default. */
  function gitRepo() {
    const root = tempDir();
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "T");
    fs.writeFileSync(path.join(root, "README.md"), "hi");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    return root;
  }

  it("never dirties a working tree, even one that ignores nothing", () => {
    // The regression this pins. The first version wrote `.dotbabel/attest-run.json`
    // into the working tree on the assumption that `.dotbabel/` is gitignored.
    // That is true here and false in a consumer, where the untracked directory
    // tripped local-attest's own post-matrix clean-tree check and aborted every
    // run. Writing into the git directory cannot appear in `git status`.
    const root = gitRepo();
    writeRunManifest(root, passedManifest());
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(root, ".dotbabel"))).toBe(false);
  });

  it("puts the file inside the repository's own git directory", () => {
    const root = gitRepo();
    const gitDir = git(root, "rev-parse", "--absolute-git-dir");
    expect(attestRunPath(root)).toBe(path.join(gitDir, "dotbabel", "attest-run.json"));
  });

  it("round-trips through the git directory", () => {
    const root = gitRepo();
    const m = passedManifest();
    writeRunManifest(root, m);
    expect(readRunManifest(root)).toEqual(m);
  });

  it("gives each linked worktree its own manifest", () => {
    // Two worktrees at different heads must not overwrite each other's record.
    const root = gitRepo();
    const other = path.join(tempDir(), "wt");
    git(root, "worktree", "add", "-q", "--detach", other);
    expect(attestRunPath(other)).not.toBe(attestRunPath(root));
    writeRunManifest(root, passedManifest());
    expect(readRunManifest(other)).toBeNull();
  });

  it("finds the same file from a subdirectory of the repository", () => {
    const root = gitRepo();
    fs.mkdirSync(path.join(root, "sub"));
    writeRunManifest(root, passedManifest());
    expect(attestRunPath(path.join(root, "sub"))).toBe(attestRunPath(root));
  });

  it("falls back to a directory of its own only outside a git repository", () => {
    // There is no `git status` to pollute there, so a plain directory is safe.
    const root = tempDir();
    expect(attestRunPath(root)).toBe(path.join(root, ".dotbabel", "attest-run.json"));
  });
});
