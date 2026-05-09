import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { projectSync } from "../src/project-sync.mjs";
import { checkProjectSync } from "../src/check-project-sync.mjs";

let tmpDirs = [];

function makeTmpDir(prefix = "check-project-sync-test-") {
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

function buildSyncedRepo() {
  const repo = makeTmpDir();
  fs.writeFileSync(
    path.join(repo, "CLAUDE.md"),
    "# rules\n\n<!-- dotbabel:rule-floor:begin -->\n- be terse\n<!-- dotbabel:rule-floor:end -->\n",
  );
  fs.mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "commands", "commit.md"), "# /commit\n");
  fs.mkdirSync(path.join(repo, ".claude", "skills", "deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".claude", "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\n---\n# deploy\n",
  );
  return repo;
}

describe("checkProjectSync", () => {
  it("reports ok for a fully synced repo", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const r = await checkProjectSync({ repoRoot: repo, quiet: true });
    expect(r.ok).toBe(true);
    expect(r.missing).toHaveLength(0);
    expect(r.stale).toHaveLength(0);
    expect(r.okEntries.length).toBeGreaterThan(0);
  });

  it("reports missing when a symlink is removed", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    // Remove only the symlink (NOT the source).
    fs.unlinkSync(path.join(repo, ".codex", "skills", "commit", "SKILL.md"));
    expect(fs.existsSync(path.join(repo, ".claude", "commands", "commit.md"))).toBe(true);
    const r = await checkProjectSync({ repoRoot: repo, quiet: true });
    expect(r.ok).toBe(false);
    expect(r.missing.some((e) => e.path.endsWith("commit/SKILL.md"))).toBe(true);
  });

  it("reports stale when an instruction file is hand-edited", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    // Wipe AGENTS.md content so composeInject would change it.
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "totally different content\n");
    const r = await checkProjectSync({ repoRoot: repo, quiet: true });
    expect(r.ok).toBe(false);
    expect(r.stale.some((e) => e.path === "AGENTS.md")).toBe(true);
  });

  it("reports stale when a destination is a regular file (not a symlink)", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    // Replace the symlink with a regular file at the same path.
    const linkPath = path.join(repo, ".codex", "skills", "commit", "SKILL.md");
    fs.unlinkSync(linkPath);
    fs.writeFileSync(linkPath, "real file masquerading as a skill\n");
    const r = await checkProjectSync({ repoRoot: repo, quiet: true });
    expect(r.ok).toBe(false);
    expect(r.stale.some((e) => e.actual === "not a symlink")).toBe(true);
  });
});
