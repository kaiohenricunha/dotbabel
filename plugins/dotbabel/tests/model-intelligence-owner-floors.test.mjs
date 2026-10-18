import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { parseComputeDeclaration } from "../src/model-intelligence/requirement/index.mjs";
import { parseProjectionSource } from "../src/model-intelligence/materialize/render.mjs";
import { buildClaudeBaseline } from "../src/model-intelligence/materialize/runtime/claude-build.mjs";
import { readSnapshot, snapshotCatalog } from "../src/model-intelligence/snapshot/index.mjs";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { mergePolicy, SHIPPED_POLICY } from "../src/model-intelligence/policy/index.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/model-intelligence/owner-floors.json", import.meta.url), "utf8"));
const snapshot = readSnapshot();
const artifact = entry => ({
  sourcePath: entry.sourcePath,
  sourceContent: readFileSync(new URL(`../../../${entry.sourcePath}`, import.meta.url), "utf8"),
  target: { path: entry.sourcePath, artifactKind: entry.artifactKind },
});
const request = (entry, catalog = snapshotCatalog(snapshot)) => ({
  requirement: parseProjectionSource(artifact(entry)).requirement,
  target: { runtimeId: "claude", artifactKind: entry.artifactKind, sourcePath: entry.sourcePath },
  catalog,
  policy: mergePolicy({ shipped: SHIPPED_POLICY }),
  runtimeContract: snapshot.runtimes.claude.runtimeContract,
});
const project = source => {
  const output = buildClaudeBaseline({ toolVersion: "4.2.0", snapshot, artifacts: [source] }).files[0];
  return parseProjectionSource({ sourcePath: source.sourcePath, sourceContent: output.content });
};

describe("P-19f: approved audit-role floors F1/F2/F6", () => {
  it("every artifact in the batch parses to the owner's exact NormalizedComputeRequirement", () => {
    for (const entry of fixture.entries) {
      const source = parseProjectionSource(artifact(entry));
      const parsed = parseComputeDeclaration(source.frontmatter, { sourcePath: entry.sourcePath });
      expect(parsed.errors, entry.sourcePath).toEqual([]);
      expect(parsed.declared, entry.sourcePath).toBe(true);
      expect(source.frontmatter.dotbabel.compute).toEqual(entry.compute);
      expect(parsed.requirement).toMatchObject(entry.compute);
    }
  });

  it("preserves each original body, read-only tools, native controls and unrelated metadata", () => {
    for (const entry of fixture.entries) {
      const { frontmatter, body } = parseProjectionSource(artifact(entry));
      const { dotbabel, ...original } = frontmatter;
      expect(original, entry.sourcePath).toEqual(entry.frontmatter);
      expect(createHash("sha256").update(body).digest("hex"), entry.sourcePath).toBe(entry.bodyHash);
    }
  });

  it("resolve() for claude reproduces the pre-migration effective model for every artifact", () => {
    for (const entry of fixture.entries) {
      const current = artifact(entry);
      const before = { ...current, sourceContent: `---\n${yaml.dump(entry.frontmatter, { lineWidth: -1 })}---\n${parseProjectionSource(current).body}` };
      expect(project(current), entry.sourcePath).toEqual(project(before));
    }
  });

  it("retains exact native agent model selectors without adding reasoning or writable tools", () => {
    for (const entry of fixture.entries.filter(item => item.artifactKind === "agent")) {
      const result = resolve({ ...request(entry), invocation: { pin: { runtime: "claude", config: { model: entry.frontmatter.model } }, omitDefaultReasoning: true } });
      expect(result.status, entry.sourcePath).toBe("resolved");
      expect(result.confidence).toBe("high");
      expect(result.enforcement).toEqual({ state: "enforced", basis: "artifact-binding" });
      expect(result.configuration.axes).toEqual({ model: entry.frontmatter.model });
      const output = project(artifact(entry));
      expect(output.frontmatter.model).toBe(entry.frontmatter.model);
      expect(output.frontmatter.tools).toBe("Read, Grep, Glob");
      expect(output.frontmatter).not.toHaveProperty("effort");
    }
  });

  it("does not report the approved floors satisfied when capability evidence is below them", () => {
    for (const entry of fixture.entries) {
      const weak = snapshotCatalog(snapshot);
      for (const record of weak.runtimes.find(runtime => runtime.runtimeId === "claude").models) {
        for (const field of record.fields.capabilities) field.value = { reasoning: false, tool_call: true };
      }
      const result = resolve(request(entry, weak));
      expect(result.status, entry.sourcePath).toBe("unresolved");
      expect(result.enforcement.state).not.toBe("enforced");
      expect(result.configuration).toBeUndefined();
    }
  });

  it("keeps the validation floor consumer-only without claiming native skill enforcement", () => {
    const entry = fixture.entries.find(item => item.ownerDecision === "F6");
    const source = parseProjectionSource(artifact(entry));
    expect(source.requirement).toMatchObject({ mode: "floor", requirement: "frontier", binding: "consumer" });
    const result = resolve(request(entry));
    expect(result.status).toBe("resolved");
    expect(result.enforcement).toEqual({ state: "unknown", basis: "none" });
    const output = project(artifact(entry));
    expect(output.frontmatter).not.toHaveProperty("model");
    expect(output.frontmatter).not.toHaveProperty("effort");
    expect(output.frontmatter).not.toHaveProperty("dotbabel");
    expect(output.requirement).toBeNull();
    expect(output.frontmatter["allowed-tools"]).toBe(entry.frontmatter["allowed-tools"]);
  });
});
