/**
 * Tests for scripts/build-plugin.mjs — syncs authored artifacts into
 * plugins/dotclaude/templates/claude/ and generates skills-manifest.json.
 */

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BUILD_PLUGIN_BIN = join(REPO_ROOT, "scripts", "build-plugin.mjs");
const INDEX_BIN = join(REPO_ROOT, "plugins", "dotclaude", "bin", "dotclaude-index.mjs");

function mkRepo() {
  const root = mkdtempSync(join(tmpdir(), "dc-phase4-"));
  mkdirSync(join(root, "commands"), { recursive: true });
  mkdirSync(join(root, "skills"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  mkdirSync(join(root, "plugins", "dotclaude", "templates", "claude"), { recursive: true });
  writeFileSync(
    join(root, "plugins", "dotclaude", "templates", "claude", "skills-manifest.json"),
    JSON.stringify({ version: 1, generatedAt: "{{today}}", skills: [] }, null, 2) + "\n",
  );
  return root;
}

function writeAgent(root, slug) {
  writeFileSync(
    join(root, "agents", `${slug}.md`),
    [
      "---",
      `id: "${slug}"`,
      `name: "${slug}"`,
      'type: "agent"',
      `description: "${slug} agent description."`,
      'version: "1.0.0"',
      "domain: [infra]",
      "platform: [none]",
      "task: [review]",
      'maturity: "validated"',
      'owner: "@test"',
      'created: "2025-01-01"',
      'updated: "2026-04-17"',
      "tools: Read, Grep",
      'model: "sonnet"',
      "---",
      "",
      "Agent body.",
      "",
    ].join("\n"),
  );
}

function writeSkill(root, slug, extra = "") {
  mkdirSync(join(root, "skills", slug), { recursive: true });
  writeFileSync(
    join(root, "skills", slug, "SKILL.md"),
    [
      "---",
      `id: "${slug}"`,
      `name: "${slug}"`,
      'type: "skill"',
      `description: "${slug} description."`,
      'version: "1.0.0"',
      "domain: [infra]",
      "platform: [kubernetes]",
      "task: [debugging]",
      'maturity: "validated"',
      'owner: "@test"',
      'created: "2025-01-01"',
      'updated: "2026-04-17"',
      "---",
      "",
      extra || "Body.",
      "",
    ].join("\n"),
  );
}

function writeCommand(root, slug) {
  writeFileSync(
    join(root, "commands", `${slug}.md`),
    [
      "---",
      `id: "${slug}"`,
      `name: "${slug}"`,
      'type: "command"',
      `description: "${slug} description."`,
      'version: "1.0.0"',
      "domain: [devex]",
      "platform: [none]",
      "task: [review]",
      'maturity: "validated"',
      'owner: "@test"',
      'created: "2025-01-01"',
      'updated: "2026-04-17"',
      "---",
      "",
      "Body.",
      "",
    ].join("\n"),
  );
}

function buildIndex(root) {
  const result = spawnSync(process.execPath, [INDEX_BIN, "--repo-root", root, "--no-color"], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`index build failed: ${result.stderr}`);
}

function runBuild(root, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [BUILD_PLUGIN_BIN, "--repo-root", root, "--no-color", ...extraArgs],
    { encoding: "utf8" },
  );
}

function readManifest(root) {
  return JSON.parse(
    readFileSync(
      join(root, "plugins", "dotclaude", "templates", "claude", "skills-manifest.json"),
      "utf8",
    ),
  );
}

describe("build-plugin", () => {
  it("writes skills-manifest.json with skill and command entries", () => {
    const root = mkRepo();
    writeSkill(root, "kube-tool");
    writeCommand(root, "review-pr");
    buildIndex(root);

    const r = runBuild(root);
    expect(r.status).toBe(0);

    const manifest = readManifest(root);
    expect(manifest.version).toBe(1);
    expect(Array.isArray(manifest.skills)).toBe(true);
    expect(manifest.skills.some((s) => s.name === "kube-tool")).toBe(true);
    expect(manifest.skills.some((s) => s.name === "review-pr")).toBe(true);
  });

  it("skill entries have correct path format (.claude/skills/<id>/SKILL.md)", () => {
    const root = mkRepo();
    writeSkill(root, "kube-tool");
    buildIndex(root);
    runBuild(root);

    const manifest = readManifest(root);
    const entry = manifest.skills.find((s) => s.name === "kube-tool");
    expect(entry).toBeDefined();
    expect(entry.path).toBe(".claude/skills/kube-tool/SKILL.md");
    expect(entry).toHaveProperty("checksum");
    expect(entry).toHaveProperty("dependencies");
  });

  it("command entries have correct path format (.claude/commands/<id>.md)", () => {
    const root = mkRepo();
    writeCommand(root, "review-pr");
    buildIndex(root);
    runBuild(root);

    const manifest = readManifest(root);
    const entry = manifest.skills.find((s) => s.name === "review-pr");
    expect(entry).toBeDefined();
    expect(entry.path).toBe(".claude/commands/review-pr.md");
  });

  it("copies skill file to templates/claude/skills/<slug>/SKILL.md", () => {
    const root = mkRepo();
    writeSkill(root, "my-skill", "Custom body content.");
    buildIndex(root);
    runBuild(root);

    const destPath = join(
      root,
      "plugins",
      "dotclaude",
      "templates",
      "claude",
      "skills",
      "my-skill",
      "SKILL.md",
    );
    const content = readFileSync(destPath, "utf8");
    expect(content).toContain("Custom body content.");
    // authoring-only fields stripped
    expect(content).not.toContain("owner:");
    expect(content).not.toContain("created:");
    expect(content).not.toContain("updated:");
    // taxonomy fields preserved
    expect(content).toContain("domain:");
    expect(content).toContain("maturity:");
  });

  it("copies command file to templates/claude/commands/<slug>.md", () => {
    const root = mkRepo();
    writeCommand(root, "my-cmd");
    buildIndex(root);
    runBuild(root);

    const destPath = join(
      root,
      "plugins",
      "dotclaude",
      "templates",
      "claude",
      "commands",
      "my-cmd.md",
    );
    const content = readFileSync(destPath, "utf8");
    expect(content).toContain("my-cmd description.");
    expect(content).not.toContain("owner:");
  });

  it("preserves {{today}} placeholder in generatedAt", () => {
    const root = mkRepo();
    writeSkill(root, "my-skill");
    buildIndex(root);
    runBuild(root);

    const raw = readFileSync(
      join(root, "plugins", "dotclaude", "templates", "claude", "skills-manifest.json"),
      "utf8",
    );
    expect(raw).toContain('"{{today}}"');
  });

  it("is deterministic — running twice produces identical output", () => {
    const root = mkRepo();
    writeSkill(root, "stable-skill");
    writeCommand(root, "stable-cmd");
    buildIndex(root);

    const manifestPath = join(
      root,
      "plugins",
      "dotclaude",
      "templates",
      "claude",
      "skills-manifest.json",
    );
    runBuild(root);
    const first = readFileSync(manifestPath, "utf8");
    runBuild(root);
    const second = readFileSync(manifestPath, "utf8");
    expect(first).toBe(second);
  });

  it("--check exits 0 when manifest and template files are up-to-date", () => {
    const root = mkRepo();
    writeSkill(root, "check-skill");
    buildIndex(root);
    runBuild(root); // first build

    const r = runBuild(root, ["--check"]);
    expect(r.status).toBe(0);
  });

  it("--check exits 1 when manifest is stale", () => {
    const root = mkRepo();
    writeSkill(root, "new-skill");
    buildIndex(root);
    // no build run — manifest still has "skills": []

    const r = runBuild(root, ["--check"]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/stale/i);
  });

  it("exits 2 when index/artifacts.json does not exist", () => {
    const root = mkRepo();
    // no buildIndex

    const r = runBuild(root);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("index not found");
  });

  it("copies agent file to templates/claude/agents/<slug>.md", () => {
    const root = mkRepo();
    writeAgent(root, "my-agent");
    buildIndex(root);
    const r = runBuild(root);
    expect(r.status).toBe(0);
    const agentPath = join(
      root,
      "plugins",
      "dotclaude",
      "templates",
      "claude",
      "agents",
      "my-agent.md",
    );
    const content = readFileSync(agentPath, "utf8");
    expect(content).toContain("name: \"my-agent\"");
    expect(content).toContain("Agent body.");
  });

  it("strips owner/created/updated from agent frontmatter in plugin templates", () => {
    const root = mkRepo();
    writeAgent(root, "my-agent");
    buildIndex(root);
    runBuild(root);
    const agentPath = join(
      root,
      "plugins",
      "dotclaude",
      "templates",
      "claude",
      "agents",
      "my-agent.md",
    );
    const content = readFileSync(agentPath, "utf8");
    expect(content).not.toMatch(/^owner:/m);
    expect(content).not.toMatch(/^created:/m);
    expect(content).not.toMatch(/^updated:/m);
    // but the operational fields remain
    expect(content).toMatch(/^name:/m);
    expect(content).toMatch(/^model:/m);
    expect(content).toMatch(/^tools:/m);
  });

  it("does NOT add agent entries to skills-manifest.json (agents track separately)", () => {
    const root = mkRepo();
    writeAgent(root, "my-agent");
    writeSkill(root, "my-skill");
    buildIndex(root);
    runBuild(root);
    const manifest = readManifest(root);
    const ids = manifest.skills.map((s) => s.name);
    expect(ids).toContain("my-skill");
    expect(ids).not.toContain("my-agent");
  });
});
