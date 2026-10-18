import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { buildClaudeBaseline } from "../src/model-intelligence/materialize/runtime/claude-build.mjs";
import { parseFrontmatter } from "../src/build-index.mjs";
import { createSnapshot } from "../src/model-intelligence/snapshot/core.mjs";
import { hashContent } from "../src/model-intelligence/materialize/manifest.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../src/model-intelligence/snapshot/release-capabilities.json", import.meta.url), "utf8"));
const artifact = (kind, metadata = {}, id = "example") => {
  const sourcePath = kind === "skill" ? `skills/${id}/SKILL.md` : `${kind}s/${id}.md`;
  return { sourcePath, sourceContent: "---\n" + yaml.dump({ name: id, description: "A baseline fixture.", tools: ["Read"], ...metadata }) + "---\n\nKeep this body exactly.\n", target: { path: sourcePath, artifactKind: kind } };
};
const build = artifacts => buildClaudeBaseline({ toolVersion: "4.2.0", snapshot: structuredClone(snapshot), artifacts });
const metadata = batch => parseFrontmatter(batch.files[0].content).frontmatter;
const compute = (mode, extra = {}) => ({ dotbabel: { compute: { requirement: "deep", mode, binding: "self", ...extra } } });

describe("offline Claude release baseline", () => {
  it("writes a resolved floor and records the accepted snapshot for every artifact", () => {
    const source = artifact("agent", compute("floor")); const before = structuredClone(source);
    const batch = build([source]);
    expect(typeof metadata(batch).model).toBe("string");
    expect(metadata(batch).effort).toBe("medium");
    expect(metadata(batch)).not.toHaveProperty("dotbabel");
    expect(batch.manifest.entries[source.sourcePath]).toMatchObject({ snapshotId: snapshot.snapshotId, sourceHash: hashContent(source.sourceContent) });
    expect(batch.files[0].content.endsWith("\nKeep this body exactly.\n")).toBe(true);
    expect(source).toEqual(before);
  });
  it("keeps an exact canonical native pin", () => {
    const batch = build([artifact("agent", compute("pin", { rationale: "Preserve the reviewed native model.", pin: { runtime: "claude", config: { model: "opus", reasoning: "max" } } }))]);
    expect(metadata(batch)).toMatchObject({ model: "opus", effort: "max" });
  });
  it("does not freeze a dynamic agent without a mandatory floor", () => {
    const batch = build([artifact("agent", { model: "opus", effort: "max", ...compute("dynamic") })]);
    expect(metadata(batch)).not.toHaveProperty("model");
    expect(metadata(batch)).not.toHaveProperty("effort");
  });
  it("canonical inheritance wins over shadowed legacy axes", () => {
    const batch = build([artifact("agent", { model: "opus", effort: "max", dotbabel: { compute: { mode: "inherit", binding: "self" } } })]);
    expect(metadata(batch)).not.toHaveProperty("model");
    expect(metadata(batch)).not.toHaveProperty("effort");
  });
  it("preserves a legacy strong agent model without inventing an effort override", () => {
    const batch = build([artifact("agent", { model: "opus" })]);
    expect(metadata(batch).model).toBe("opus");
    expect(metadata(batch)).not.toHaveProperty("effort");
  });
  it("preserves independently authored legacy effort", () => {
    const batch = build([artifact("agent", { model: "opus", effort: "max" })]);
    expect(metadata(batch)).toMatchObject({ model: "opus", effort: "max" });
  });
  it("preserves an explicit legacy command model but does not introduce effort", () => {
    const batch = build([artifact("command", { model: "opus" })]);
    expect(metadata(batch).model).toBe("opus");
    expect(metadata(batch)).not.toHaveProperty("effort");
  });
  it("strips inert skill axes and preserves static runtime inheritance", () => {
    for (const source of [artifact("skill", { model: "opus", effort: "max" }), artifact("agent"), artifact("agent", { model: "inherit" })]) {
      const batch = build([source]);
      expect(metadata(batch)).not.toHaveProperty("model");
      expect(metadata(batch)).not.toHaveProperty("effort");
      expect(batch.manifest.entries[source.sourcePath].snapshotId).toBe(snapshot.snapshotId);
    }
  });
  it("fails closed for an unverified legacy selector and unsupported effort", () => {
    for (const fields of [{ model: "unknown-native-model" }, { model: "opus", effort: "unverified-effort" }, { model: null }, { model: 3 }, { model: false }]) expect(() => build([artifact("agent", fields)])).toThrow();
  });
  it("fails rather than omitting an unsatisfied mandatory floor", () => {
    const seed = structuredClone(snapshot);
    for (const model of seed.runtimes.claude.models) model.fields.capabilities[0].value.reasoning = false;
    const accepted = createSnapshot(seed);
    expect(() => buildClaudeBaseline({ toolVersion: "4.2.0", snapshot: accepted, artifacts: [artifact("agent", compute("floor"))] })).toThrow();
  });
  it("rejects low-confidence evidence for mandatory floors and exact legacy pins", () => {
    const seed = structuredClone(snapshot);
    for (const model of seed.runtimes.claude.models) for (const entries of Object.values(model.fields)) for (const entry of entries) entry.confidence = "low";
    const accepted = createSnapshot(seed);
    for (const source of [artifact("agent", compute("floor")), artifact("agent", { model: "opus" })]) {
      expect(() => buildClaudeBaseline({ toolVersion: "4.2.0", snapshot: accepted, artifacts: [source] })).toThrow("release_requirement_unsatisfied");
    }
  });
  it("rejects ambiguous independent legacy effort instead of silently removing it", () => {
    for (const fields of [{ effort: "max" }, { model: "inherit", effort: "high" }, { effort: "unverified" }, { effort: null }]) {
      expect(() => build([artifact("agent", fields)])).toThrow("claude_baseline_effort_model_unverified");
    }
  });
  it("keeps baseline identity independent of observation times", () => {
    const sources = [artifact("agent", { model: "opus" })];
    const first = build(sources);
    const seed = structuredClone(snapshot);
    for (const source of seed.sources) source.observedAt = "2000-01-01T00:00:00.000Z";
    const second = buildClaudeBaseline({ toolVersion: "4.2.0", snapshot: seed, artifacts: sources });
    expect(second).toEqual(first);
  });
  it("keeps bounded build overhead below one second for 100 artifacts", () => {
    const sources = Array.from({ length: 100 }, (_, i) => artifact("agent", { model: "opus" }, `example-${i}`));
    const started = performance.now(); const result = build(sources);
    expect(result.files).toHaveLength(100);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
