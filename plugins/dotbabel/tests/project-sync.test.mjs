import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import {
  projectSync,
  loadProjectConfig,
  DEFAULT_PROJECT_CONFIG,
  extractRuleFloorOrWhole,
} from "../src/project-sync.mjs";

let tmpDirs = [];

function makeTmpDir(prefix = "project-sync-test-") {
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

/**
 * Build a minimal consumer repo at `dir` with a CLAUDE.md (markers optional),
 * one command, and one skill.
 *
 * @param {string} dir
 * @param {{ withMarkers?: boolean, withDotbabelJson?: object | null, withSkills?: boolean, withCommands?: boolean }} [opts]
 */
function buildFakeRepo(dir, opts = {}) {
  const {
    withMarkers = true,
    withDotbabelJson = null,
    withSkills = true,
    withCommands = true,
  } = opts;

  const claudeBody = withMarkers
    ? `# Project rules\n\n<!-- dotbabel:rule-floor:begin -->\n- be terse\n- be helpful\n<!-- dotbabel:rule-floor:end -->\n`
    : `# Project rules\n\n- be terse\n- be helpful\n`;
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), claudeBody);

  if (withCommands) {
    fs.mkdirSync(path.join(dir, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".claude", "commands", "commit.md"), "# /commit\n");
    fs.writeFileSync(path.join(dir, ".claude", "commands", "review.md"), "# /review\n");
  }
  if (withSkills) {
    fs.mkdirSync(path.join(dir, ".claude", "skills", "deploy"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\n---\n# deploy\n",
    );
  }

  if (withDotbabelJson !== null) {
    fs.writeFileSync(
      path.join(dir, ".dotbabel.json"),
      `${JSON.stringify(withDotbabelJson, null, 2)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// loadProjectConfig
// ---------------------------------------------------------------------------

describe("loadProjectConfig", () => {
  it("returns defaults when .dotbabel.json is absent", () => {
    const repo = makeTmpDir();
    const cfg = loadProjectConfig(repo);
    expect(cfg.rule_floor_source).toBe("CLAUDE.md");
    expect(cfg.fan_out).toEqual(["codex", "gemini", "copilot"]);
    expect(cfg.targets).toHaveLength(3);
  });

  it("layers .dotbabel.json over defaults", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ fan_out: ["codex"], gate_on_cli_presence: false }),
    );
    const cfg = loadProjectConfig(repo);
    expect(cfg.fan_out).toEqual(["codex"]);
    expect(cfg.gate_on_cli_presence).toBe(false);
    // Defaults still come through for unspecified keys.
    expect(cfg.rule_floor_source).toBe("CLAUDE.md");
  });

  it("throws on malformed JSON", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(path.join(repo, ".dotbabel.json"), "{ broken json");
    expect(() => loadProjectConfig(repo)).toThrow(/.dotbabel.json is not valid JSON/);
  });
});

// ---------------------------------------------------------------------------
// extractRuleFloorOrWhole — convention path
// ---------------------------------------------------------------------------

describe("extractRuleFloorOrWhole", () => {
  it("uses slice between markers when both present", () => {
    const body =
      "# top\n<!-- dotbabel:rule-floor:begin -->\nbody line\n<!-- dotbabel:rule-floor:end -->\nfooter\n";
    expect(extractRuleFloorOrWhole(body)).toBe("body line");
  });
  it("falls back to whole body when no markers", () => {
    const body = "# minimal\nbe kind\n";
    expect(extractRuleFloorOrWhole(body)).toBe("# minimal\nbe kind");
  });
  it("re-throws on orphan markers", () => {
    const body = "# top\n<!-- dotbabel:rule-floor:begin -->\nbody only\n";
    expect(() => extractRuleFloorOrWhole(body)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// projectSync — full flow
// ---------------------------------------------------------------------------

describe("projectSync", () => {
  it("writes AGENTS.md, GEMINI.md, copilot-instructions.md from CLAUDE.md rule-floor", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, "GEMINI.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".github", "copilot-instructions.md"))).toBe(true);
    expect(fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8")).toContain("be terse");
  });

  it("creates Codex symlinks at .codex/skills/<id>/ and .codex/skills/<name>/SKILL.md", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });

    const skillLink = path.join(repo, ".codex", "skills", "deploy");
    expect(fs.lstatSync(skillLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(skillLink)).toBe(path.join(repo, ".claude", "skills", "deploy"));

    const cmdLink = path.join(repo, ".codex", "skills", "commit", "SKILL.md");
    expect(fs.lstatSync(cmdLink).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(cmdLink)).toBe(path.join(repo, ".claude", "commands", "commit.md"));
  });

  it("creates Gemini symlinks with the same shape as Codex", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const skillLink = path.join(repo, ".gemini", "skills", "deploy");
    expect(fs.lstatSync(skillLink).isSymbolicLink()).toBe(true);
    const cmdLink = path.join(repo, ".gemini", "skills", "review", "SKILL.md");
    expect(fs.readlinkSync(cmdLink)).toBe(path.join(repo, ".claude", "commands", "review.md"));
  });

  it("creates Copilot artifacts at .github/prompts/<name>.prompt.md and .github/instructions/<id>.instructions.md", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });

    const prompt = path.join(repo, ".github", "prompts", "commit.prompt.md");
    expect(fs.lstatSync(prompt).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(prompt)).toBe(path.join(repo, ".claude", "commands", "commit.md"));

    const instr = path.join(repo, ".github", "instructions", "deploy.instructions.md");
    expect(fs.lstatSync(instr).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(instr)).toBe(path.join(repo, ".claude", "skills", "deploy", "SKILL.md"));
  });

  it("is idempotent: second run produces no additional backups", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    const r1 = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const r2 = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r1.ok && r2.ok).toBe(true);
    expect(r2.backed_up).toBe(0);
  });

  it("backs up a real file at a destination path", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    fs.mkdirSync(path.join(repo, ".codex", "skills"), { recursive: true });
    // Pre-create a real file where the wrapper directory should land.
    fs.writeFileSync(path.join(repo, ".codex", "skills", "commit"), "real file\n");
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    // Backup file present
    const entries = fs.readdirSync(path.join(repo, ".codex", "skills"));
    expect(entries.some((e) => e.startsWith("commit.bak-"))).toBe(true);
    // New symlink in place
    expect(
      fs.lstatSync(path.join(repo, ".codex", "skills", "commit", "SKILL.md")).isSymbolicLink(),
    ).toBe(true);
  });

  it("updates a stale symlink in place", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    fs.mkdirSync(path.join(repo, ".codex", "skills", "commit"), { recursive: true });
    fs.symlinkSync("/nonexistent-target", path.join(repo, ".codex", "skills", "commit", "SKILL.md"));
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const link = path.join(repo, ".codex", "skills", "commit", "SKILL.md");
    expect(fs.readlinkSync(link)).toBe(path.join(repo, ".claude", "commands", "commit.md"));
  });

  it("skips .system namespace defensively", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    fs.mkdirSync(path.join(repo, ".claude", "skills", ".system"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "commands", ".system.md"), "# system\n");
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(fs.existsSync(path.join(repo, ".codex", "skills", ".system"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".gemini", "skills", ".system"))).toBe(false);
  });

  it("--dry-run does not mutate the filesystem", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    const r = await projectSync({ repoRoot: repo, allCli: true, dryRun: true, quiet: true });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".github", "prompts"))).toBe(false);
  });

  it("convention path: works with marker-less CLAUDE.md", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo, { withMarkers: false });
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    // Whole body landed in AGENTS.md
    const agents = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("be terse");
    expect(agents).toContain("be helpful");
  });

  it("CLI gating: skips fan-out when target binary is missing and --all is not set", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo, {
      withDotbabelJson: {
        ...DEFAULT_PROJECT_CONFIG,
        targets: [...DEFAULT_PROJECT_CONFIG.targets],
        fan_out: ["this-cli-does-not-exist-xyz"],
      },
    });
    const r = await projectSync({ repoRoot: repo, allCli: false, quiet: true });
    expect(r.ok).toBe(true);
    // No fan-out happened for the unknown-named CLI.
    expect(fs.existsSync(path.join(repo, ".codex"))).toBe(false);
    expect(r.skipped).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Branch coverage: error paths, empty fan-out, dry-run wrapper-dir, etc.
  // -------------------------------------------------------------------------

  it("returns ok=false when repoRoot does not exist", async () => {
    const r = await projectSync({
      repoRoot: "/nonexistent/path/that/should/never/exist-xyz",
      allCli: true,
      quiet: true,
    });
    expect(r.ok).toBe(false);
  });

  it("returns ok=false when CLAUDE.md is missing", async () => {
    const repo = makeTmpDir();
    // No CLAUDE.md, but .claude/ tree present.
    fs.mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "commands", "foo.md"), "# foo\n");
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(false);
  });

  it("warns and skips an unknown fan_out CLI name", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo, {
      withDotbabelJson: {
        ...DEFAULT_PROJECT_CONFIG,
        targets: [...DEFAULT_PROJECT_CONFIG.targets],
        fan_out: ["mystery-cli-foo"],
      },
    });
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it("idempotent instruction-file write: no rewrite when content unchanged", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    const r1 = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const beforeMtime = fs.statSync(path.join(repo, "AGENTS.md")).mtimeMs;
    // Wait a hair so any rewrite would bump mtime.
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const afterMtime = fs.statSync(path.join(repo, "AGENTS.md")).mtimeMs;
    expect(r1.written).toBeGreaterThan(0);
    expect(r2.written).toBe(0); // second run: no instruction-file rewrites
    expect(afterMtime).toBe(beforeMtime);
  });

  it("dry-run reports 'would back up + create dir' when wrapper path is a real file", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    fs.mkdirSync(path.join(repo, ".codex", "skills"), { recursive: true });
    // Pre-create a real file at the wrapper directory path.
    fs.writeFileSync(path.join(repo, ".codex", "skills", "commit"), "real\n");
    const r = await projectSync({ repoRoot: repo, allCli: true, dryRun: true, quiet: true });
    expect(r.ok).toBe(true);
    // Real file is still there (dry-run shouldn't have moved it).
    expect(
      fs.lstatSync(path.join(repo, ".codex", "skills", "commit")).isFile(),
    ).toBe(true);
    expect(r.backed_up).toBe(0);
  });

  it("Copilot fan-out: skill without SKILL.md is silently skipped", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    // Add a skill dir with no SKILL.md inside.
    fs.mkdirSync(path.join(repo, ".claude", "skills", "headless-skill"), {
      recursive: true,
    });
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    // No instructions file should have been emitted for headless-skill.
    expect(
      fs.existsSync(
        path.join(repo, ".github", "instructions", "headless-skill.instructions.md"),
      ),
    ).toBe(false);
    // Real skill (deploy) DID get one.
    expect(
      fs.lstatSync(
        path.join(repo, ".github", "instructions", "deploy.instructions.md"),
      ).isSymbolicLink(),
    ).toBe(true);
  });

  it("config: rejects non-object .dotbabel.json (e.g. JSON array)", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(path.join(repo, ".dotbabel.json"), JSON.stringify([1, 2, 3]));
    expect(() => loadProjectConfig(repo)).toThrow(/must be a JSON object/);
  });

  it("--dry-run honored on the symlink fan-out path (no .codex created when only fan-out runs)", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo, {
      withDotbabelJson: {
        ...DEFAULT_PROJECT_CONFIG,
        targets: [], // no instruction targets — exercise only fan-out
        fan_out: ["codex"],
        gate_on_cli_presence: false,
      },
    });
    const r = await projectSync({
      repoRoot: repo,
      allCli: true,
      dryRun: true,
      quiet: true,
    });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, ".codex"))).toBe(false);
  });
});
