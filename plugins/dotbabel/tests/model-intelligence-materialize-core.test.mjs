import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { materializationFixture } from "./fixtures/model-intelligence/materialize.mjs";
import { materialize } from "../src/model-intelligence/materialize/index.mjs";
import { parseFrontmatter } from "../src/build-index.mjs";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { input } from "./fixtures/model-intelligence/resolver.mjs";

const digest = text => "sha256:" + createHash("sha256").update(text).digest("hex");
const fixture = materializationFixture;

function output(value = fixture()) { return materialize(value); }
const file = result => result.files[0];
const entry = result => Object.values(result.manifest.entries)[0];

describe("deterministic materialization core", () => {
  it("produces byte-identical output for identical inputs and contains no timestamp", () => {
    const value = fixture(); const before = structuredClone(value);
    expect(output(value)).toEqual(output(structuredClone(value)));
    expect(value).toEqual(before);
    expect(JSON.stringify(output(value))).not.toMatch(/generatedAt|observedAt|2026-01-01/);
  });
  it("matches the reviewed runtime file and manifest golden bytes", () => {
    const result = output();
    expect(file(result).content).toBe(readFileSync(new URL("./fixtures/model-intelligence/materialize-core.expected.md", import.meta.url), "utf8"));
    expect(JSON.stringify(result.manifest, null, 2) + "\n").toBe(readFileSync(new URL("./fixtures/model-intelligence/materialize-core.expected.json", import.meta.url), "utf8"));
  });
  it("writes the generated marker as the first line inside the frontmatter with projection id and source path", () => {
    const result = output(); const lines = file(result).content.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toContain("# dotbabel:generated projection=" + entry(result).projectionId);
    expect(lines[1]).toContain("source=agents/example.md");
    expect(entry(result).projectionId).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it("strips dotbabel.compute from the runtime-visible frontmatter unless the adapter contract permits it", () => {
    for (const kind of ["agent", "skill"]) {
      const value = fixture();
      if (kind === "skill") {
        const artifact = value.artifacts[0]; artifact.sourcePath = artifact.target.path = "skills/example/SKILL.md"; artifact.target.artifactKind = kind;
        artifact.sourceContent = artifact.sourceContent.replace("binding: self", "binding: consumer"); artifact.requirement.binding = "consumer";
        artifact.resolverResult = resolve(input({ requirement: artifact.requirement, target: { runtimeId: "codex", artifactKind: kind } }));
      }
      const generated = parseFrontmatter(file(output(value)).content);
      expect(generated.frontmatter).not.toHaveProperty("dotbabel");
      expect(generated.frontmatter).not.toHaveProperty("owner");
    }
    const value = fixture();
    value.artifacts[0].projectionContract = { ...value.artifacts[0].projectionContract, frontmatterKeys: ["name", "dotbabel"], permitsCompute: true, computeConsumer: "explicit runtime extension" };
    expect(parseFrontmatter(file(output(value)).content).frontmatter.dotbabel.compute.requirement).toBe("deep");
  });
  it("projectionId changes when the runtime contract hash changes and the source does not", () => {
    const value = fixture(); const previous = output(value);
    value.artifacts[0].runtimeContract.binding.agent.axes.reasoning = "unverified";
    const changed = output(value);
    expect(entry(changed).sourceHash).toBe(entry(previous).sourceHash);
    expect(entry(changed).runtimeContractHash).not.toBe(entry(previous).runtimeContractHash);
    expect(entry(changed).projectionId).not.toBe(entry(previous).projectionId);
    expect(parseFrontmatter(file(changed).content).frontmatter.effort).toBeUndefined();
  });
  it("manifest entries carry the seven required provenance fields", () => {
    const result = output(); const manifest = result.manifest;
    expect(manifest).toMatchObject({ schemaVersion: 1, toolVersion: "4.2.0" });
    expect(entry(result)).toMatchObject({ sourcePath: "agents/example.md", runtimeId: "codex", artifactKind: "agent", snapshotId: null });
    for (const key of ["projectionId", "sourceHash", "inputsHash", "outputHash", "resolverResultHash", "runtimeContractHash"]) expect(entry(result)[key]).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entry(result).sourceHash).toBe(digest(fixture().artifacts[0].sourceContent));
    expect(entry(result).outputHash).toBe(digest(file(result).content));
  });
  it("emits only allowlisted metadata and independently verified native axes", () => {
    const result = output();
    expect(parseFrontmatter(file(result).content).frontmatter).toEqual({ name: "example", description: "A verified agent.", model: "deep-model", effort: "focused" });
    const value = fixture(); value.artifacts[0].runtimeContract.binding.agent.support = "unverified";
    expect(parseFrontmatter(file(output(value)).content).frontmatter).toEqual({ name: "example", description: "A verified agent." });
  });
  it("preserves canonical body bytes and does not read generated output as input", () => {
    const value = fixture(); value.artifacts[0].sourceContent += "\n  code sample\n";
    expect(parseFrontmatter(file(output(value)).content).body).toBe(parseFrontmatter(value.artifacts[0].sourceContent).body);
    expect(output(value)).not.toHaveProperty("generatedAt");
  });
  it("ignores operational evidence times while retaining meaningful fact changes", () => {
    const value = fixture(); const first = output(value);
    value.artifacts[0].capabilityEvidence.observedAt = "2030-01-01T00:00:00Z";
    expect(output(value)).toEqual(first);
    value.artifacts[0].capabilityEvidence.facts.tool_call = false;
    expect(entry(output(value)).inputsHash).not.toBe(entry(first).inputsHash);
  });
  it("object insertion order cannot change projection identities", () => {
    const value = fixture(); const first = output(value);
    value.artifacts[0].projectionContract = { axisKeys: { reasoning: "effort", model: "model" }, frontmatterKeys: ["name", "description", "model", "effort"] };
    expect(output(value)).toEqual(first);
  });
  it("materializer version, policy, source and snapshot each participate in identity", () => {
    const original = output();
    for (const change of [
      value => { value.toolVersion = "4.3.0"; },
      value => { value.artifacts[0].policy.preferences.prefer_fresher_evidence = false; },
      value => { value.artifacts[0].sourceContent += "Changed body.\n"; },
      value => { value.artifacts[0].snapshotId = "sha256:committed-snapshot"; },
      value => { value.artifacts[0].projectionContract.frontmatterKeys = ["name"]; },
    ]) {
      const value = fixture(); change(value);
      expect(entry(output(value)).projectionId).not.toBe(entry(original).projectionId);
    }
  });
  it("records an effective requirement even when the selected wire configuration stays the same", () => {
    const value = fixture(); const first = output(value);
    value.artifacts[0].requirement.requirement = "routine";
    const changed = output(value);
    expect(entry(changed).resolverResultHash).toBe(entry(first).resolverResultHash);
    expect(entry(changed).sourceHash).toBe(entry(first).sourceHash);
    expect(entry(changed).inputsHash).not.toBe(entry(first).inputsHash);
  });
  it("normalizes an allowlist's order without changing its meaning", () => {
    const value = fixture(); const first = output(value);
    value.artifacts[0].projectionContract.frontmatterKeys.reverse();
    expect(output(value)).toEqual(first);
  });
  it("materializes explicit inheritance without inventing native model fields", () => {
    const value = fixture(); const artifact = value.artifacts[0];
    artifact.sourceContent = "---\nname: inherited\ndotbabel:\n  compute:\n    mode: inherit\n    binding: self\n---\nBody\n";
    artifact.requirement = { mode: "inherit", binding: "self" };
    artifact.resolverResult = resolve(input({ requirement: artifact.requirement }));
    const result = output(value);
    expect(parseFrontmatter(file(result).content).frontmatter).toEqual({ name: "inherited" });
    expect(entry(result).resolverResultHash).toMatch(/^sha256:/);
  });
  it("preserves native inheritance for an artifact without a compute declaration", () => {
    const value = fixture(); const artifact = value.artifacts[0];
    artifact.sourceContent = "---\nname: plain\n---\nOriginal body.\n";
    artifact.requirement = undefined;
    artifact.resolverResult = resolve(input({ requirement: undefined }));
    expect(parseFrontmatter(file(output(value)).content).frontmatter).toEqual({ name: "plain" });
  });
  it("cannot hide a canonical floor behind an inherited supplied result", () => {
    const value = fixture(); const artifact = value.artifacts[0];
    artifact.sourceContent = artifact.sourceContent.replace("mode: dynamic", "mode: floor");
    artifact.requirement = { mode: "inherit", binding: "self" };
    artifact.resolverResult = resolve(input({ requirement: artifact.requirement }));
    expect(() => output(value)).toThrow(/resolution/);
  });
  it.each(["routine", "deep"])("refuses a genuine resolved %s requirement below an authored frontier floor", level => {
    const value = fixture(); const artifact = value.artifacts[0];
    artifact.sourceContent = artifact.sourceContent.replace("requirement: deep", "requirement: frontier").replace("mode: dynamic", "mode: floor");
    artifact.requirement.requirement = level;
    artifact.resolverResult = resolve(input({ requirement: artifact.requirement }));
    expect(artifact.resolverResult.status).toBe("resolved");
    expect(() => output(value)).toThrow(/resolution|floor/);
  });
  it("accepts a composed stronger requirement while retaining the authored floor", () => {
    const value = fixture(); const artifact = value.artifacts[0];
    artifact.sourceContent = artifact.sourceContent.replace("mode: dynamic", "mode: floor");
    artifact.requirement.requirement = "frontier";
    artifact.resolverResult = resolve(input({ requirement: artifact.requirement }));
    expect(parseFrontmatter(file(output(value)).content).frontmatter.model).toBe("frontier-model");
  });
  it("does not replace an authored pin with a different resolved pin", () => {
    const value = fixture(); const artifact = value.artifacts[0];
    artifact.sourceContent = artifact.sourceContent.replace("mode: dynamic", "mode: pin\n    pin:\n      runtime: codex\n      config:\n        model: deep-model\n    rationale: Preserve the authored exact model.");
    artifact.requirement.mode = "pin";
    artifact.requirement.pin = { runtime: "codex", config: { model: "frontier-model" } };
    artifact.resolverResult = resolve(input({ requirement: artifact.requirement }));
    expect(artifact.resolverResult.status).toBe("resolved");
    expect(() => output(value)).toThrow(/pin/);
  });
  it("retains only approved compute metadata inside the private Dotbabel namespace", () => {
    const value = fixture(); const artifact = value.artifacts[0];
    artifact.sourceContent = artifact.sourceContent.replace("dotbabel:\n", "dotbabel:\n  internal: private-metadata-marker\n");
    artifact.projectionContract = { ...artifact.projectionContract, frontmatterKeys: ["name", "dotbabel"], permitsCompute: true, computeConsumer: "explicit compute extension" };
    const metadata = parseFrontmatter(file(output(value)).content).frontmatter;
    expect(metadata.dotbabel).toEqual({ compute: { requirement: "deep", mode: "dynamic", binding: "self" } });
    expect(file(output(value)).content).not.toContain("private-metadata-marker");
  });
  it("does not turn a consumer recommendation into an artifact binding", () => {
    const value = fixture(); const artifact = value.artifacts[0];
    artifact.sourceContent = artifact.sourceContent.replace("binding: self", "binding: consumer");
    artifact.requirement.binding = "consumer";
    artifact.resolverResult = resolve(input({ requirement: artifact.requirement }));
    expect(artifact.resolverResult.enforcement.state).toBe("unknown");
    expect(parseFrontmatter(file(output(value)).content).frontmatter).toEqual({ name: "example", description: "A verified agent." });
  });
  it("refuses invalid compute declarations before stripping their private metadata", () => {
    const value = fixture(); value.artifacts[0].sourceContent = value.artifacts[0].sourceContent.replace("mode: dynamic", "mode: dynamic\n    misspelled: frontier");
    expect(() => output(value)).toThrow(/compute/);
  });
  it("refuses an independently known unsatisfied resolution", () => {
    const value = fixture(); value.artifacts[0].resolverResult.enforcement = { state: "unsatisfied", basis: "session-observation" };
    expect(() => output(value)).toThrow(/resolution/);
  });
  it("rejects non-JSON derivation values and circular evidence", () => {
    for (const unsafe of [NaN, Infinity, undefined, new Date(), () => {}, 1n]) {
      const value = fixture(); value.artifacts[0].capabilityEvidence.facts.unsafe = unsafe;
      expect(() => output(value)).toThrow(/JSON/);
    }
    const value = fixture(); value.artifacts[0].capabilityEvidence.facts.self = value.artifacts[0].capabilityEvidence;
    expect(() => output(value)).toThrow(/acyclic/);
  });
  it("sorts batch files and manifest entries by target path", () => {
    const value = fixture(); const another = structuredClone(value.artifacts[0]);
    another.sourcePath = "agents/another.md"; another.target.path = "agents/another.md";
    value.artifacts.push(another); const first = output(value);
    value.artifacts.reverse(); expect(output(value)).toEqual(first);
    expect(first.files.map(item => item.path)).toEqual(["agents/another.md", "agents/example.md"]);
    expect(Object.keys(first.manifest.entries)).toEqual(["agents/another.md", "agents/example.md"]);
  });
  it("refuses duplicate output ownership and unsafe canonical or destination paths", () => {
    const duplicate = fixture(); duplicate.artifacts.push(structuredClone(duplicate.artifacts[0]));
    expect(() => output(duplicate)).toThrow(/duplicate/);
    for (const unsafe of ["../escape.md", "/absolute.md", "agents/../../escape.md", "agents\\escape.md", "agents/line\nbreak.md", "", ".", "C:/escape.md"]) {
      for (const key of ["sourcePath", "target"]) {
        const value = fixture(); if (key === "target") value.artifacts[0].target.path = unsafe; else value.artifacts[0].sourcePath = unsafe;
        expect(() => output(value)).toThrow(/path/);
      }
    }
  });
  it.each(["conflict", "invalid", "unresolved"])("refuses an unusable %s resolver result for a required projection", status => {
    const value = fixture(); value.artifacts[0].resolverResult.status = status;
    expect(() => output(value)).toThrow(/resolution/);
  });
  it("rejects another runtime's configuration and unsafe native field values", () => {
    const wrong = fixture(); wrong.artifacts[0].resolverResult.configuration.runtimeId = "claude";
    expect(() => output(wrong)).toThrow(/runtime/);
    const unsafe = fixture(); unsafe.artifacts[0].resolverResult.configuration.axes.model = "bad\nvalue";
    expect(() => output(unsafe)).toThrow(/axis/);
  });
  it("does not preserve private compute metadata without both explicit support and a consumer", () => {
    const value = fixture(); value.artifacts[0].projectionContract.frontmatterKeys.push("dotbabel");
    value.artifacts[0].projectionContract.permitsCompute = true;
    expect(() => output(value)).toThrow(/consumer/);
  });
  it("rejects malformed YAML and ambiguous axis-to-field mappings", () => {
    const malformed = fixture(); malformed.artifacts[0].sourceContent = "---\nname: [invalid\n---\nBody";
    expect(() => output(malformed)).toThrow(/frontmatter/);
    const ambiguous = fixture(); ambiguous.artifacts[0].projectionContract.axisKeys = { model: "model", reasoning: "model" };
    expect(() => output(ambiguous)).toThrow(/mapping/);
  });
});
