import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import {
  projectSync,
  loadProjectConfig,
  DEFAULT_PROJECT_CONFIG,
  KNOWN_FAN_OUT_CLIS,
  extractRuleFloorOrWhole,
} from "../src/project-sync.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

let tmpDirs = [];
let savedPath = null;

function makeTmpDir(prefix = "project-sync-test-") {
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
  const bin = makeTmpDir("project-sync-cliless-bin-");
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

  // A typo in fan_out used to warn and skip, which silently produced no fan-out
  // for that CLI in a non-interactive run (#219, finding E).
  it("throws CONFIG_UNKNOWN_CLI on an unknown fan_out entry", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ fan_out: ["codex", "co-pilot"] }),
    );
    let caught;
    try {
      loadProjectConfig(repo);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.CONFIG_UNKNOWN_CLI);
    expect(caught.file).toBe(".dotbabel.json");
    expect(caught.pointer).toBe("/fan_out/1");
    expect(caught.message).toMatch(/co-pilot/);
  });

  it("throws when fan_out holds a non-string entry", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ fan_out: ["codex", 42] }),
    );
    expect(() => loadProjectConfig(repo)).toThrow(ValidationError);
  });

  it("accepts every known CLI", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ fan_out: [...KNOWN_FAN_OUT_CLIS] }),
    );
    expect(loadProjectConfig(repo).fan_out).toEqual([...KNOWN_FAN_OUT_CLIS]);
  });

  it("tolerates the $schema key editors use for autocomplete", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({
        $schema: "https://dotbabel.dev/schemas/dotbabel.config.schema.json",
        fan_out: ["codex"],
      }),
    );
    const cfg = loadProjectConfig(repo);
    expect(cfg.fan_out).toEqual(["codex"]);
    expect(cfg.rule_floor_source).toBe("CLAUDE.md");
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
    expect(path.isAbsolute(fs.readlinkSync(skillLink))).toBe(false);
    expect(fs.realpathSync(skillLink)).toBe(
      fs.realpathSync(path.join(repo, ".claude", "skills", "deploy")),
    );

    const cmdLink = path.join(repo, ".codex", "skills", "commit", "SKILL.md");
    expect(fs.lstatSync(cmdLink).isSymbolicLink()).toBe(true);
    expect(path.isAbsolute(fs.readlinkSync(cmdLink))).toBe(false);
    expect(fs.realpathSync(cmdLink)).toBe(
      fs.realpathSync(path.join(repo, ".claude", "commands", "commit.md")),
    );
  });

  it("creates Gemini symlinks with the same shape as Codex", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const skillLink = path.join(repo, ".gemini", "skills", "deploy");
    expect(fs.lstatSync(skillLink).isSymbolicLink()).toBe(true);
    const cmdLink = path.join(repo, ".gemini", "skills", "review", "SKILL.md");
    expect(path.isAbsolute(fs.readlinkSync(cmdLink))).toBe(false);
    expect(fs.realpathSync(cmdLink)).toBe(
      fs.realpathSync(path.join(repo, ".claude", "commands", "review.md")),
    );
  });

  it("creates Copilot artifacts at .github/prompts/<name>.prompt.md and .github/instructions/<id>.instructions.md", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });

    const prompt = path.join(repo, ".github", "prompts", "commit.prompt.md");
    expect(fs.lstatSync(prompt).isSymbolicLink()).toBe(true);
    expect(path.isAbsolute(fs.readlinkSync(prompt))).toBe(false);
    expect(fs.realpathSync(prompt)).toBe(
      fs.realpathSync(path.join(repo, ".claude", "commands", "commit.md")),
    );

    const instr = path.join(repo, ".github", "instructions", "deploy.instructions.md");
    expect(fs.lstatSync(instr).isSymbolicLink()).toBe(true);
    expect(path.isAbsolute(fs.readlinkSync(instr))).toBe(false);
    expect(fs.realpathSync(instr)).toBe(
      fs.realpathSync(path.join(repo, ".claude", "skills", "deploy", "SKILL.md")),
    );
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
    expect(path.isAbsolute(fs.readlinkSync(link))).toBe(false);
    expect(fs.realpathSync(link)).toBe(
      fs.realpathSync(path.join(repo, ".claude", "commands", "commit.md")),
    );
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
        fan_out: ["codex"],
      },
    });
    hideAllClisFromPath();
    const r = await projectSync({ repoRoot: repo, allCli: false, quiet: true });
    expect(r.ok).toBe(true);
    // No fan-out happened for the CLI that is absent from PATH.
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

  // Was "warns and skips": a typo now fails the run instead of quietly
  // producing no fan-out for that CLI (#219, finding E).
  it("rejects an unknown fan_out CLI name", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo, {
      withDotbabelJson: {
        ...DEFAULT_PROJECT_CONFIG,
        targets: [...DEFAULT_PROJECT_CONFIG.targets],
        fan_out: ["mystery-cli-foo"],
      },
    });
    await expect(
      projectSync({ repoRoot: repo, allCli: true, quiet: true }),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONFIG_UNKNOWN_CLI });
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

  // -------------------------------------------------------------------------
  // Issue #218 — symlink targets must be relative for repo portability.
  // The original v2.4.0 implementation wrote absolute targets, which broke
  // every clone and even the original machine after worktree cleanup.
  // -------------------------------------------------------------------------

  it("symlink targets are stored as relative paths (issue #218)", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    for (const link of [
      path.join(repo, ".codex", "skills", "commit", "SKILL.md"),
      path.join(repo, ".codex", "skills", "deploy"),
      path.join(repo, ".gemini", "skills", "commit", "SKILL.md"),
      path.join(repo, ".github", "prompts", "commit.prompt.md"),
      path.join(repo, ".github", "instructions", "deploy.instructions.md"),
    ]) {
      const target = fs.readlinkSync(link);
      expect(path.isAbsolute(target)).toBe(false);
      // The link must still resolve to the canonical source.
      expect(fs.existsSync(link)).toBe(true);
    }
  });

  it("symlinks survive a repo rename (the regression #218 caught)", async () => {
    const original = makeTmpDir();
    buildFakeRepo(original);
    await projectSync({ repoRoot: original, allCli: true, quiet: true });

    // Rename the entire repo to simulate a fresh clone at a different path
    // (or, in the real-world scenario, a worktree cleanup followed by main
    // checkout exercising the same tree).
    const renamed = `${original}-renamed`;
    fs.renameSync(original, renamed);
    tmpDirs.push(renamed);
    tmpDirs = tmpDirs.filter((d) => d !== original);

    for (const [link, expectedRel] of [
      [".codex/skills/commit/SKILL.md", ".claude/commands/commit.md"],
      [".gemini/skills/commit/SKILL.md", ".claude/commands/commit.md"],
      [".github/prompts/commit.prompt.md", ".claude/commands/commit.md"],
      [".codex/skills/deploy", ".claude/skills/deploy"],
      [".github/instructions/deploy.instructions.md", ".claude/skills/deploy/SKILL.md"],
    ]) {
      const linkPath = path.join(renamed, link);
      const expectedAbs = path.join(renamed, expectedRel);
      expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(expectedAbs));
    }
  });

  it("upgrades absolute symlinks (from v2.4.0) to relative on next sync", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    // Manually create a v2.4.0-style absolute symlink and run sync.
    // linkOne's stale-symlink branch should detect the encoding change and
    // re-link with the relative form.
    const absSrc = path.join(repo, ".claude", "commands", "commit.md");
    const linkPath = path.join(repo, ".codex", "skills", "commit", "SKILL.md");
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(absSrc, linkPath);
    expect(path.isAbsolute(fs.readlinkSync(linkPath))).toBe(true);

    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(path.isAbsolute(fs.readlinkSync(linkPath))).toBe(false);
    // And it still resolves to the canonical source.
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(absSrc));
  });
});

// ---------------------------------------------------------------------------
// fan_out_layout — Codex and Gemini share one canonical tree (#219, finding C)
// ---------------------------------------------------------------------------

describe("projectSync — shared fan-out layout", () => {
  const shared = (repo, ...rest) => path.join(repo, ".cli", "skills", ...rest);

  function buildSharedRepo() {
    const repo = makeTmpDir();
    buildFakeRepo(repo, {
      withDotbabelJson: {
        ...DEFAULT_PROJECT_CONFIG,
        targets: [...DEFAULT_PROJECT_CONFIG.targets],
        fan_out_layout: "shared",
      },
    });
    return repo;
  }

  it("defaults to per-cli when the key is absent", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(fs.existsSync(path.join(repo, ".cli"))).toBe(false);
    expect(fs.lstatSync(path.join(repo, ".codex", "skills")).isSymbolicLink()).toBe(false);
  });

  it("writes one canonical tree and a redirect per CLI", async () => {
    const repo = buildSharedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });

    expect(fs.existsSync(shared(repo, "commit", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(shared(repo, "deploy"))).toBe(true);

    for (const cli of ["codex", "gemini"]) {
      const redirect = path.join(repo, `.${cli}`, "skills");
      expect(fs.lstatSync(redirect).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(redirect)).toBe(fs.realpathSync(shared(repo)));
    }
  });

  it("stores the redirect as a relative target, like every other link (#218)", async () => {
    const repo = buildSharedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const target = fs.readlinkSync(path.join(repo, ".codex", "skills"));
    expect(path.isAbsolute(target)).toBe(false);
  });

  it("resolves a command through both hops to the file in .claude/", async () => {
    const repo = buildSharedRepo();
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const viaCodex = path.join(repo, ".codex", "skills", "commit", "SKILL.md");
    expect(fs.readFileSync(viaCodex, "utf8")).toBe("# /commit\n");
    expect(fs.realpathSync(viaCodex)).toBe(
      fs.realpathSync(path.join(repo, ".claude", "commands", "commit.md")),
    );
  });

  it("backs the old per-cli tree up when a repo switches to shared", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(fs.lstatSync(path.join(repo, ".codex", "skills")).isDirectory()).toBe(true);

    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ fan_out_layout: "shared" }),
    );
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });

    expect(fs.lstatSync(path.join(repo, ".codex", "skills")).isSymbolicLink()).toBe(true);
    const backups = fs
      .readdirSync(path.join(repo, ".codex"))
      .filter((e) => e.startsWith("skills.bak-"));
    expect(backups).toHaveLength(1);
  });

  it("creates no .cli tree when only copilot fans out", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo, {
      withDotbabelJson: {
        ...DEFAULT_PROJECT_CONFIG,
        targets: [...DEFAULT_PROJECT_CONFIG.targets],
        fan_out: ["copilot"],
        fan_out_layout: "shared",
      },
    });
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(fs.existsSync(path.join(repo, ".cli"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".github", "prompts", "commit.prompt.md"))).toBe(true);
  });

  it("builds the canonical tree exactly once for both CLIs", async () => {
    const repo = buildSharedRepo();
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    expect(fs.readdirSync(shared(repo)).sort()).toEqual(["commit", "deploy", "review"]);
  });

  it("rejects an unknown fan_out_layout", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ fan_out_layout: "sideways" }),
    );
    let caught;
    try {
      loadProjectConfig(repo);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.CONFIG_UNKNOWN_LAYOUT);
    expect(caught.pointer).toBe("/fan_out_layout");
    expect(caught.message).toMatch(/sideways/);
  });

  it("builds nothing when every CLI is gated off PATH", async () => {
    const repo = buildSharedRepo();
    hideAllClisFromPath();
    const r = await projectSync({ repoRoot: repo, allCli: false, quiet: true });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(repo, ".codex", "skills"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".cli"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cli_excluded — per-CLI command / skill allowlist (#219, finding A)
// ---------------------------------------------------------------------------

describe("loadProjectConfig — cli_excluded", () => {
  function loadWith(cfg) {
    const repo = makeTmpDir();
    fs.writeFileSync(path.join(repo, ".dotbabel.json"), JSON.stringify(cfg));
    let caught;
    try {
      return { cfg: loadProjectConfig(repo) };
    } catch (err) {
      caught = err;
    }
    return { caught };
  }

  it("defaults to an empty map", () => {
    expect(DEFAULT_PROJECT_CONFIG.cli_excluded).toEqual({});
    const repo = makeTmpDir();
    expect(loadProjectConfig(repo).cli_excluded).toEqual({});
  });

  it("accepts a map of known CLI to name list", () => {
    const { cfg } = loadWith({ cli_excluded: { codex: ["review"], copilot: [] } });
    expect(cfg.cli_excluded).toEqual({ codex: ["review"], copilot: [] });
  });

  it("rejects an unknown CLI key with CONFIG_UNKNOWN_CLI", () => {
    const { caught } = loadWith({ cli_excluded: { "co-pilot": ["review"] } });
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.CONFIG_UNKNOWN_CLI);
    expect(caught.pointer).toBe("/cli_excluded/co-pilot");
  });

  it("rejects a non-object value with CONFIG_INVALID_EXCLUSION", () => {
    const { caught } = loadWith({ cli_excluded: ["review"] });
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught.code).toBe(ERROR_CODES.CONFIG_INVALID_EXCLUSION);
    expect(caught.pointer).toBe("/cli_excluded");
  });

  it("rejects a non-array name list with CONFIG_INVALID_EXCLUSION", () => {
    const { caught } = loadWith({ cli_excluded: { codex: "review" } });
    expect(caught.code).toBe(ERROR_CODES.CONFIG_INVALID_EXCLUSION);
    expect(caught.pointer).toBe("/cli_excluded/codex");
  });

  it("rejects a non-string name with CONFIG_INVALID_EXCLUSION", () => {
    const { caught } = loadWith({ cli_excluded: { codex: ["review", 7] } });
    expect(caught.code).toBe(ERROR_CODES.CONFIG_INVALID_EXCLUSION);
    expect(caught.pointer).toBe("/cli_excluded/codex/1");
  });
});

describe("projectSync — cli_excluded", () => {
  function buildExcludedRepo(cli_excluded, extra = {}) {
    const repo = makeTmpDir();
    buildFakeRepo(repo, {
      withDotbabelJson: {
        ...DEFAULT_PROJECT_CONFIG,
        targets: [...DEFAULT_PROJECT_CONFIG.targets],
        cli_excluded,
        ...extra,
      },
    });
    return repo;
  }

  it("omits an excluded command from that CLI only", async () => {
    const repo = buildExcludedRepo({ codex: ["review"] });
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(fs.existsSync(path.join(repo, ".codex", "skills", "review"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".codex", "skills", "commit", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".gemini", "skills", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".github", "prompts", "review.prompt.md"))).toBe(true);
  });

  it("omits an excluded skill from copilot only", async () => {
    const repo = buildExcludedRepo({ copilot: ["deploy"] });
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(
      fs.existsSync(path.join(repo, ".github", "instructions", "deploy.instructions.md")),
    ).toBe(false);
    expect(fs.existsSync(path.join(repo, ".github", "prompts", "commit.prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".codex", "skills", "deploy"))).toBe(true);
  });

  it("removes a previously fanned-out entry once it is excluded", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(fs.existsSync(path.join(repo, ".codex", "skills", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".github", "prompts", "review.prompt.md"))).toBe(true);

    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ cli_excluded: { codex: ["review"], copilot: ["review"] } }),
    );
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.ok).toBe(true);
    expect(r.removed).toBe(2);
    expect(fs.existsSync(path.join(repo, ".codex", "skills", "review"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".github", "prompts", "review.prompt.md"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".gemini", "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("removes an excluded skill-directory link but never the source", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ cli_excluded: { codex: ["deploy"] } }),
    );
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(repo, ".codex", "skills", "deploy"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);
  });

  it("leaves a real file at an excluded destination alone", async () => {
    const repo = buildExcludedRepo({ copilot: ["review"] });
    fs.mkdirSync(path.join(repo, ".github", "prompts"), { recursive: true });
    const handWritten = path.join(repo, ".github", "prompts", "review.prompt.md");
    fs.writeFileSync(handWritten, "hand-written\n");
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.removed).toBe(0);
    expect(fs.readFileSync(handWritten, "utf8")).toBe("hand-written\n");
  });

  it("--dry-run reports but does not remove", async () => {
    const repo = makeTmpDir();
    buildFakeRepo(repo);
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    fs.writeFileSync(
      path.join(repo, ".dotbabel.json"),
      JSON.stringify({ cli_excluded: { codex: ["review"] } }),
    );
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true, dryRun: true });
    expect(r.removed).toBe(1);
    expect(fs.existsSync(path.join(repo, ".codex", "skills", "review", "SKILL.md"))).toBe(true);
  });

  it("is idempotent: a second run after removal removes nothing", async () => {
    const repo = buildExcludedRepo({ codex: ["review"] });
    await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    const r = await projectSync({ repoRoot: repo, allCli: true, quiet: true });
    expect(r.removed).toBe(0);
  });

  it("warns on a name that matches no command or skill", async () => {
    const repo = buildExcludedRepo({ codex: ["nope"] });
    const warnings = [];
    const out = {
      pass() {},
      fail() {},
      info() {},
      warn(msg) {
        warnings.push(msg);
      },
      flush() {},
    };
    const r = await projectSync({ repoRoot: repo, allCli: true, out });
    expect(r.ok).toBe(true);
    expect(warnings.some((w) => /cli_excluded.*codex.*nope/.test(w))).toBe(true);
  });

  it("shared layout: an exclusion for one CLI drops the entry from the canonical tree and warns", async () => {
    const repo = buildExcludedRepo({ codex: ["review"] }, { fan_out_layout: "shared" });
    const warnings = [];
    const out = {
      pass() {},
      fail() {},
      info() {},
      warn(msg) {
        warnings.push(msg);
      },
      flush() {},
    };
    await projectSync({ repoRoot: repo, allCli: true, out });
    expect(fs.existsSync(path.join(repo, ".cli", "skills", "review"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".gemini", "skills", "review"))).toBe(false);
    expect(warnings.some((w) => /shared.*review.*gemini/.test(w))).toBe(true);
  });

  it("shared layout: identical exclusions for codex and gemini do not warn", async () => {
    const repo = buildExcludedRepo(
      { codex: ["review"], gemini: ["review"] },
      { fan_out_layout: "shared" },
    );
    const warnings = [];
    const out = {
      pass() {},
      fail() {},
      info() {},
      warn(msg) {
        warnings.push(msg);
      },
      flush() {},
    };
    await projectSync({ repoRoot: repo, allCli: true, out });
    expect(fs.existsSync(path.join(repo, ".cli", "skills", "review"))).toBe(false);
    expect(warnings).toEqual([]);
  });
});
