/**
 * Tests for the taxonomy search / list / show CLI subcommands and
 * the --strict flag on dotbabel-index.
 */

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_DIR = join(__dirname, "..", "bin");
const SEARCH_BIN = join(BIN_DIR, "dotbabel-search.mjs");
const LIST_BIN = join(BIN_DIR, "dotbabel-list.mjs");
const SHOW_BIN = join(BIN_DIR, "dotbabel-show.mjs");
const INDEX_BIN = join(BIN_DIR, "dotbabel-index.mjs");

function mkRepo() {
  const root = mkdtempSync(join(tmpdir(), "dc-phase3-"));
  mkdirSync(join(root, "skills", "infra-tool"), { recursive: true });
  mkdirSync(join(root, "commands"), { recursive: true });
  mkdirSync(join(root, "agents"), { recursive: true });
  return root;
}

function writeAgent(root, slug, overrides = {}) {
  const fm = {
    name: slug,
    type: "agent",
    description: `${slug} agent description.`,
    tools: "Read, Grep",
    model: "sonnet",
    ...overrides,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: "${v}"`)
    .join("\n");
  writeFileSync(join(root, "agents", `${slug}.md`), `---\n${yaml}\n---\n\nAgent body.\n`);
}

function writeSkill(root, slug, overrides = {}) {
  const fm = {
    id: slug,
    name: slug,
    type: "skill",
    description: `${slug} skill description.`,
    version: "1.0.0",
    domain: ["infra"],
    platform: ["kubernetes"],
    task: ["debugging"],
    maturity: "validated",
    owner: "@test",
    created: "2025-01-01",
    updated: "2026-04-17",
    ...overrides,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.join(", ")}]`;
      if (typeof v === "string") return `${k}: "${v}"`;
      return `${k}: ${v}`;
    })
    .join("\n");
  const slugDir = join(root, "skills", slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, "SKILL.md"), `---\n${yaml}\n---\n\nBody.\n`);
}

function writeCommand(root, slug, overrides = {}) {
  const fm = {
    id: slug,
    name: slug,
    type: "command",
    description: `${slug} command description.`,
    version: "1.0.0",
    domain: ["devex"],
    platform: ["none"],
    task: ["review"],
    maturity: "validated",
    owner: "@test",
    created: "2025-01-01",
    updated: "2026-04-17",
    ...overrides,
  };
  const yaml = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.join(", ")}]`;
      if (typeof v === "string") return `${k}: "${v}"`;
      return `${k}: ${v}`;
    })
    .join("\n");
  writeFileSync(join(root, "commands", `${slug}.md`), `---\n${yaml}\n---\n\nBody.\n`);
}

function buildIndex(root) {
  const result = spawnSync(
    process.execPath,
    [INDEX_BIN, "--repo-root", root, "--no-color"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`index build failed: ${result.stderr}`);
  return root;
}

describe("dotbabel-search", () => {
  it("exits 0 and returns a matching artifact by name", () => {
    const root = mkRepo();
    writeSkill(root, "kube-debugger");
    writeCommand(root, "review-pr");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SEARCH_BIN, "kube", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("kube-debugger");
    expect(r.stdout).not.toContain("review-pr");
  });

  it("exits 0 and returns multiple matches for a broad query", () => {
    const root = mkRepo();
    writeSkill(root, "kube-probe");
    writeSkill(root, "kube-deploy");
    writeCommand(root, "git-review");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SEARCH_BIN, "kube", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("kube-probe");
    expect(r.stdout).toContain("kube-deploy");
    expect(r.stdout).not.toContain("git-review");
  });

  it("exits 0 with empty output when no artifact matches", () => {
    const root = mkRepo();
    writeSkill(root, "aws-tool");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SEARCH_BIN, "zzz-nomatch", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("no matches");
  });

  it("outputs valid JSON when --json is passed", () => {
    const root = mkRepo();
    writeSkill(root, "kube-debugger");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SEARCH_BIN, "kube", "--repo-root", root, "--json"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((e) => e.id === "kube-debugger")).toBe(true);
  });

  it("searches description text, not just id/name", () => {
    const root = mkRepo();
    writeSkill(root, "my-tool", { description: "helps you audit AWS IAM policies" });
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SEARCH_BIN, "IAM", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("my-tool");
  });

  it("exits 2 when index/artifacts.json does not exist", () => {
    const root = mkRepo();
    writeSkill(root, "some-skill");
    // deliberately do NOT run buildIndex

    const r = spawnSync(
      process.execPath,
      [SEARCH_BIN, "some", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("index not found");
  });

  it("exits 64 when called without a query argument", () => {
    const r = spawnSync(process.execPath, [SEARCH_BIN, "--no-color"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("usage:");
  });
});

describe("dotbabel-list", () => {
  it("lists all artifacts when no filters given", () => {
    const root = mkRepo();
    writeSkill(root, "kube-tool");
    writeCommand(root, "my-cmd");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [LIST_BIN, "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("kube-tool");
    expect(r.stdout).toContain("my-cmd");
  });

  it("filters by --type", () => {
    const root = mkRepo();
    writeSkill(root, "infra-skill");
    writeCommand(root, "dev-cmd");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [LIST_BIN, "--type", "skill", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("infra-skill");
    expect(r.stdout).not.toContain("dev-cmd");
  });

  it("filters by --domain", () => {
    const root = mkRepo();
    writeSkill(root, "infra-skill", { domain: ["infra"] });
    writeCommand(root, "devex-cmd", { domain: ["devex"] });
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [LIST_BIN, "--domain", "infra", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("infra-skill");
    expect(r.stdout).not.toContain("devex-cmd");
  });

  it("filters by --maturity", () => {
    const root = mkRepo();
    writeSkill(root, "stable-skill", { maturity: "production" });
    writeSkill(root, "draft-skill", { maturity: "draft" });
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [LIST_BIN, "--maturity", "production", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("stable-skill");
    expect(r.stdout).not.toContain("draft-skill");
  });

  it("outputs valid JSON when --json is passed", () => {
    const root = mkRepo();
    writeSkill(root, "kube-tool");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [LIST_BIN, "--json", "--repo-root", root],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((e) => e.id === "kube-tool")).toBe(true);
  });

  it("exits 2 when index does not exist", () => {
    const root = mkRepo();
    const r = spawnSync(
      process.execPath,
      [LIST_BIN, "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(2);
  });
});

describe("dotbabel-show", () => {
  it("exits 0 and displays an artifact by id", () => {
    const root = mkRepo();
    writeSkill(root, "kube-debugger", {
      description: "Debugs Kubernetes pods in a structured way.",
    });
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SHOW_BIN, "kube-debugger", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("kube-debugger");
    expect(r.stdout).toContain("Debugs Kubernetes pods");
  });

  it("exits 1 when artifact id does not exist", () => {
    const root = mkRepo();
    writeSkill(root, "existing-skill");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SHOW_BIN, "no-such-artifact", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no-such-artifact");
  });

  it("outputs valid JSON when --json is passed", () => {
    const root = mkRepo();
    writeSkill(root, "kube-tool");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SHOW_BIN, "kube-tool", "--json", "--repo-root", root],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.id).toBe("kube-tool");
    expect(parsed.type).toBe("skill");
  });

  it("exits 2 when index does not exist", () => {
    const root = mkRepo();
    const r = spawnSync(
      process.execPath,
      [SHOW_BIN, "any-id", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(2);
  });

  it("exits 64 when called without an id argument", () => {
    const r = spawnSync(process.execPath, [SHOW_BIN, "--no-color"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("usage:");
  });

  it("--type selects the correct artifact when agent and skill share an id", () => {
    const root = mkRepo();
    writeSkill(root, "domain-tool");
    writeAgent(root, "domain-tool");
    buildIndex(root);

    const rSkill = spawnSync(
      process.execPath,
      [SHOW_BIN, "domain-tool", "--type", "skill", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(rSkill.status).toBe(0);
    expect(rSkill.stdout).toContain("type:        skill");

    const rAgent = spawnSync(
      process.execPath,
      [SHOW_BIN, "domain-tool", "--type", "agent", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(rAgent.status).toBe(0);
    expect(rAgent.stdout).toContain("type:        agent");
  });

  it("warns to stderr but exits 0 when multiple artifacts share an id and --type is omitted", () => {
    const root = mkRepo();
    writeSkill(root, "shared-id");
    writeAgent(root, "shared-id");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SHOW_BIN, "shared-id", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/multiple artifacts share id "shared-id"/);
    expect(r.stderr).toMatch(/--type/);
  });

  it("exits 1 with ambiguous message when --type doesn't match any artifact with that id", () => {
    const root = mkRepo();
    writeSkill(root, "skill-only");
    buildIndex(root);

    const r = spawnSync(
      process.execPath,
      [SHOW_BIN, "skill-only", "--type", "agent", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found as agent/);
  });
});

describe("dotbabel-index --strict", () => {
  it("exits 0 in strict mode when all artifacts are valid", () => {
    const root = mkRepo();
    writeSkill(root, "valid-skill");
    const r = spawnSync(
      process.execPath,
      [INDEX_BIN, "--strict", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
  });

  it("exits 1 in strict mode when an artifact has schema validation warnings", () => {
    const root = mkRepo();
    // Legacy artifact with no required taxonomy fields → schema warnings
    writeFileSync(
      join(root, "commands", "legacy.md"),
      "---\nname: legacy\ndescription: old.\n---\nBody.\n",
    );
    const r = spawnSync(
      process.execPath,
      [INDEX_BIN, "--strict", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/warning|strict/i);
  });
});
