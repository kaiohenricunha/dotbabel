import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path, { resolve } from "path";
import { readFileSync, writeFileSync, mkdtempSync, cpSync, unlinkSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { createHarnessContext } from "../src/spec-harness-lib.mjs";
import {
  validateManifest,
  refreshChecksums,
  validateAgents,
  validateAgentTriggerOverlap,
} from "../src/validate-skills-inventory.mjs";
import { ValidationError, ERROR_CODES } from "../src/lib/errors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.join(__dirname, "fixtures", "minimal-repo");

function isolateFixture() {
  const dst = mkdtempSync(path.join(tmpdir(), "harness-test-"));
  cpSync(FIXTURE_SRC, dst, { recursive: true });
  return dst;
}

describe("validateManifest", () => {
  it("passes when all manifest entries exist and checksums match", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const result = validateManifest(ctx);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("emits MANIFEST_ENTRY_MISSING when a manifest entry references a missing file", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const manifestPath = path.join(root, ".claude", "skills-manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    m.skills[0].path = ".claude/commands/does-not-exist.md";
    writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    const result = validateManifest(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBeInstanceOf(ValidationError);
    expect(result.errors[0].code).toBe(ERROR_CODES.MANIFEST_ENTRY_MISSING);
    expect(result.errors[0].message).toMatch(/File not found/);
  });

  it("emits MANIFEST_CHECKSUM_MISMATCH when a checksum is stale", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    writeFileSync(path.join(root, ".claude", "commands", "example.md"), "# modified\n");
    const result = validateManifest(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBeInstanceOf(ValidationError);
    expect(result.errors[0].code).toBe(ERROR_CODES.MANIFEST_CHECKSUM_MISMATCH);
    expect(result.errors[0].message).toMatch(/Checksum mismatch/);
  });

  it("emits MANIFEST_ORPHAN_FILE when a file on disk is not in the manifest", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    writeFileSync(path.join(root, ".claude", "commands", "orphan.md"), "# orphan\n");
    const result = validateManifest(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.MANIFEST_ORPHAN_FILE)).toBe(true);
    expect(result.errors.join("\n")).toMatch(/orphan/);
  });
});

describe("validateManifest — DAG cycle detection", () => {
  it("reports MANIFEST_DEPENDENCY_CYCLE when deps[] form a cycle", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const manifestPath = path.join(root, ".claude", "skills-manifest.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    // Seed a cycle: first -> other -> first.
    m.skills.push({
      name: "other",
      path: m.skills[0].path,
      checksum: m.skills[0].checksum,
      dependencies: [m.skills[0].name],
    });
    m.skills[0].dependencies = ["other"];
    writeFileSync(manifestPath, JSON.stringify(m, null, 2));
    const result = validateManifest(ctx);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === ERROR_CODES.MANIFEST_DEPENDENCY_CYCLE)).toBe(true);
  });
});

describe("validateManifest — error paths", () => {
  it("throws when the manifest file is missing", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const manifestPath = path.join(root, ".claude", "skills-manifest.json");
    unlinkSync(manifestPath);
    expect(() => validateManifest(ctx)).toThrow(/Manifest not found/);
  });

  it("indexes directory-form skills with SKILL.md + ignores other entries", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    const skillDir = path.join(root, ".claude", "skills", "example-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# example skill\n");
    writeFileSync(path.join(skillDir, "NOTES.md"), "# notes\n");
    const result = validateManifest(ctx);
    expect(result.ok).toBe(false);
    const orphanMsgs = result.errors.filter((e) => e.code === ERROR_CODES.MANIFEST_ORPHAN_FILE);
    expect(orphanMsgs.some((e) => e.message.includes("example-skill/SKILL.md"))).toBe(true);
    expect(orphanMsgs.every((e) => !e.message.includes("NOTES.md"))).toBe(true);
  });
});

describe("refreshChecksums", () => {
  it("rewrites stale checksums in place", () => {
    const root = isolateFixture();
    const ctx = createHarnessContext({ repoRoot: root });
    writeFileSync(path.join(root, ".claude", "commands", "example.md"), "# modified\n");
    refreshChecksums(ctx);
    const result = validateManifest(ctx);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateAgents
// ---------------------------------------------------------------------------

function makeAgentDir() {
  const tmp = mkdtempSync(path.join(tmpdir(), "agent-test-"));
  mkdirSync(path.join(tmp, "agents"), { recursive: true });
  return tmp;
}

function writeAgent(dir, filename, content) {
  writeFileSync(path.join(dir, "agents", filename), content, "utf8");
}

const VALID_AGENT = `---
name: my-agent
description: Does something useful
tools: Read, Grep
model: sonnet
---

This is a valid agent body.
`;

describe("validateAgents — valid agent", () => {
  it("passes when all required fields are present and model is valid", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "my-agent.md", VALID_AGENT);
    const result = validateAgents(dir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("validateAgents — missing required fields", () => {
  it("emits AGENT_MISSING_FIELD when model: is absent", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "no-model.md", `---
name: no-model
description: Missing model field
tools: Read
---

Body here.
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === ERROR_CODES.AGENT_MISSING_FIELD);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/model/);
    expect(err.file).toMatch(/no-model\.md/);
  });

  it("emits AGENT_MISSING_FIELD when name: is absent", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "no-name.md", `---
description: No name
tools: Read
model: haiku
---
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === ERROR_CODES.AGENT_MISSING_FIELD);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/name/);
  });

  it("emits AGENT_MISSING_FIELD when description: is absent", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "no-desc.md", `---
name: no-desc
tools: Read
model: haiku
---
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === ERROR_CODES.AGENT_MISSING_FIELD);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/description/);
  });

  it("emits AGENT_MISSING_FIELD when tools: is absent", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "no-tools.md", `---
name: no-tools
description: No tools
model: haiku
---
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === ERROR_CODES.AGENT_MISSING_FIELD);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/tools/);
  });
});

describe("validateAgents — invalid model value", () => {
  it("emits AGENT_INVALID_MODEL when model value is not in the allowed set", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "bad-model.md", `---
name: bad-model
description: Bad model value
tools: Read
model: turbo
---
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === ERROR_CODES.AGENT_INVALID_MODEL);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/turbo/);
    expect(err.message).toMatch(/opus|sonnet|haiku|inherit/);
    expect(err.file).toMatch(/bad-model\.md/);
  });

  it("accepts all four valid model values", () => {
    for (const model of ["opus", "sonnet", "haiku", "inherit"]) {
      const dir = makeAgentDir();
      writeAgent(dir, `${model}-agent.md`, `---
name: ${model}-agent
description: Testing ${model}
tools: Read
model: ${model}
---
`);
      const result = validateAgents(dir);
      expect(result.ok).toBe(true, `model "${model}" should be valid`);
    }
  });
});

describe("validateAgents — SEC-2 read-only agents must not have write tools", () => {
  it("emits AGENT_WRITE_TOOL_IN_READONLY when *-reviewer has Write in tools", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "code-reviewer.md", `---
name: code-reviewer
description: Reviews code
tools: Read, Write, Grep
model: sonnet
---
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === ERROR_CODES.AGENT_WRITE_TOOL_IN_READONLY);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Write/);
    expect(err.file).toMatch(/code-reviewer\.md/);
  });

  it("emits AGENT_WRITE_TOOL_IN_READONLY when *-auditor has Edit in tools", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "security-auditor.md", `---
name: security-auditor
description: Audits security
tools: Read, Edit
model: opus
---
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === ERROR_CODES.AGENT_WRITE_TOOL_IN_READONLY);
    expect(err).toBeDefined();
    expect(err.message).toMatch(/Edit/);
  });

  it("emits AGENT_WRITE_TOOL_IN_READONLY when *-inspector has Write in tools", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "log-inspector.md", `---
name: log-inspector
description: Inspects logs
tools: Bash, Write
model: haiku
---
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === ERROR_CODES.AGENT_WRITE_TOOL_IN_READONLY);
    expect(err).toBeDefined();
  });

  it("does NOT flag a non-readonly agent that has Write in tools", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "backend-developer.md", `---
name: backend-developer
description: Develops backends
tools: Read, Write, Edit
model: sonnet
---
`);
    const result = validateAgents(dir);
    expect(result.ok).toBe(true);
    expect(result.errors.filter((e) => e.code === ERROR_CODES.AGENT_WRITE_TOOL_IN_READONLY)).toHaveLength(0);
  });
});

describe("validateAgents — SEC-1 secret pattern detection", () => {
  it("emits AGENT_SECRET_PATTERN warning when ghp_ appears in body", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "risky-agent.md", `---
name: risky-agent
description: Has secrets
tools: Read
model: haiku
---

# Config
token = ghp_abc123secrettoken
`);
    const result = validateAgents(dir);
    // Warnings do not cause ok=false, only errors do
    expect(result.warnings.length).toBeGreaterThan(0);
    const warn = result.warnings.find((w) => w.code === ERROR_CODES.AGENT_SECRET_PATTERN);
    expect(warn).toBeDefined();
    expect(warn.message).toMatch(/ghp_/);
    expect(warn.file).toMatch(/risky-agent\.md/);
  });

  it("emits AGENT_SECRET_PATTERN warning for sk- pattern", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "sk-agent.md", `---
name: sk-agent
description: Has a key
tools: Read
model: haiku
---

key = sk-abcdef123456
`);
    const result = validateAgents(dir);
    const warn = result.warnings.find((w) => w.code === ERROR_CODES.AGENT_SECRET_PATTERN);
    expect(warn).toBeDefined();
    expect(warn.message).toMatch(/sk-/);
  });

  it("valid agent with no secrets produces no warnings", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "clean-agent.md", VALID_AGENT);
    const result = validateAgents(dir);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateAgents — shipped template agents
// ---------------------------------------------------------------------------

describe("validateAgents — shipped template agents", () => {
  it("returns 0 errors for all agents in templates/claude/agents/", () => {
    const repoRoot = resolve(__dirname, "..", "..", "..");
    const agentsDir = resolve(repoRoot, "plugins", "dotclaude", "templates", "claude");
    const result = validateAgents(agentsDir);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateAgentTriggerOverlap
// ---------------------------------------------------------------------------

const AGENT_A_NO_OVERLAP = `---
name: agent-a
description: >
  Triggers on: "alpha-keyword", "agent-a-only".
tools: Read
model: sonnet
---

## Collaboration

- Hand off frontend concerns to agent-b.
`;

const AGENT_B_DISJOINT = `---
name: agent-b
description: >
  Triggers on: "beta-keyword", "agent-b-only".
tools: Read
model: sonnet
---

## Collaboration

- Hand off frontend concerns to agent-a.
`;

const AGENT_OVERLAPPING_LEFT = `---
name: agent-left
description: >
  Triggers on: "shared-keyword", "left-only".
tools: Read
model: sonnet
---

## Collaboration

- Hand off cluster concerns to agent-right.
`;

const AGENT_OVERLAPPING_RIGHT_NO_HANDOFF = `---
name: agent-right
description: >
  Triggers on: "shared-keyword", "right-only".
tools: Read
model: sonnet
---

## Collaboration

- Coordinate with the platform team for production rollouts.
`;

describe("validateAgentTriggerOverlap", () => {
  it("emits no warnings when agents have disjoint trigger keywords", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "agent-a.md", AGENT_A_NO_OVERLAP);
    writeAgent(dir, "agent-b.md", AGENT_B_DISJOINT);
    const result = validateAgentTriggerOverlap(dir);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("emits no warnings when overlapping agents reference each other in ## Collaboration", () => {
    const dir = makeAgentDir();
    // Both agents share "shared-keyword" but each names the other in collaboration.
    writeAgent(dir, "agent-left.md", AGENT_OVERLAPPING_LEFT);
    writeAgent(dir, "agent-right.md", `---
name: agent-right
description: >
  Triggers on: "shared-keyword", "right-only".
tools: Read
model: sonnet
---

## Collaboration

- Hand off platform concerns to agent-left.
`);
    const result = validateAgentTriggerOverlap(dir);
    expect(result.warnings).toEqual([]);
  });

  it("emits AGENT_TRIGGER_OVERLAP warning when an overlapping agent does not reference the other", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "agent-left.md", AGENT_OVERLAPPING_LEFT);
    writeAgent(dir, "agent-right.md", AGENT_OVERLAPPING_RIGHT_NO_HANDOFF);
    const result = validateAgentTriggerOverlap(dir);
    // agent-right does not reference agent-left in its collaboration → warning expected
    const warn = result.warnings.find(
      (w) => w.code === ERROR_CODES.AGENT_TRIGGER_OVERLAP && w.file.includes("agent-right"),
    );
    expect(warn).toBeDefined();
    expect(warn.message).toMatch(/shared-keyword/);
    expect(warn.message).toMatch(/agent-left/);
  });

  it("is case-insensitive on trigger keywords", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "uppercase.md", `---
name: uppercase
description: >
  Triggers on: "SHARED".
tools: Read
model: sonnet
---

Body.
`);
    writeAgent(dir, "lowercase.md", `---
name: lowercase
description: >
  Triggers on: "shared".
tools: Read
model: sonnet
---

Body.
`);
    const result = validateAgentTriggerOverlap(dir);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("ok=true even when warnings exist (advisory only)", () => {
    const dir = makeAgentDir();
    writeAgent(dir, "agent-left.md", AGENT_OVERLAPPING_LEFT);
    writeAgent(dir, "agent-right.md", AGENT_OVERLAPPING_RIGHT_NO_HANDOFF);
    const result = validateAgentTriggerOverlap(dir);
    expect(result.ok).toBe(true); // warnings don't fail validation
    expect(result.errors).toEqual([]);
  });
});
