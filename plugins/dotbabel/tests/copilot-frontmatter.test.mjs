import { describe, it, expect } from "vitest";
import {
  normalizeToolsList,
  mapCommandFrontmatter,
  mapSkillFrontmatter,
  renderFrontmatterBlock,
  isGeneratedFile,
  composeGeneratedFrontmatter,
  GENERATED_MARKER_PREFIX,
  DEFAULT_APPLY_TO,
} from "../src/copilot-frontmatter.mjs";
import { parseFrontmatter } from "../src/build-index.mjs";

describe("normalizeToolsList", () => {
  it("splits a space-separated string", () => {
    expect(normalizeToolsList("Read Grep Glob Bash")).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
    ]);
  });

  it("splits a comma-separated string", () => {
    expect(normalizeToolsList("Read, Grep, Glob")).toEqual([
      "Read",
      "Grep",
      "Glob",
    ]);
  });

  it("splits a mixed comma/space-separated string", () => {
    expect(normalizeToolsList("Read,Grep Glob,  Bash")).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
    ]);
  });

  it("passes an array through, trimming and deduping", () => {
    expect(normalizeToolsList([" Read", "Grep", "Read"])).toEqual([
      "Read",
      "Grep",
    ]);
  });

  it("returns an empty array for undefined, null, or a non-string/array", () => {
    expect(normalizeToolsList(undefined)).toEqual([]);
    expect(normalizeToolsList(null)).toEqual([]);
    expect(normalizeToolsList(42)).toEqual([]);
  });
});

describe("mapCommandFrontmatter", () => {
  it("maps description, name, and argument-hint verbatim", () => {
    const { frontmatter, dropped } = mapCommandFrontmatter({
      description: "Do the thing.",
      name: "do-thing",
      "argument-hint": "[target]",
    });
    expect(frontmatter).toEqual({
      description: "Do the thing.",
      name: "do-thing",
      "argument-hint": "[target]",
    });
    expect(dropped).toEqual([]);
  });

  it("prefers allowed-tools over tools when both are present and differ", () => {
    const { frontmatter } = mapCommandFrontmatter({
      tools: "Read, Grep",
      "allowed-tools": "Bash Write",
    });
    expect(frontmatter.tools).toEqual(["Bash", "Write"]);
  });

  it("falls back to tools when allowed-tools is absent", () => {
    const { frontmatter } = mapCommandFrontmatter({ tools: "Read, Grep" });
    expect(frontmatter.tools).toEqual(["Read", "Grep"]);
  });

  it("omits the tools key entirely when neither is present", () => {
    const { frontmatter } = mapCommandFrontmatter({ description: "x" });
    expect(frontmatter).not.toHaveProperty("tools");
  });

  it("drops model, effort, and disable-model-invocation, reporting each", () => {
    const { frontmatter, dropped } = mapCommandFrontmatter({
      description: "x",
      model: "opus",
      effort: "high",
      "disable-model-invocation": true,
    });
    expect(frontmatter).not.toHaveProperty("model");
    expect(frontmatter).not.toHaveProperty("effort");
    expect(frontmatter).not.toHaveProperty("disable-model-invocation");
    expect(dropped.sort()).toEqual(
      ["disable-model-invocation", "effort", "model"].sort(),
    );
  });

  it("never surfaces dotbabel taxonomy keys in output or dropped", () => {
    const { frontmatter, dropped } = mapCommandFrontmatter({
      description: "x",
      id: "foo",
      type: "command",
      version: "1.0.0",
      domain: ["devex"],
      platform: ["none"],
      task: ["review"],
      maturity: "validated",
      owner: "@kaio",
      created: "2025-01-01",
      updated: "2026-04-17",
    });
    expect(Object.keys(frontmatter)).toEqual(["description"]);
    expect(dropped).toEqual([]);
  });

  it("returns an empty mapping and no drops for empty input", () => {
    expect(mapCommandFrontmatter({})).toEqual({ frontmatter: {}, dropped: [] });
  });
});

describe("mapSkillFrontmatter", () => {
  it("maps description and name, and always injects applyTo", () => {
    const { frontmatter } = mapSkillFrontmatter({ description: "x" });
    expect(frontmatter.description).toBe("x");
    expect(frontmatter.applyTo).toBe(DEFAULT_APPLY_TO);
  });

  it("injects applyTo even when the source has no frontmatter at all", () => {
    const { frontmatter } = mapSkillFrontmatter({});
    expect(frontmatter).toEqual({ applyTo: DEFAULT_APPLY_TO });
  });

  it("drops and reports both tools and allowed-tools — neither has a home on instructions.md", () => {
    const { frontmatter, dropped } = mapSkillFrontmatter({
      tools: "Read, Grep",
      "allowed-tools": "Bash",
    });
    expect(frontmatter).not.toHaveProperty("tools");
    expect(frontmatter).not.toHaveProperty("allowed-tools");
    expect(dropped.sort()).toEqual(["allowed-tools", "tools"].sort());
  });

  it("drops argument-hint silently — no instructions.md equivalent exists or ever will", () => {
    const { frontmatter, dropped } = mapSkillFrontmatter({
      "argument-hint": "[subject]",
    });
    expect(frontmatter).not.toHaveProperty("argument-hint");
    expect(dropped).toEqual([]);
  });
});

describe("renderFrontmatterBlock", () => {
  it("round-trips through parseFrontmatter", () => {
    const input = {
      description: "A thing.",
      tools: ["Read", "Grep", "Bash"],
      applyTo: "**",
    };
    const block = renderFrontmatterBlock(input);
    const wrapped = `---\n${block}---\nbody\n`;
    const { frontmatter } = parseFrontmatter(wrapped);
    expect(frontmatter).toEqual(input);
  });

  it("round-trips an empty object", () => {
    const block = renderFrontmatterBlock({});
    const wrapped = `---\n${block}---\nbody\n`;
    const { frontmatter } = parseFrontmatter(wrapped);
    expect(frontmatter).toEqual({});
  });
});

describe("isGeneratedFile", () => {
  it("is true for well-formed generated content", () => {
    const content = `---\n${GENERATED_MARKER_PREFIX} — do not edit. Source: x.\ndescription: x\n---\n\nbody\n`;
    expect(isGeneratedFile(content)).toBe(true);
  });

  it("is false for hand-authored content with a --- block but no marker", () => {
    const content = `---\ndescription: x\n---\n\nbody\n`;
    expect(isGeneratedFile(content)).toBe(false);
  });

  it("is false for content with no frontmatter block at all", () => {
    expect(isGeneratedFile("just a body\n")).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isGeneratedFile("")).toBe(false);
  });
});

describe("composeGeneratedFrontmatter", () => {
  const RICH_SOURCE = `---
id: foo
name: foo
type: command
description: Do the thing.
version: 1.0.0
domain: [devex]
platform: [none]
task: [review]
maturity: validated
owner: "@kaio"
created: 2025-01-01
updated: 2026-04-17
model: opus
effort: high
disable-model-invocation: true
allowed-tools: Read Grep Bash
---

Body line one.
Body line two.
`;

  it("maps a command's real frontmatter, dropping exactly the behavioral keys", () => {
    const { content, dropped } = composeGeneratedFrontmatter(
      RICH_SOURCE,
      "command",
      ".claude/commands/foo.md",
    );
    expect(dropped.sort()).toEqual(
      ["disable-model-invocation", "effort", "model"].sort(),
    );
    expect(content.startsWith("---\n")).toBe(true);
    const lines = content.split("\n");
    expect(lines[1].startsWith(GENERATED_MARKER_PREFIX)).toBe(true);
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.description).toBe("Do the thing.");
    expect(frontmatter.tools).toEqual(["Read", "Grep", "Bash"]);
    expect(frontmatter).not.toHaveProperty("id");
    expect(frontmatter).not.toHaveProperty("model");
    expect(body.trim()).toBe("Body line one.\nBody line two.");
  });

  it("preserves the body byte-for-byte relative to the source", () => {
    const { content } = composeGeneratedFrontmatter(
      RICH_SOURCE,
      "command",
      ".claude/commands/foo.md",
    );
    const { body: sourceBody } = parseFrontmatter(RICH_SOURCE);
    const { body: outputBody } = parseFrontmatter(content);
    expect(outputBody.trim()).toBe(sourceBody.trim());
  });

  it("handles a source with no frontmatter: marker-only block, body untouched", () => {
    const { content, dropped } = composeGeneratedFrontmatter(
      "Just a body.\n",
      "command",
      ".claude/commands/bare.md",
    );
    expect(dropped).toEqual([]);
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toEqual({});
    expect(body.trim()).toBe("Just a body.");
  });

  it("is idempotent: composing twice from the same source yields byte-identical output", () => {
    const first = composeGeneratedFrontmatter(
      RICH_SOURCE,
      "command",
      ".claude/commands/foo.md",
    );
    const second = composeGeneratedFrontmatter(
      RICH_SOURCE,
      "command",
      ".claude/commands/foo.md",
    );
    expect(second.content).toBe(first.content);
  });

  it("maps a skill's frontmatter for the instructions.md shape", () => {
    const SKILL_SOURCE = `---
id: ground-first
name: ground-first
description: Produce a grounded analysis.
tools: Read, Grep, Glob, Bash
allowed-tools: Read Grep Glob Bash
model: opus
---

Skill body.
`;
    const { content, dropped } = composeGeneratedFrontmatter(
      SKILL_SOURCE,
      "skill",
      ".claude/skills/ground-first/SKILL.md",
    );
    expect(dropped.sort()).toEqual(["allowed-tools", "model", "tools"].sort());
    const { frontmatter } = parseFrontmatter(content);
    expect(frontmatter.description).toBe("Produce a grounded analysis.");
    expect(frontmatter.applyTo).toBe(DEFAULT_APPLY_TO);
    expect(frontmatter).not.toHaveProperty("tools");
    expect(frontmatter).not.toHaveProperty("allowed-tools");
  });
});
