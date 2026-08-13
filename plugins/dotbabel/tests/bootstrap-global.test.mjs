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

    // CLAUDE.md is now a generated file with user-overlay markers (#228),
    // not a symlink.
    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(claudeMd).isFile()).toBe(true);
    expect(fs.readFileSync(claudeMd, "utf8")).toContain(
      "<!-- dotbabel:user-overlay:begin -->",
    );

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

    // CLAUDE.md is a generated file with overlay markers (#228), not a symlink.
    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isFile()).toBe(true);
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(claudeMd, "utf8")).toContain(
      "<!-- dotbabel:user-overlay:begin -->",
    );

    // No extra .bak files created (idempotent on second run).
    const tgtEntries = fs.readdirSync(tgt);
    expect(tgtEntries.some((e) => e.includes(".bak"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 3 — backs up a real file before overwriting with symlink
  // -------------------------------------------------------------------------

  it("backs up a real file before overwriting with the generated CLAUDE.md (#228)", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    // Pre-create a real CLAUDE.md in target
    fs.writeFileSync(path.join(tgt, "CLAUDE.md"), "# old content\n");

    const result = await bootstrapGlobal({ source: src, target: tgt });

    expect(result.ok).toBe(true);
    expect(result.backed_up).toBeGreaterThan(0);

    // The destination is now a generated file with overlay markers, not a symlink.
    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isFile()).toBe(true);
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(claudeMd, "utf8")).toContain(
      "<!-- dotbabel:user-overlay:begin -->",
    );

    // A backup file with .bak- prefix exists with the original content.
    const tgtEntries = fs.readdirSync(tgt);
    const bak = tgtEntries.find((e) => e.startsWith("CLAUDE.md.bak-"));
    expect(bak).toBeDefined();
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

    // Stale legacy symlink at the target is migrated to a generated file (#228).
    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isFile()).toBe(true);
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(claudeMd, "utf8")).toContain(
      "<!-- dotbabel:user-overlay:begin -->",
    );

    // Per #228, the legacy symlink is BACKED UP before the file is generated
    // (old behavior was silent replace via linkOne; new behavior preserves
    // the symlink target as a .bak so users can recover anything they had).
    expect(result.backed_up).toBeGreaterThan(0);
    const baks = fs.readdirSync(tgt).filter((e) => /^CLAUDE\.md\.bak-/.test(e));
    expect(baks.length).toBeGreaterThan(0);
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

  it("backs up an existing Codex command wrapper file before fanning out commands", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    const codexSkills = path.join(tgt, ".codex", "skills");
    fs.mkdirSync(codexSkills, { recursive: true });
    fs.writeFileSync(path.join(codexSkills, "foo"), "# existing wrapper\n");

    const result = await bootstrapGlobal({ source: src, target: tgt, allCli: true });

    expect(result.ok).toBe(true);
    expect(result.backed_up).toBeGreaterThan(0);

    const wrapper = path.join(codexSkills, "foo");
    expect(fs.lstatSync(wrapper).isDirectory()).toBe(true);

    const skillMd = path.join(wrapper, "SKILL.md");
    expect(fs.lstatSync(skillMd).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(skillMd)).toBe(path.join(src, "commands", "foo.md"));

    const backups = fs.readdirSync(codexSkills).filter((entry) => entry.startsWith("foo.bak-"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(codexSkills, backups[0]), "utf8")).toBe("# existing wrapper\n");
  });

  // -------------------------------------------------------------------------
  // GEMINI_HOME parity with CODEX_HOME — the gemini fan-out target must honor
  // process.env.GEMINI_HOME when set, falling back to <homeRoot>/.gemini.
  // -------------------------------------------------------------------------

  it("honors GEMINI_HOME when fanning out gemini skills", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    const customGemini = makeTmpDir("custom-gemini-");
    buildFakeSource(src);

    const prev = process.env.GEMINI_HOME;
    process.env.GEMINI_HOME = customGemini;
    try {
      const result = await bootstrapGlobal({ source: src, target: tgt, allCli: true });
      expect(result.ok).toBe(true);

      // Skill should land in the override path.
      const overrideSkill = path.join(customGemini, "skills", "alpha");
      expect(fs.lstatSync(overrideSkill).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(overrideSkill)).toBe(path.join(src, "skills", "alpha"));

      // Default path must NOT be populated when override is set.
      const defaultSkillsDir = path.join(tgt, ".gemini", "skills");
      const defaultExists =
        fs.existsSync(defaultSkillsDir) && fs.readdirSync(defaultSkillsDir).length > 0;
      expect(defaultExists).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_HOME;
      else process.env.GEMINI_HOME = prev;
    }
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

  // -------------------------------------------------------------------------
  // Issue #228 — ~/.claude/CLAUDE.md is now a generated file with overlay
  // markers, not a symlink. The next 5 tests pin that contract.
  //
  // Each test patches process.env.DOTBABEL_LOCAL_RULES so the bootstrap call
  // looks at a fixture-controlled overlay path instead of the real
  // ~/.config/dotbabel/local-rules.md.
  // -------------------------------------------------------------------------

  function withOverlayEnv(overlayPath, fn) {
    const prev = process.env.DOTBABEL_LOCAL_RULES;
    process.env.DOTBABEL_LOCAL_RULES = overlayPath ?? "/nonexistent-overlay-source";
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.DOTBABEL_LOCAL_RULES;
      else process.env.DOTBABEL_LOCAL_RULES = prev;
    }
  }

  it("creates ~/.claude/CLAUDE.md as a real file with user-overlay markers when no local-rules.md exists (#228)", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    await withOverlayEnv(null, () =>
      bootstrapGlobal({ source: src, target: tgt }),
    );

    const claudeMd = path.join(tgt, "CLAUDE.md");
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(claudeMd).isFile()).toBe(true);
    const content = fs.readFileSync(claudeMd, "utf8");
    expect(content).toContain("<!-- dotbabel:user-overlay:begin -->");
    expect(content).toContain("<!-- dotbabel:user-overlay:end -->");
    expect(content).toContain("(no user overlay)");
    // Canonical content from the fixture's CLAUDE.md is preserved.
    expect(content).toContain("# CLAUDE");
  });

  it("inlines local-rules.md content between the user-overlay markers when the overlay file exists (#228)", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    const overlayDir = makeTmpDir("bg-overlay-");
    buildFakeSource(src);

    const overlayPath = path.join(overlayDir, "local-rules.md");
    fs.writeFileSync(
      overlayPath,
      "## My personal rules\n\n- be terse\n- be helpful\n",
    );

    await withOverlayEnv(overlayPath, () =>
      bootstrapGlobal({ source: src, target: tgt }),
    );

    const content = fs.readFileSync(path.join(tgt, "CLAUDE.md"), "utf8");
    expect(content).toContain("- be terse");
    expect(content).toContain("- be helpful");
    expect(content).toContain("## My personal rules");
    expect(content).not.toContain("(no user overlay)");
    // Overlay sits AFTER canonical content (top-to-bottom precedence: user trumps).
    const canonicalIdx = content.indexOf("# CLAUDE");
    const overlayIdx = content.indexOf("- be terse");
    expect(overlayIdx).toBeGreaterThan(canonicalIdx);
  });

  it("migrates an existing pre-2.7.0 symlink to a generated file (no data loss) (#228)", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    // Pre-create a symlink at the target path, mirroring the legacy install state.
    const claudeMd = path.join(tgt, "CLAUDE.md");
    fs.symlinkSync("/some/legacy/symlink/target", claudeMd);
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(true);

    const result = await withOverlayEnv(null, () =>
      bootstrapGlobal({ source: src, target: tgt }),
    );

    expect(result.ok).toBe(true);
    expect(fs.lstatSync(claudeMd).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(claudeMd).isFile()).toBe(true);
    // Backup of the original symlink should exist.
    const entries = fs.readdirSync(tgt);
    expect(entries.some((e) => /^CLAUDE\.md\.bak-/.test(e))).toBe(true);
  });

  it("backs up direct edits to ~/.claude/CLAUDE.md before regenerating (#228)", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    // First bootstrap to create the file.
    await withOverlayEnv(null, () =>
      bootstrapGlobal({ source: src, target: tgt }),
    );
    const claudeMd = path.join(tgt, "CLAUDE.md");

    // User mucks with the file directly.
    fs.appendFileSync(claudeMd, "\n\n# UNAUTHORIZED EDIT\n");
    expect(fs.readFileSync(claudeMd, "utf8")).toContain("UNAUTHORIZED EDIT");

    // Re-bootstrap.
    await withOverlayEnv(null, () =>
      bootstrapGlobal({ source: src, target: tgt }),
    );

    // The unauthorized edit is gone from the live file.
    expect(fs.readFileSync(claudeMd, "utf8")).not.toContain("UNAUTHORIZED EDIT");
    // And it survives in a backup.
    const entries = fs.readdirSync(tgt);
    const baks = entries.filter((e) => /^CLAUDE\.md\.bak-/.test(e));
    expect(baks.length).toBeGreaterThanOrEqual(1);
    const bakContent = fs.readFileSync(path.join(tgt, baks[0]), "utf8");
    expect(bakContent).toContain("UNAUTHORIZED EDIT");
  });

  it("is idempotent: second bootstrap run with same overlay produces no new backups (#228)", async () => {
    const src = makeTmpDir("bg-src-");
    const tgt = makeTmpDir("bg-tgt-");
    buildFakeSource(src);

    await withOverlayEnv(null, () =>
      bootstrapGlobal({ source: src, target: tgt }),
    );
    const baksAfterFirst = fs
      .readdirSync(tgt)
      .filter((e) => /^CLAUDE\.md\.bak-/.test(e)).length;

    // Second run.
    await withOverlayEnv(null, () =>
      bootstrapGlobal({ source: src, target: tgt }),
    );
    const baksAfterSecond = fs
      .readdirSync(tgt)
      .filter((e) => /^CLAUDE\.md\.bak-/.test(e)).length;

    expect(baksAfterSecond).toBe(baksAfterFirst);
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
