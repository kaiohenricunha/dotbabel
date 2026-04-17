import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  walkArtifacts,
  parseFrontmatter,
  buildIndex,
  validateArtifacts,
  isIndexStale,
  SCHEMAS_DIR,
} from "../src/build-index.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, "..", "..", "..", "..");
const BIN_PATH = join(
  REPO_ROOT,
  "plugins",
  "dotclaude",
  "bin",
  "dotclaude-index.mjs",
);

function mkRepo() {
  return mkdtempSync(join(tmpdir(), "taxonomy-phase1-"));
}

function writeFile(repoRoot, rel, content) {
  const abs = join(repoRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

const NEW_STYLE_SKILL = `---
id: test-skill
name: test-skill
type: skill
description: A skill used for taxonomy tests.
version: 1.0.0
domain: [infra, observability]
platform: [kubernetes]
task: [debugging]
maturity: validated
owner: kaio
created: 2026-01-15
updated: 2026-04-01
model: inherit
---

Body.
`;

const LEGACY_SKILL = `---
name: legacy-skill
description: A legacy skill with only the two minimal fields.
---

Body.
`;

const INVALID_ENUM_SKILL = `---
id: bogus-skill
name: bogus-skill
type: skill
description: has a bogus domain value.
domain: [nonsense]
maturity: validated
---

Body.
`;

const SAMPLE_AGENT = `---
id: sample-agent
name: sample-agent
type: agent
description: Example agent.
model: sonnet
tools: [Read, Grep]
domain: [backend]
maturity: draft
---

Body.
`;

const SAMPLE_COMMAND = `---
id: sample-command
name: sample-command
type: command
description: Example command.
model: haiku
domain: [devex]
task: [review]
maturity: production
---

Body.
`;

const SAMPLE_HOOK = `---
id: sample-hook
name: sample-hook
type: hook
description: Example hook wrapper.
event: PreToolUse
domain: [security]
maturity: draft
---

Wrapper body.
`;

describe("parseFrontmatter", () => {
  it("parses inline arrays", () => {
    const { frontmatter, warnings } = parseFrontmatter(
      "---\nname: x\ndomain: [infra, observability]\n---\nBody\n",
    );
    expect(warnings).toEqual([]);
    expect(frontmatter.name).toBe("x");
    expect(frontmatter.domain).toEqual(["infra", "observability"]);
  });

  it("parses block arrays", () => {
    const { frontmatter, warnings } = parseFrontmatter(
      "---\nname: x\ndomain:\n  - infra\n  - observability\n---\nBody\n",
    );
    expect(warnings).toEqual([]);
    expect(frontmatter.domain).toEqual(["infra", "observability"]);
  });

  it("warns when no frontmatter is present", () => {
    const { frontmatter, warnings } = parseFrontmatter("Just a body.\n");
    expect(frontmatter).toEqual({});
    expect(warnings[0]).toMatch(/no YAML frontmatter/);
  });

  it("warns on unterminated frontmatter", () => {
    const { warnings } = parseFrontmatter("---\nname: x\nno-closer\n");
    expect(warnings[0]).toMatch(/unterminated/);
  });

  it("warns on YAML syntax errors", () => {
    const { warnings } = parseFrontmatter(
      '---\nname: x\nval: "unterminated\n---\nbody\n',
    );
    expect(warnings[0]).toMatch(/parse error/);
  });
});

describe("walkArtifacts", () => {
  it("returns empty array for a repo with no artifact dirs", () => {
    const root = mkRepo();
    const artifacts = walkArtifacts(root);
    expect(artifacts).toEqual([]);
  });

  it("discovers skill, command, agent, hook, and template artifacts", () => {
    const root = mkRepo();
    writeFile(root, "skills/test-skill/SKILL.md", NEW_STYLE_SKILL);
    writeFile(root, "commands/sample-command.md", SAMPLE_COMMAND);
    writeFile(root, "agents/sample-agent.md", SAMPLE_AGENT);
    writeFile(root, "hooks/sample-hook.md", SAMPLE_HOOK);
    writeFile(
      root,
      "templates/sample/template.yaml",
      "id: sample\nname: sample\ntype: template\ndescription: tpl\nscaffolds: file\n",
    );
    const artifacts = walkArtifacts(root);
    const byType = artifacts.reduce((acc, a) => {
      acc[a.type] = (acc[a.type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({
      skill: 1,
      command: 1,
      agent: 1,
      hook: 1,
      template: 1,
    });
  });

  it("supports both flat skills and dir-per-skill layouts", () => {
    const root = mkRepo();
    writeFile(root, "skills/new-style/SKILL.md", NEW_STYLE_SKILL);
    writeFile(root, "skills/flat-skill.md", LEGACY_SKILL);
    const artifacts = walkArtifacts(root);
    expect(artifacts.filter((a) => a.type === "skill")).toHaveLength(2);
  });
});

describe("buildIndex", () => {
  it("produces an empty-but-valid bundle from no artifacts", () => {
    const { artifactsJson, byType, byFacet } = buildIndex([]);
    expect(artifactsJson.artifacts).toEqual([]);
    expect(byType).toEqual({
      agent: [],
      skill: [],
      command: [],
      hook: [],
      template: [],
    });
    expect(byFacet).toEqual({
      domain: {},
      platform: {},
      task: {},
      maturity: {},
    });
  });

  it("sorts entries by id and routes a full-metadata skill into every bucket", () => {
    const root = mkRepo();
    writeFile(root, "skills/test-skill/SKILL.md", NEW_STYLE_SKILL);
    const artifacts = walkArtifacts(root);
    const { artifactsJson, byType, byFacet } = buildIndex(artifacts);
    expect(artifactsJson.artifacts).toHaveLength(1);
    const entry = artifactsJson.artifacts[0];
    expect(entry.id).toBe("test-skill");
    expect(entry.facets.domain).toEqual(["infra", "observability"]);
    expect(entry.facets.platform).toEqual(["kubernetes"]);
    expect(entry.facets.task).toEqual(["debugging"]);
    expect(entry.facets.maturity).toBe("validated");
    expect(byType.skill).toEqual(["test-skill"]);
    expect(byFacet.domain.infra).toEqual(["test-skill"]);
    expect(byFacet.domain.observability).toEqual(["test-skill"]);
    expect(byFacet.platform.kubernetes).toEqual(["test-skill"]);
    expect(byFacet.task.debugging).toEqual(["test-skill"]);
    expect(byFacet.maturity.validated).toEqual(["test-skill"]);
  });

  it("accepts legacy skills but omits them from facet buckets they don't declare", () => {
    const root = mkRepo();
    writeFile(root, "skills/legacy/SKILL.md", LEGACY_SKILL);
    const artifacts = walkArtifacts(root);
    const { artifactsJson, byType, byFacet } = buildIndex(artifacts);
    expect(artifactsJson.artifacts).toHaveLength(1);
    const entry = artifactsJson.artifacts[0];
    expect(entry.facets.domain).toEqual([]);
    expect(entry.facets.platform).toEqual([]);
    expect(entry.facets.task).toEqual([]);
    // default maturity applied.
    expect(entry.facets.maturity).toBe("draft");
    expect(byType.skill).toEqual([entry.id]);
    expect(byFacet.domain).toEqual({});
    // maturity default bucket still used.
    expect(byFacet.maturity.draft).toEqual([entry.id]);
  });

  it("classifies a command + skill + agent + hook side-by-side into the correct buckets", () => {
    const root = mkRepo();
    writeFile(root, "skills/test-skill/SKILL.md", NEW_STYLE_SKILL);
    writeFile(root, "commands/sample-command.md", SAMPLE_COMMAND);
    writeFile(root, "agents/sample-agent.md", SAMPLE_AGENT);
    writeFile(root, "hooks/sample-hook.md", SAMPLE_HOOK);
    const { byType, byFacet } = buildIndex(walkArtifacts(root));
    expect(byType.skill).toContain("test-skill");
    expect(byType.command).toContain("sample-command");
    expect(byType.agent).toContain("sample-agent");
    expect(byType.hook).toContain("sample-hook");
    expect(byFacet.domain.infra).toEqual(["test-skill"]);
    expect(byFacet.domain.backend).toEqual(["sample-agent"]);
    expect(byFacet.domain.devex).toEqual(["sample-command"]);
    expect(byFacet.domain.security).toEqual(["sample-hook"]);
  });
});

describe("validateArtifacts", () => {
  it("returns warnings (not errors) for invalid enum values", () => {
    const root = mkRepo();
    writeFile(root, "skills/bogus/SKILL.md", INVALID_ENUM_SKILL);
    const artifacts = walkArtifacts(root);
    const { warnings } = validateArtifacts(artifacts, SCHEMAS_DIR);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /domain/.test(w))).toBe(true);
    // artifact still appears in the index.
    const { artifactsJson } = buildIndex(artifacts);
    expect(artifactsJson.artifacts).toHaveLength(1);
  });

  it("is silent for a fully valid skill", () => {
    const root = mkRepo();
    writeFile(root, "skills/test-skill/SKILL.md", NEW_STYLE_SKILL);
    const { warnings } = validateArtifacts(walkArtifacts(root), SCHEMAS_DIR);
    expect(warnings).toEqual([]);
  });

  it("emits warnings for legacy artifacts' parse-time quirks but not for missing fields", () => {
    const root = mkRepo();
    writeFile(root, "skills/legacy/SKILL.md", LEGACY_SKILL);
    // Phase 1: no required fields, so the schema is silent; only artifact
    // parse warnings (if any) surface. Legacy has valid frontmatter, so:
    const { warnings } = validateArtifacts(walkArtifacts(root), SCHEMAS_DIR);
    expect(warnings).toEqual([]);
  });
});

describe("isIndexStale", () => {
  it("returns true when no index exists on disk", () => {
    const root = mkRepo();
    expect(isIndexStale(root)).toBe(true);
  });

  it("returns false after a matching index has been written", () => {
    const root = mkRepo();
    writeFile(root, "skills/test-skill/SKILL.md", NEW_STYLE_SKILL);
    const bundle = buildIndex(walkArtifacts(root));
    mkdirSync(join(root, "index"));
    writeFileSync(
      join(root, "index", "artifacts.json"),
      JSON.stringify(bundle.artifactsJson, null, 2) + "\n",
    );
    writeFileSync(
      join(root, "index", "by-type.json"),
      JSON.stringify(bundle.byType, null, 2) + "\n",
    );
    writeFileSync(
      join(root, "index", "by-facet.json"),
      JSON.stringify(bundle.byFacet, null, 2) + "\n",
    );
    expect(isIndexStale(root)).toBe(false);
  });

  it("returns true after editing an artifact without rebuilding the index", () => {
    const root = mkRepo();
    writeFile(root, "skills/test-skill/SKILL.md", NEW_STYLE_SKILL);
    const bundle = buildIndex(walkArtifacts(root));
    mkdirSync(join(root, "index"));
    writeFileSync(
      join(root, "index", "artifacts.json"),
      JSON.stringify(bundle.artifactsJson, null, 2) + "\n",
    );
    writeFileSync(
      join(root, "index", "by-type.json"),
      JSON.stringify(bundle.byType, null, 2) + "\n",
    );
    writeFileSync(
      join(root, "index", "by-facet.json"),
      JSON.stringify(bundle.byFacet, null, 2) + "\n",
    );
    // Modify the artifact — index no longer matches.
    writeFile(
      root,
      "skills/test-skill/SKILL.md",
      NEW_STYLE_SKILL.replace("validated", "production"),
    );
    expect(isIndexStale(root)).toBe(true);
  });
});

describe("CLI: dotclaude-index --check", () => {
  it("exits 0 on a fresh index and non-zero on a stale one", () => {
    const root = mkRepo();
    writeFile(root, "skills/test-skill/SKILL.md", NEW_STYLE_SKILL);

    // First, rebuild.
    const build = spawnSync(
      process.execPath,
      [BIN_PATH, "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(build.status).toBe(0);
    expect(existsSync(join(root, "index", "artifacts.json"))).toBe(true);
    expect(existsSync(join(root, "index", "by-type.json"))).toBe(true);
    expect(existsSync(join(root, "index", "by-facet.json"))).toBe(true);
    expect(existsSync(join(root, "index", "README.md"))).toBe(true);

    // Check — should pass.
    const check = spawnSync(
      process.execPath,
      [BIN_PATH, "--check", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(check.status).toBe(0);

    // Now mutate an artifact and re-check — should fail.
    writeFile(
      root,
      "skills/test-skill/SKILL.md",
      NEW_STYLE_SKILL.replace("validated", "production"),
    );
    const checkStale = spawnSync(
      process.execPath,
      [BIN_PATH, "--check", "--repo-root", root, "--no-color"],
      { encoding: "utf8" },
    );
    expect(checkStale.status).toBe(1);
  });
});

describe("schema round-trip", () => {
  it("compiles every schema file without error", async () => {
    const { default: Ajv } = await import("ajv/dist/2020.js");
    const { default: addFormats } = await import("ajv-formats");
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const schemas = [
      "facets",
      "common",
      "agent",
      "skill",
      "command",
      "hook",
      "template",
      "index-entry",
    ];
    for (const s of schemas) {
      const raw = JSON.parse(
        readFileSync(join(SCHEMAS_DIR, `${s}.schema.json`), "utf8"),
      );
      expect(() => ajv.addSchema(raw)).not.toThrow();
    }
    for (const s of schemas) {
      const fn = ajv.getSchema(
        `https://dotclaude.dev/schemas/${s}.schema.json`,
      );
      expect(fn).toBeTypeOf("function");
    }
  });

  it("skill schema accepts a valid example and rejects an invalid enum", async () => {
    const { default: Ajv } = await import("ajv/dist/2020.js");
    const { default: addFormats } = await import("ajv-formats");
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const s of [
      "facets",
      "common",
      "agent",
      "skill",
      "command",
      "hook",
      "template",
      "index-entry",
    ]) {
      ajv.addSchema(
        JSON.parse(readFileSync(join(SCHEMAS_DIR, `${s}.schema.json`), "utf8")),
      );
    }
    const skillValidate = ajv.getSchema(
      "https://dotclaude.dev/schemas/skill.schema.json",
    );
    expect(
      skillValidate({
        id: "ok-skill",
        type: "skill",
        name: "ok",
        description: "ok",
        domain: ["infra"],
        maturity: "production",
      }),
    ).toBe(true);
    expect(
      skillValidate({
        id: "bad-skill",
        type: "skill",
        domain: ["nonsense"],
      }),
    ).toBe(false);
  });

  it("index-entry schema requires id, type, path, name, description, facets", async () => {
    const { default: Ajv } = await import("ajv/dist/2020.js");
    const { default: addFormats } = await import("ajv-formats");
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    for (const s of [
      "facets",
      "common",
      "agent",
      "skill",
      "command",
      "hook",
      "template",
      "index-entry",
    ]) {
      ajv.addSchema(
        JSON.parse(readFileSync(join(SCHEMAS_DIR, `${s}.schema.json`), "utf8")),
      );
    }
    const validate = ajv.getSchema(
      "https://dotclaude.dev/schemas/index-entry.schema.json",
    );
    expect(
      validate({
        id: "x",
        type: "skill",
        path: "skills/x/SKILL.md",
        name: "x",
        description: "x",
        facets: { domain: [], platform: [], task: [], maturity: "draft" },
      }),
    ).toBe(true);
    expect(validate({ id: "x" })).toBe(false);
  });
});
