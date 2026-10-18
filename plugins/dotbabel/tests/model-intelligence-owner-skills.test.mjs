import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { parseProjectionSource } from "../src/model-intelligence/materialize/render.mjs";
import { buildClaudeBaseline } from "../src/model-intelligence/materialize/runtime/claude-build.mjs";
import { readSnapshot, snapshotCatalog } from "../src/model-intelligence/snapshot/index.mjs";
import { resolve } from "../src/model-intelligence/resolver/index.mjs";
import { mergePolicy, SHIPPED_POLICY } from "../src/model-intelligence/policy/index.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/model-intelligence/owner-skills.json", import.meta.url), "utf8"));
const snapshot = readSnapshot();
const artifact = entry => ({ sourcePath: entry.sourcePath, sourceContent: readFileSync(new URL(`../../../${entry.sourcePath}`, import.meta.url), "utf8"), target: { path: entry.sourcePath, artifactKind: "skill" } });
const project = source => {
  const output = buildClaudeBaseline({ toolVersion: "4.2.0", snapshot, artifacts: [source] }).files[0];
  return parseProjectionSource({ sourcePath: source.sourcePath, sourceContent: output.content });
};

describe("P-19f: approved skill decisions F3/F4/F5/F7", () => {
  it("the two coordinators declare the exact approved consumer requirements", () => {
    for (const entry of fixture.entries.filter(item => item.compute)) {
      const parsed = parseProjectionSource(artifact(entry));
      expect(parsed.requirement, entry.sourcePath).toMatchObject(entry.compute);
      expect(parsed.frontmatter.dotbabel.compute).toEqual(entry.compute);
    }
  });

  it("preserves unrelated frontmatter and native invocation and tool controls for all four skills", () => {
    for (const entry of fixture.entries) {
      const parsed = parseProjectionSource(artifact(entry));
      const original = { ...parsed.frontmatter };
      delete original.dotbabel;
      expect(original, entry.sourcePath).toEqual(entry.frontmatter);
      if (!entry.compute) expect(parsed.requirement).toBeNull();
    }
  });

  it("preserves every original coordinator workflow byte before its new compute-scope appendix", () => {
    for (const entry of fixture.entries.filter(item => item.compute)) {
      const { body } = parseProjectionSource(artifact(entry));
      const boundary = body.indexOf("\n## Compute scope\n");
      expect(boundary, entry.sourcePath).toBeGreaterThan(0);
      expect(createHash("sha256").update(body.slice(0, boundary)).digest("hex")).toBe(entry.bodyHash);
    }
  });

  it("preserves native skill projection controls and forwards each complete authored body", () => {
    for (const entry of fixture.entries) {
      const current = artifact(entry), parsed = parseProjectionSource(current);
      const before = { ...current, sourceContent: `---\n${yaml.dump(entry.frontmatter, { lineWidth: -1 })}---\n${parsed.body}` };
      const output = project(current);
      expect(output.frontmatter, entry.sourcePath).toEqual(project(before).frontmatter);
      expect(output.body).toBe(parsed.body);
      expect(output.requirement).toBeNull();
      expect(output.frontmatter).not.toHaveProperty("model");
      expect(output.frontmatter).not.toHaveProperty("effort");
      expect(output.frontmatter).not.toHaveProperty("dotbabel");
    }
  });

  it("does not treat coordinator consumer metadata as enforced worker or native skill compute", () => {
    for (const entry of fixture.entries.filter(item => item.compute)) {
      const result = resolve({ requirement: parseProjectionSource(artifact(entry)).requirement, target: { runtimeId: "claude", artifactKind: "skill", sourcePath: entry.sourcePath }, catalog: snapshotCatalog(snapshot), policy: mergePolicy({ shipped: SHIPPED_POLICY }), runtimeContract: snapshot.runtimes.claude.runtimeContract });
      expect(result.enforcement.state, entry.sourcePath).not.toBe("enforced");
      expect(result.enforcement.basis).toBe("none");
    }
  });
});
