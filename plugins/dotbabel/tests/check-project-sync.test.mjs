import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { projectSync } from "../src/project-sync.mjs";
import { checkProjectSync } from "../src/check-project-sync.mjs";

let tmpDirs = [];
let savedPath = null;

function makeTmpDir(prefix = "check-project-sync-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// `commandExists` shells out to `sh -c 'command -v <cli>'`, so a PATH holding
// only `sh` is what makes "this CLI is not installed" deterministic on a dev box
// that may well have codex or gemini on the real PATH. Keeping `sh` reachable
// matters: an entirely empty PATH would fail the probe for the wrong reason.
function hideAllClisFromPath() {
  savedPath = process.env.PATH;
  const bin = makeTmpDir("check-project-sync-cliless-bin-");
  fs.symlinkSync("/bin/sh", path.join(bin, "sh"));
  process.env.PATH = bin;
}

afterEach(() => {
  if (savedPath !== null) {
    process.env.PATH = savedPath;
    savedPath = null;
  }
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
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
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
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
    expect(r.missing.some((e) => e.path.endsWith("commit/SKILL.md"))).toBe(true);
  });

  it("reports stale when an instruction file is hand-edited", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    // Wipe AGENTS.md content so composeInject would change it.
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "totally different content\n");
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
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
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
    expect(r.stale.some((e) => e.actual === "not a symlink")).toBe(true);
  });

  it("reports stale (dangling) when a symlink points at a non-existent source", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const linkPath = path.join(repo, ".codex", "skills", "commit", "SKILL.md");
    fs.unlinkSync(linkPath);
    fs.symlinkSync("/some/other/place/foo.md", linkPath);
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
    expect(
      r.stale.some(
        (e) =>
          e.path.endsWith("commit/SKILL.md") &&
          /^dangling: /.test(e.actual ?? ""),
      ),
    ).toBe(true);
  });

  it("ok when the symlink points at the canonical source via a relative path (issue #218)", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const linkPath = path.join(repo, ".codex", "skills", "commit", "SKILL.md");
    expect(path.isAbsolute(fs.readlinkSync(linkPath))).toBe(false);
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
  });

  it("reports missing instruction file when AGENTS.md is deleted", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.unlinkSync(path.join(repo, "AGENTS.md"));
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
    expect(r.missing.some((e) => e.path === "AGENTS.md")).toBe(true);
  });

  it("returns ok=false when repoRoot does not exist", async () => {
    const r = await checkProjectSync({
      repoRoot: "/totally-nonexistent-path-xyz-12345",
      quiet: true,
    });
    expect(r.ok).toBe(false);
  });

  it("returns ok=false when CLAUDE.md is missing", async () => {
    const repo = makeTmpDir();
    // No CLAUDE.md.
    fs.mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
  });
});

// `projectSync` skips a CLI's fan-out when gate_on_cli_presence is set and the
// binary is absent, so the checker has to skip the same CLI or it reports drift
// for work that was deliberately never done (#219, finding D).
describe("checkProjectSync — PATH gating", () => {
  it("skips an absent CLI instead of reporting its symlinks as missing", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.unlinkSync(path.join(repo, ".codex", "skills", "commit", "SKILL.md"));

    hideAllClisFromPath();
    const r = await checkProjectSync({ repoRoot: repo, quiet: true });

    expect(r.ok).toBe(true);
    expect(r.skipped).toContain("codex");
    expect(r.missing).toHaveLength(0);
  });

  it("inspects the same repo when allCli forces past the gate", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.unlinkSync(path.join(repo, ".codex", "skills", "commit", "SKILL.md"));

    hideAllClisFromPath();
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });

    expect(r.ok).toBe(false);
    expect(r.skipped).toHaveLength(0);
    expect(r.missing.some((e) => e.path.endsWith("commit/SKILL.md"))).toBe(true);
  });

  it("inspects an absent CLI when gate_on_cli_presence is false", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ gate_on_cli_presence: false }, null, 2),
    );
    fs.unlinkSync(path.join(repo, ".codex", "skills", "commit", "SKILL.md"));

    hideAllClisFromPath();
    const r = await checkProjectSync({ repoRoot: repo, quiet: true });

    expect(r.ok).toBe(false);
    expect(r.skipped).toHaveLength(0);
  });

  it("never gates the instruction files, which projectSync writes unconditionally", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.unlinkSync(path.join(repo, "AGENTS.md"));

    hideAllClisFromPath();
    const r = await checkProjectSync({ repoRoot: repo, quiet: true });

    expect(r.ok).toBe(false);
    expect(r.missing.some((e) => e.path === "AGENTS.md")).toBe(true);
  });
});

// The checker has to verify the shape the sync would have produced, which now
// depends on fan_out_layout (#219, finding C).
describe("checkProjectSync — shared fan-out layout", () => {
  function buildSharedSyncedRepo() {
    const repo = buildSyncedRepo();
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ fan_out_layout: "shared" }, null, 2),
    );
    return repo;
  }

  it("reports ok for a synced shared repo", async () => {
    const repo = buildSharedSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    expect(r.okEntries.length).toBeGreaterThan(0);
  });

  it("reports a deleted canonical entry once, not once per CLI", async () => {
    const repo = buildSharedSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.unlinkSync(path.join(repo, ".cli", "skills", "commit", "SKILL.md"));

    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
    expect(r.missing.filter((e) => e.path.endsWith("commit/SKILL.md"))).toHaveLength(1);
  });

  it("reports a redirect replaced by a real directory as drift", async () => {
    const repo = buildSharedSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const redirect = path.join(repo, ".codex", "skills");
    fs.unlinkSync(redirect);
    fs.mkdirSync(redirect, { recursive: true });

    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
    expect(r.stale.some((e) => e.path.endsWith(".codex/skills"))).toBe(true);
  });

  it("reports a per-cli tree as drift once the config says shared", async () => {
    const repo = buildSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ fan_out_layout: "shared" }, null, 2),
    );

    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
  });

  it("still honors the PATH gate in shared mode", async () => {
    const repo = buildSharedSyncedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.unlinkSync(path.join(repo, ".codex", "skills"));

    hideAllClisFromPath();
    const r = await checkProjectSync({ repoRoot: repo, quiet: true });
    expect(r.ok).toBe(true);
    expect(r.skipped).toContain("codex");
  });
});

describe("checkProjectSync — cli_excluded", () => {
  function buildExcludedRepo(cli_excluded, extra = {}) {
    const repo = buildSyncedRepo();
    fs.writeFileSync(path.join(repo, ".claude", "commands", "review.md"), "# /review\n");
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ cli_excluded, ...extra }, null, 2),
    );
    return repo;
  }

  it("does not expect an excluded entry", async () => {
    const repo = buildExcludedRepo({ codex: ["review"], copilot: ["deploy"] });
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.okEntries.some((e) => e.path === ".codex/skills/review/SKILL.md")).toBe(false);
    expect(r.okEntries.some((e) => e.path === ".gemini/skills/review/SKILL.md")).toBe(true);
  });

  it("reports a lingering excluded link as stale", async () => {
    const repo = buildSyncedRepo();
    fs.writeFileSync(path.join(repo, ".claude", "commands", "review.md"), "# /review\n");
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ cli_excluded: { codex: ["review"] } }, null, 2),
    );
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
    const hit = r.stale.find((e) => e.path === ".codex/skills/review/SKILL.md");
    expect(hit).toBeDefined();
    expect(hit.actual).toMatch(/excluded/);
  });

  it("shared layout: an exclusion for one CLI is checked against the canonical tree", async () => {
    const repo = buildExcludedRepo({ codex: ["review"] }, { fan_out_layout: "shared" });
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const r = await checkProjectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    expect(r.okEntries.some((e) => e.path === ".cli/skills/review/SKILL.md")).toBe(false);
  });
});
