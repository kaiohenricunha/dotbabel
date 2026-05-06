import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { bootstrapGlobal, resolveSource } from "../src/bootstrap-global.mjs";

let tmpDirs = [];

function makeTmpDir(prefix = "bootstrap-global-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Helpers — build a minimal fake source tree that mirrors the bootstrap.sh
// expectations.
// ---------------------------------------------------------------------------

function buildFakeSource(dir) {
  // CLAUDE.md
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# CLAUDE\n");

  // commands/*.md
  fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
  fs.writeFileSync(path.join(dir, "commands", "foo.md"), "# foo\n");
  fs.writeFileSync(path.join(dir, "commands", "bar.md"), "# bar\n");

  // skills/<name>/  (directory entries)
  fs.mkdirSync(path.join(dir, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "alpha", "skill.md"), "# alpha\n");
  fs.mkdirSync(path.join(dir, "skills", "beta"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "beta", "skill.md"), "# beta\n");

  // agents template
  fs.mkdirSync(path.join(dir, "plugins", "dotbabel", "templates", "claude", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugins", "dotbabel", "templates", "claude", "agents", "my-agent.md"),
    "---\nname: my-agent\n---\n"
  );

  // hooks/*.sh
  fs.mkdirSync(path.join(dir, "plugins", "dotbabel", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "plugins", "dotbabel", "hooks", "guard.sh"), "#!/usr/bin/env bash\n");

  // bootstrap.sh marker (needed for pkgRoot() detection)
  fs.writeFileSync(path.join(dir, "bootstrap.sh"), "#!/usr/bin/env bash\n");
}

// ---------------------------------------------------------------------------
// Test 1 — creates symlinks for CLAUDE.md, commands/, skills/
// ---------------------------------------------------------------------------

describe("bootstrapGlobal", () => {
  it("creates symlinks for CLAUDE.md, commands/, skills/ in a temp target dir", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    const result = await bootstrapGlobal({ source: src, target: tgt });

    expect(result.ok).toBe(true);

    // CLAUDE.md symlink
    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(claudeMd)).toBe(path.join(src, "CLAUDE.md"));

    // commands/foo.md symlink
    const fooCmd = path.join(tgt, "commands", "foo.md");
    expect(fs.lstatSync(fooCmd).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(fooCmd)).toBe(path.join(src, "commands", "foo.md"));

    // skills/alpha symlink (directory)
    const alphaSkill = path.join(tgt, "skills", "alpha");
    expect(fs.lstatSync(alphaSkill).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(alphaSkill)).toBe(path.join(src, "skills", "alpha"));

    // agents/my-agent.md is a real copy (not a symlink)
    const agentDst = path.join(tgt, "agents", "my-agent.md");
    expect(fs.existsSync(agentDst)).toBe(true);
    expect(fs.lstatSync(agentDst).isSymbolicLink()).toBe(false);

    expect(result.linked).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 2 — idempotent
  // -------------------------------------------------------------------------

  it("is idempotent — second run produces same state, no extra backups", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    await bootstrapGlobal({ source: src, target: tgt });
    const result2 = await bootstrapGlobal({ source: src, target: tgt });

    expect(result2.ok).toBe(true);
    // No new backups on second run
    expect(result2.backed_up).toBe(0);

    // symlinks still correct
    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(claudeMd)).toBe(path.join(src, "CLAUDE.md"));

    // No extra .bak files created
    const tgtEntries = fs.readdirSync(tgt);
    expect(tgtEntries.some((e) => e.includes(".bak"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3 — backs up a real file before overwriting with symlink
  // -------------------------------------------------------------------------

  it("backs up a real file before overwriting with symlink", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    // Pre-create a real CLAUDE.md in target
    fs.writeFileSync(path.join(tgt, "CLAUDE.md"), "# old content\n");

    const result = await bootstrapGlobal({ source: src, target: tgt });

    expect(result.ok).toBe(true);
    expect(result.backed_up).toBeGreaterThan(0);

    // The destination is now a symlink
    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(true);

    // A backup file with .bak- prefix exists
    const tgtEntries = fs.readdirSync(tgt);
    const bak = tgtEntries.find((e) => e.startsWith("CLAUDE.md.bak-"));
    expect(bak).toBeDefined();

    // Backup has the old content
    expect(fs.readFileSync(path.join(tgt, bak), "utf8")).toBe("# old content\n");
  });

  // -------------------------------------------------------------------------
  // Test 4 — updates a stale symlink pointing elsewhere
  // -------------------------------------------------------------------------

  it("updates a stale symlink pointing elsewhere", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    // Pre-create a symlink pointing to wrong target
    const staleTarget = path.join(src, "some-other-file.md");
    fs.writeFileSync(staleTarget, "stale\n");
    fs.symlinkSync(staleTarget, path.join(tgt, "CLAUDE.md"));

    const result = await bootstrapGlobal({ source: src, target: tgt });

    expect(result.ok).toBe(true);

    // Symlink should now point to the correct CLAUDE.md
    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(claudeMd)).toBe(path.join(src, "CLAUDE.md"));

    // No backup was made (stale symlinks are just replaced)
    expect(result.backed_up).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 5 — skips copying agents if file already exists in target
  // -------------------------------------------------------------------------

  it("skips copying agents if file already exists in target", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    // Pre-create the agents dir with the agent already installed
    fs.mkdirSync(path.join(tgt, "agents"), { recursive: true });
    const existingContent = "# existing agent\n";
    fs.writeFileSync(path.join(tgt, "agents", "my-agent.md"), existingContent);

    const result = await bootstrapGlobal({ source: src, target: tgt });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);

    // Original content must be preserved (not overwritten)
    const agentContent = fs.readFileSync(path.join(tgt, "agents", "my-agent.md"), "utf8");
    expect(agentContent).toBe(existingContent);
  });

  // -------------------------------------------------------------------------
  // Test 6 — symlinks hooks/*.sh into target/hooks/
  // -------------------------------------------------------------------------

  it("creates symlinks for hooks/*.sh in target/hooks/", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    const result = await bootstrapGlobal({ source: src, target: tgt });

    expect(result.ok).toBe(true);

    const hookDst = path.join(tgt, "hooks", "guard.sh");
    expect(fs.lstatSync(hookDst).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(hookDst)).toBe(
      path.join(src, "plugins", "dotbabel", "hooks", "guard.sh")
    );
  });

  // -------------------------------------------------------------------------
  // Test 7 — returns { ok: false } when source directory does not exist
  // -------------------------------------------------------------------------

  it("returns { ok: false } when source directory does not exist", async () => {
    const tgt = makeTmpDir("bg-tgt-");
    const nonexistent = path.join(os.tmpdir(), "this-does-not-exist-" + Date.now());

    const result = await bootstrapGlobal({ source: nonexistent, target: tgt });

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 7 & 8 — resolveSource
// ---------------------------------------------------------------------------

describe("resolveSource", () => {
  it("uses DOTBABEL_DIR env var when no --source given", () => {
    const fakeDir = "/tmp/fake-dotbabel";
    const resolved = resolveSource(undefined, { DOTBABEL_DIR: fakeDir });
    expect(resolved).toBe(fakeDir);
  });

  it("falls back to pkgRoot() when DOTBABEL_DIR is unset", () => {
    // When neither sourceOpt nor DOTBABEL_DIR is given, resolveSource must
    // return a path that actually contains bootstrap.sh (the repo root).
    const resolved = resolveSource(undefined, {});
    expect(fs.existsSync(path.join(resolved, "bootstrap.sh"))).toBe(true);
  });
});
