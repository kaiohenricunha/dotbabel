import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { materializeClaude } from "../src/model-intelligence/materialize/runtime/claude.mjs";
import { parseFrontmatter } from "../src/build-index.mjs";
import { input } from "./fixtures/model-intelligence/resolver.mjs";

function fixture(kind = "agent", compute = { requirement: "deep", mode: "dynamic", binding: "self" }) {
  const context = JSON.parse(JSON.stringify(input()).replaceAll('"codex"', '"claude"'));
  context.runtimeContract.binding.command = { support: "supported", axes: { model: "supported", reasoning: "unverified" } };
  const sourceContent = "---\n" + yaml.dump({ name: "projection-example", description: "A projection fixture.", tools: ["Read"], model: "legacy-shadow", effort: "low", owner: "private-owner", dotbabel: { compute } }) + "---\n\nPreserve this exact body.\n";
  return { toolVersion: "4.2.0", artifacts: [{ sourcePath: `${kind}s/example.md`, sourceContent, target: { path: `${kind}s/example.md`, artifactKind: kind } }], context };
}
const metadata = batch => parseFrontmatter(batch.files[0].content).frontmatter;

describe("Claude projection rules", () => {
  it("an agent with a dynamic requirement gets model and effort projected into the generated copy", () => {
    const options = fixture(); const before = structuredClone(options);
    const result = materializeClaude(options);
    expect(metadata(result)).toEqual({ description: "A projection fixture.", effort: "focused", model: "deep-model", name: "projection-example", tools: ["Read"] });
    expect(result.files[0].content.endsWith("\nPreserve this exact body.\n")).toBe(true);
    expect(result.manifest.entries["agents/example.md"].runtimeId).toBe("claude");
    expect(options).toEqual(before);
  });
  it("a dynamic or floor command gets no model in the generated copy", () => {
    for (const mode of ["dynamic", "floor"]) {
      const result = materializeClaude(fixture("command", { requirement: "deep", mode, binding: "session" }));
      expect(metadata(result)).not.toHaveProperty("model");
      expect(metadata(result)).not.toHaveProperty("effort");
      expect(metadata(result)).not.toHaveProperty("dotbabel");
      expect(result.files[0].content.endsWith("\nPreserve this exact body.\n")).toBe(true);
    }
  });
  it("a pinned command keeps its native model in the generated copy", () => {
    const result = materializeClaude(fixture("command", { requirement: "deep", mode: "pin", binding: "session", rationale: "This command explicitly pins its session model.", pin: { runtime: "claude", config: { model: "deep-model" } } }));
    expect(metadata(result).model).toBe("deep-model");
    expect(metadata(result)).not.toHaveProperty("effort");
    expect(metadata(result)).not.toHaveProperty("dotbabel");
  });
  it("a skill gets neither model nor effort and loses dotbabel.compute", () => {
    const result = materializeClaude(fixture("skill", { requirement: "deep", mode: "dynamic", binding: "consumer" }));
    expect(metadata(result)).not.toHaveProperty("model");
    expect(metadata(result)).not.toHaveProperty("effort");
    expect(metadata(result)).not.toHaveProperty("dotbabel");
    expect(metadata(result)).not.toHaveProperty("owner");
    expect(result.files[0].content.endsWith("\nPreserve this exact body.\n")).toBe(true);
  });
  it("an inherit declaration produces no concrete projection", () => {
    const result = materializeClaude(fixture("agent", { mode: "inherit", binding: "self" }));
    expect(metadata(result)).not.toHaveProperty("model");
    expect(metadata(result)).not.toHaveProperty("effort");
    expect(metadata(result)).not.toHaveProperty("dotbabel");
  });
  it("refuses a command pin whose explicit reasoning axis cannot bind", () => {
    expect(() => materializeClaude(fixture("command", { requirement: "deep", mode: "pin", binding: "session", rationale: "An explicit pair.", pin: { runtime: "claude", config: { model: "deep-model", reasoning: "focused" } } }))).toThrow(/pin|binding/);
  });
  it("refuses missing capability evidence rather than inventing a strong agent model", () => {
    const options = fixture(); options.context.catalog.runtimes = [];
    expect(() => materializeClaude(options)).toThrow(/resolution|evidence/);
  });
  it("does not bind an unverified agent axis", () => {
    const options = fixture(); options.context.runtimeContract.binding.agent.axes.reasoning = "unverified";
    const result = materializeClaude(options);
    expect(metadata(result)).not.toHaveProperty("effort");
  });
});
