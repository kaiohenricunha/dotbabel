import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { buildClaudeBaseline } from "../src/model-intelligence/materialize/runtime/claude-build.mjs";
import { materializeClaude } from "../src/model-intelligence/materialize/runtime/claude.mjs";
import { parseProjectionSource } from "../src/model-intelligence/materialize/render.mjs";
import { readSnapshot, snapshotCatalog } from "../src/model-intelligence/snapshot/index.mjs";
import { mergePolicy, SHIPPED_POLICY } from "../src/model-intelligence/policy/index.mjs";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";

const snapshot = readSnapshot();
const cases = [["changelog", "mechanical"], ["markdown", "mechanical"], ["tldr", "mechanical"], ["pr-tldr", "mechanical"], ["merge-pr", "routine"], ["pre-pr", "routine"], ["dependabot-sweep", "routine"]];
const artifact = name => ({ sourcePath: `commands/${name}.md`, sourceContent: readFileSync(new URL(`../../../commands/${name}.md`, import.meta.url), "utf8"), target: { path: `commands/${name}.md`, artifactKind: "command" } });
const native = batch => parseProjectionSource({ sourcePath: batch.files[0].path, sourceContent: batch.files[0].content });
const context = () => ({ catalog: snapshotCatalog(snapshot), policy: mergePolicy({ shipped: SHIPPED_POLICY }), runtimeContract: structuredClone(snapshot.runtimes.claude.runtimeContract) });
const baseline = (source, release = snapshot) => buildClaudeBaseline({ toolVersion: "4.2.0", snapshot: release, artifacts: [source] });
function declared(source, requirement, mode = "dynamic") {
  const parsed = parseProjectionSource(source);
  return { ...source, sourceContent: `---\n${yaml.dump({ ...parsed.frontmatter, dotbabel: { compute: { mode, requirement, binding: "session" } } }, { lineWidth: -1 })}---\n${parsed.body}` };
}

describe("Claude release command migration compatibility", () => {
  it.each(cases)("preserves the authored %s native session control while adding its semantic requirement", (name, requirement) => {
    const source = artifact(name), before = native(baseline(source));
    const migrated = declared(source, requirement); const after = native(baseline(migrated));
    expect(before.frontmatter.model).toBe(parseProjectionSource(source).frontmatter.model);
    expect(after).toEqual(before);
    expect(after.frontmatter).not.toHaveProperty("dotbabel"); expect(after.frontmatter).not.toHaveProperty("effort");
    const input = { ...context(), requirement: parseProjectionSource(migrated).requirement, target: { runtimeId: "claude", artifactKind: "command", sourcePath: source.sourcePath } };
    expect(resolve(input).enforcement).toEqual({ state: "unknown", basis: "none" });
    expect(native(materializeClaude({ toolVersion: "4.2.0", context: context(), artifacts: [migrated] })).frontmatter).not.toHaveProperty("model");
  });

  it.each(["dynamic", "floor"])("retains a %s legacy release selector only after the shared resolver validates the minimum", mode => {
    const migrated = declared(artifact("pre-pr"), "routine", mode);
    expect(native(baseline(migrated)).frontmatter.model).toBe("sonnet");
    const inputs = context();
    for (const model of inputs.catalog.runtimes[0].models) for (const fact of model.fields.capabilities) fact.value = { reasoning: false, tool_call: false };
    expect(() => materializeClaude({ toolVersion: "4.2.0", context: inputs, artifacts: [{ ...migrated, releaseBaseline: true, legacyAxes: { model: "sonnet" } }] })).toThrow(/resolution|requirement/);
  });

  it("does not invent a release selector when the authored command has none", () => {
    const source = declared(artifact("pre-pr"), "routine"); const parsed = parseProjectionSource(source); delete parsed.frontmatter.model;
    source.sourceContent = `---\n${yaml.dump(parsed.frontmatter)}---\n${parsed.body}`;
    expect(native(baseline(source)).frontmatter).not.toHaveProperty("model");
  });

  it("keeps inherit commands free of a concrete compatibility projection", () => {
    const source = artifact("pre-pr"), parsed = parseProjectionSource(source);
    source.sourceContent = `---\n${yaml.dump({ ...parsed.frontmatter, dotbabel: { compute: { mode: "inherit", binding: "session" } } })}---\n${parsed.body}`;
    expect(native(baseline(source)).frontmatter).not.toHaveProperty("model");
  });

  it("refuses an unverified native command binding instead of silently dropping the existing selector", () => {
    const source = declared(artifact("pre-pr"), "routine"); const input = context();
    input.runtimeContract.capabilities.binding.command.axes.model = "unverified";
    expect(() => materializeClaude({ toolVersion: "4.2.0", context: input, artifacts: [{ ...source, releaseBaseline: true, legacyAxes: { model: "sonnet" } }] })).toThrow(/binding_unverified/);
  });

  it("does not emit a below-floor authored selector after an invocation override validates another model", () => {
    const source = declared(artifact("pre-pr"), "frontier", "floor"), input = context();
    for (const model of input.catalog.runtimes[0].models.filter(model => model.model === "sonnet" || model.model === "claude-sonnet-5-5")) for (const fact of model.fields.capabilities) fact.value = { reasoning: false, tool_call: true };
    input.invocation = { overrides: { model: "opus" } };
    const resolution = resolve({ ...input, requirement: parseProjectionSource(source).requirement, target: { runtimeId: "claude", artifactKind: "command", sourcePath: source.sourcePath }, invocation: { ...input.invocation, pin: { runtime: "claude", config: { model: "sonnet" } }, omitDefaultReasoning: true } });
    expect(resolution.status).toBe("resolved"); expect(resolution.configuration.axes.model).toBe("opus");
    expect(() => materializeClaude({ toolVersion: "4.2.0", context: input, artifacts: [{ ...source, releaseBaseline: true, legacyAxes: { model: "sonnet" } }] })).toThrow(/release_requirement_unsatisfied/);
  });
});
