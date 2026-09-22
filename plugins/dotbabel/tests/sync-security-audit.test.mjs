/**
 * Tests for scripts/sync-security-audit.mjs — pins a verbatim copy of
 * cloudflare/security-audit-skill under skills/security-audit/references/upstream/
 * and verifies it against references/UPSTREAM.json.
 *
 * A local git repository stands in for the upstream, so no test uses the network.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SYNC_BIN = join(REPO_ROOT, "scripts", "sync-security-audit.mjs");

const UPSTREAM_FILES = {
  "skills/security-audit/SKILL.md": "---\nname: security-audit\n---\n\nRead [HUNTING.md](HUNTING.md).\n",
  "skills/security-audit/HUNTING.md": "# Hunting\n",
  "skills/security-audit/report-schema.json": '{ "type": "array" }\n',
  "skills/security-audit/validate-findings.cjs": "module.exports = {};\n",
  "LICENSE": "MIT License\n",
  "README.md": "# not copied\n",
};

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

/** Create a local upstream repo. Returns { url, commits } with commits oldest first. */
function mkUpstream(files = UPSTREAM_FILES) {
  const root = makeTempDir("sas-upstream-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeTree(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  const first = git(root, "rev-parse", "HEAD");
  return { root, url: pathToFileURL(root).href, commits: [first] };
}

function addCommit(upstream, files) {
  writeTree(upstream.root, files);
  git(upstream.root, "add", "-A");
  git(upstream.root, "commit", "-q", "-m", "next");
  upstream.commits.push(git(upstream.root, "rev-parse", "HEAD"));
}

function mkTarget() {
  const root = makeTempDir("sas-target-");
  mkdirSync(join(root, "skills", "security-audit", "references"), { recursive: true });
  return root;
}

function run(target, ...args) {
  return spawnSync(process.execPath, [SYNC_BIN, "--repo-root", target, ...args], { encoding: "utf8" });
}

const upstreamDir = (target) => join(target, "skills", "security-audit", "references", "upstream");
const pinPath = (target) => join(target, "skills", "security-audit", "references", "UPSTREAM.json");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

describe("sync-security-audit --update", () => {
  it("copies the upstream skill, renames SKILL.md, and writes the pin file", () => {
    const upstream = mkUpstream();
    const target = mkTarget();

    const result = run(target, "--update", "--repo", upstream.url);
    expect(result.status, result.stderr).toBe(0);

    const dir = upstreamDir(target);
    expect(existsSync(join(dir, "SKILL.md"))).toBe(false);
    expect(readFileSync(join(dir, "UPSTREAM-SKILL.md"), "utf8")).toBe(UPSTREAM_FILES["skills/security-audit/SKILL.md"]);
    expect(readFileSync(join(dir, "HUNTING.md"), "utf8")).toBe("# Hunting\n");
    expect(readFileSync(join(dir, "LICENSE"), "utf8")).toBe("MIT License\n");
    expect(existsSync(join(dir, "README.md"))).toBe(false);

    const pin = JSON.parse(readFileSync(pinPath(target), "utf8"));
    expect(pin.repository).toBe(upstream.url);
    expect(pin.commit).toBe(upstream.commits[0]);
    expect(pin.renames).toEqual({ "skills/security-audit/SKILL.md": "UPSTREAM-SKILL.md" });
    expect(Object.keys(pin.files)).toEqual([
      "HUNTING.md",
      "LICENSE",
      "UPSTREAM-SKILL.md",
      "report-schema.json",
      "validate-findings.cjs",
    ]);
    expect(pin.files["UPSTREAM-SKILL.md"]).toEqual({
      upstream_path: "skills/security-audit/SKILL.md",
      sha256: sha256(UPSTREAM_FILES["skills/security-audit/SKILL.md"]),
    });
    expect(readFileSync(pinPath(target), "utf8").endsWith("}\n")).toBe(true);
  });

  it("pins the commit named by --ref and removes files that upstream dropped", () => {
    const upstream = mkUpstream();
    addCommit(upstream, { "skills/security-audit/EXTRA.md": "# extra\n" });
    const target = mkTarget();

    expect(run(target, "--update", "--repo", upstream.url).status).toBe(0);
    expect(existsSync(join(upstreamDir(target), "EXTRA.md"))).toBe(true);

    const result = run(target, "--update", "--repo", upstream.url, "--ref", upstream.commits[0]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(pinPath(target), "utf8")).commit).toBe(upstream.commits[0]);
    expect(existsSync(join(upstreamDir(target), "EXTRA.md"))).toBe(false);
  });

  it.each([
    ["a scaffolder placeholder", { "skills/security-audit/HUNTING.md": "Run on {{today}}.\n" }, /placeholder/],
    ["a binary file", { "skills/security-audit/logo.png": Buffer.from([0x89, 0x50, 0x00, 0xff]) }, /UTF-8/],
    ["a nested SKILL.md", { "skills/security-audit/sub/SKILL.md": "# nested\n" }, /nested SKILL\.md/],
  ])("fails closed on %s and leaves the existing copy untouched", (_label, files, message) => {
    const upstream = mkUpstream();
    const target = mkTarget();
    expect(run(target, "--update", "--repo", upstream.url).status).toBe(0);
    const pinBefore = readFileSync(pinPath(target), "utf8");

    addCommit(upstream, files);
    const result = run(target, "--update", "--repo", upstream.url);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(message);
    expect(readFileSync(pinPath(target), "utf8")).toBe(pinBefore);
    expect(run(target, "--check").status).toBe(0);
  });

  it("fails with exit 1 when the upstream layout no longer has skills/security-audit", () => {
    const upstream = mkUpstream({ "LICENSE": "MIT License\n", "README.md": "# moved\n" });
    const target = mkTarget();
    const result = run(target, "--update", "--repo", upstream.url);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/skills\/security-audit/);
    expect(existsSync(pinPath(target))).toBe(false);
  });

  it("exits 2 when the ref cannot be fetched", () => {
    const upstream = mkUpstream();
    const target = mkTarget();
    const result = run(target, "--update", "--repo", upstream.url, "--ref", "0".repeat(40));
    expect(result.status).toBe(2);
    expect(existsSync(pinPath(target))).toBe(false);
  });
});

describe("sync-security-audit --check", () => {
  function synced() {
    const upstream = mkUpstream();
    const target = mkTarget();
    expect(run(target, "--update", "--repo", upstream.url).status).toBe(0);
    return target;
  }

  it("passes on an unchanged copy", () => {
    const result = run(synced(), "--check");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("fails on a hand-edited file", () => {
    const target = synced();
    writeFileSync(join(upstreamDir(target), "HUNTING.md"), "# Hunting (edited)\n");
    const result = run(target, "--check");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/HUNTING\.md/);
  });

  it("fails on an extra file", () => {
    const target = synced();
    writeFileSync(join(upstreamDir(target), "NOTES.md"), "local notes\n");
    const result = run(target, "--check");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/NOTES\.md/);
  });

  it("fails on a missing file", () => {
    const target = synced();
    rmSync(join(upstreamDir(target), "LICENSE"));
    const result = run(target, "--check");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/LICENSE/);
  });

  it("fails when the pin file is missing", () => {
    const result = run(mkTarget(), "--check");
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/UPSTREAM\.json/);
  });
});

describe("sync-security-audit --latest", () => {
  it("prints the upstream HEAD commit", () => {
    const upstream = mkUpstream();
    addCommit(upstream, { "skills/security-audit/EXTRA.md": "# extra\n" });
    const result = run(mkTarget(), "--latest", "--repo", upstream.url);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(upstream.commits[1]);
  });
});

describe("sync-security-audit usage", () => {
  it.each([
    [[]],
    [["--check", "--update"]],
    [["--check", "--ref", "abc"]],
    [["--update", "--bogus"]],
    [["--check", "extra-positional"]],
    [["--update", "--ref=--upload-pack=touch /tmp/pwned"]],
    [["--update", "--ref", "main;rm"]],
    [["--latest", "--repo=--upload-pack=touch /tmp/pwned"]],
  ])("exits 64 for %j", (args) => {
    expect(run(mkTarget(), ...args).status).toBe(64);
  });
});
