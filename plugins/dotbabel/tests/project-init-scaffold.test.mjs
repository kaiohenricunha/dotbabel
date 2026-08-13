import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import {
  scaffoldProjectInit,
  DEFAULT_DOTBABEL_JSON,
} from "../src/project-init-scaffold.mjs";
import { ValidationError } from "../src/lib/errors.mjs";

let tmpDirs = [];

function makeTmpDir(prefix = "project-init-test-") {
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

describe("scaffoldProjectInit", () => {
  it("scaffolds .dotbabel.json + .gitkeeps + starter CLAUDE.md into an empty repo", () => {
    const repo = makeTmpDir();
    const r = scaffoldProjectInit({ repoRoot: repo });
    expect(r.ok).toBe(true);
    expect(r.filesWritten).toContain(".dotbabel.json");
    expect(r.filesWritten).toContain(".claude/commands/.gitkeep");
    expect(r.filesWritten).toContain(".claude/skills/.gitkeep");
    expect(r.filesWritten).toContain("CLAUDE.md");

    const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".dotbabel.json"), "utf8"));
    expect(cfg.fan_out).toEqual(DEFAULT_DOTBABEL_JSON.fan_out);
    expect(cfg.targets).toEqual(DEFAULT_DOTBABEL_JSON.targets);

    const claudeMd = fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("<!-- dotbabel:rule-floor:begin -->");
    expect(claudeMd).toContain("<!-- dotbabel:rule-floor:end -->");
  });

  it("preserves an existing CLAUDE.md", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# hand-authored — keep me\n");
    const r = scaffoldProjectInit({ repoRoot: repo });
    expect(r.skipped).toContain("CLAUDE.md");
    expect(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8")).toBe(
      "# hand-authored — keep me\n",
    );
  });

  it("preserves an existing .claude/ directory", () => {
    const repo = makeTmpDir();
    fs.mkdirSync(path.join(repo, ".claude", "commands"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".claude", "skills"), { recursive: true });
    const r = scaffoldProjectInit({ repoRoot: repo });
    expect(r.skipped).toContain(".claude/commands");
    expect(r.skipped).toContain(".claude/skills");
  });

  it("refuses to overwrite an existing .dotbabel.json without --force", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(path.join(repo, ".dotbabel.json"), `{"already":"here"}`);
    expect(() => scaffoldProjectInit({ repoRoot: repo })).toThrow(ValidationError);
  });

  it("--force overwrites an existing .dotbabel.json", () => {
    const repo = makeTmpDir();
    fs.writeFileSync(path.join(repo, ".dotbabel.json"), `{"already":"here"}`);
    const r = scaffoldProjectInit({ repoRoot: repo, force: true });
    expect(r.ok).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".dotbabel.json"), "utf8"));
    expect(cfg.rule_floor_source).toBe("CLAUDE.md");
  });

  it("--dry-run reports planned files but does not mutate", () => {
    const repo = makeTmpDir();
    const r = scaffoldProjectInit({ repoRoot: repo, dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.filesWritten).toContain(".dotbabel.json");
    expect(fs.existsSync(path.join(repo, ".dotbabel.json"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "CLAUDE.md"))).toBe(false);
  });
});
