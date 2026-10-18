import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { materializationFixture } from "./fixtures/model-intelligence/materialize.mjs";
import { renderProjection, parseProjectionSource } from "../src/model-intelligence/materialize/render.mjs";
import { buildClaudeReviewWorkflow } from "../src/model-intelligence/materialize/runtime/claude-workflow.mjs";
import { inspectWorkflowProjection } from "../src/model-intelligence/materialize/runtime/claude-workflow-status.mjs";
import { createSnapshot } from "../src/model-intelligence/snapshot/core.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const sourceContent = readFileSync(new URL("../src/model-intelligence/workflows/ai-review.source.yml", import.meta.url), "utf8");
const computeContent = readFileSync(new URL("../src/model-intelligence/workflows/ai-review.compute.yml", import.meta.url), "utf8");
const snapshot = JSON.parse(readFileSync(new URL("../src/model-intelligence/snapshot/release-capabilities.json", import.meta.url), "utf8"));
const build = (extra = {}) => buildClaudeReviewWorkflow({ toolVersion: "4.2.0", snapshot, sourceContent, computeContent, ...extra });
const native = value => yaml.load(value.split("---\n")[1]);
const render = (artifact, source = parseProjectionSource(artifact)) => renderProjection(artifact, "sha256:" + "a".repeat(64), source);
const fixture = () => materializationFixture().artifacts[0];

function installed(change = () => {}) {
  const root = makeTempDir("workflow-boundary-"); const batch = build();
  writeFileSync(path.join(root, "ai-review.yml"), batch.files[0].content);
  change(batch.manifest);
  writeFileSync(path.join(root, ".dotbabel-projection.json"), JSON.stringify(batch.manifest));
  return { root, batch };
}

describe("workflow release input boundaries", () => {
  it("uses bounded content-free errors for malformed or oversized source documents", () => {
    for (const sourceContent of ["[private-marker", "", null, "dotbabel: {}", "#" + "x".repeat(1024 * 1024)]) expect(() => build({ sourceContent })).toThrow("workflow_source_invalid");
    for (const changed of ["", null, "dotbabel: {}", "dotbabel:\n  private: marker", computeContent + "  extra: marker\n"]) expect(() => build({ computeContent: changed })).toThrow();
    const exact = "#" + "x".repeat(1024 * 1024 - Buffer.byteLength(sourceContent) - 3) + "\n" + sourceContent + "\n";
    expect(Buffer.byteLength(exact)).toBe(1024 * 1024); expect(build({ sourceContent: exact }).files).toHaveLength(1);
  });
  it("rejects a non-workflow source and a command hidden by a comment or another step", () => {
    for (const source of ["name: example", "jobs: {}", "jobs:\n  review:\n    steps: {}", sourceContent.replace("Run /review-prs headless", "Other step"), sourceContent.replace("npx @anthropic-ai/claude-code -p", "echo npx @anthropic-ai/claude-code -p"), "# npx @anthropic-ai/claude-code -p comment\n" + sourceContent]) expect(() => build({ sourceContent: source })).toThrow("workflow_invocation_invalid");
    const doc = yaml.load(sourceContent); doc.jobs.review.steps.push({ name: "Second invocation", run: "npx @anthropic-ai/claude-code --version" });
    expect(() => build({ sourceContent: yaml.dump(doc) })).toThrow("workflow_invocation_invalid");
    doc.jobs.review.steps.pop(); doc.jobs.review.steps.push({ name: "Numeric run", run: 3 });
    expect(build({ sourceContent: yaml.dump(doc) }).files).toHaveLength(1);
  });
  it("rejects unsupported invocation scope or reasoning independently", () => {
    for (const axis of ["support", "reasoning"]) {
      const seed = structuredClone(snapshot); const invocation = seed.runtimes.claude.runtimeContract.capabilities.invocation;
      if (axis === "support") invocation.support = "unverified"; else invocation.axes.reasoning = "unverified";
      expect(() => build({ snapshot: createSnapshot(seed) })).toThrow("workflow_invocation_unverified");
    }
  });
  it("uses an exact canonical session pin and safely quotes opaque selectors", () => {
    const pin = { dotbabel: { compute: { requirement: "deep", mode: "pin", binding: "session", rationale: "Keep the reviewed exact axes.", pin: { runtime: "claude", config: { model: "opus", reasoning: "high" } } } } };
    const batch = build({ computeContent: yaml.dump(pin) });
    expect(yaml.load(batch.files[0].content).jobs.review.steps[1].run).toContain("--model 'opus' --effort 'high'");
    const seed = structuredClone(snapshot); const model = seed.runtimes.claude.models[0];
    seed.runtimes.claude.models = [model]; model.model = "selector'quoted"; for (const entry of model.fields.id) entry.value = model.model;
    const escaped = build({ snapshot: createSnapshot(seed) });
    expect(yaml.load(escaped.files[0].content).jobs.review.steps[1].run).toContain("--model 'selector'\"'\"'quoted'");
  });
  it("does not invent effort when accepted facts provide no default", () => {
    const seed = structuredClone(snapshot); for (const model of seed.runtimes.claude.models) delete model.fields.defaultReasoningLevel;
    expect(yaml.load(build({ snapshot: createSnapshot(seed) }).files[0].content).jobs.review.steps[1].run).not.toContain("--effort");
  });
});

describe("workflow installed provenance boundaries", () => {
  it("reports an absent tree without changing it", () => {
    const root = path.join(makeTempDir("workflow-absent-"), "missing");
    expect(inspectWorkflowProjection(root)).toEqual({ status: "absent", configurationBasis: "projection" });
  });
  it("returns exact projection facts and compares both output and snapshot identities", () => {
    const { root, batch } = installed(); const entry = batch.manifest.entries["ai-review.yml"];
    const expected = { status: "present", configurationBasis: "projection", toolVersion: "4.2.0", snapshotId: snapshot.snapshotId, outputHash: entry.outputHash, matchesShipped: null };
    expect(inspectWorkflowProjection(root)).toEqual(expected);
    expect(inspectWorkflowProjection(root, { ...expected, status: "unavailable" }).matchesShipped).toBeNull();
    expect(inspectWorkflowProjection(root, { ...expected, snapshotId: "sha256:" + "0".repeat(64) }).matchesShipped).toBe(false);
  });
  it("rejects malformed manifests and ownership metadata with a bounded diagnostic", () => {
    for (const text of ["private-marker", "null", "{}", '{"entries":{}}']) {
      const { root } = installed(); writeFileSync(path.join(root, ".dotbabel-projection.json"), text);
      expect(inspectWorkflowProjection(root)).toEqual({ status: "unavailable", configurationBasis: "projection", reason: "workflow_projection_invalid" });
    }
    for (const patch of [{ runtimeId: "codex" }, { artifactKind: "agent" }, { snapshotId: "x" + snapshot.snapshotId }, { snapshotId: snapshot.snapshotId + "x" }, { snapshotId: "invalid" }]) {
      const { root } = installed(manifest => Object.assign(manifest.entries["ai-review.yml"], patch));
      expect(inspectWorkflowProjection(root)).toEqual({ status: "unavailable", configurationBasis: "projection", reason: "workflow_projection_invalid" });
    }
    const { root } = installed(manifest => { manifest.entries["extra.yml"] = manifest.entries["ai-review.yml"]; });
    expect(inspectWorkflowProjection(root).status).toBe("unavailable");
  });
  it("rejects incomplete installations and filesystem redirection", () => {
    const { root } = installed(); writeFileSync(path.join(root, ".dotbabel-projection.pending.json"), "{}");
    expect(inspectWorkflowProjection(root)).toEqual({ status: "unavailable", configurationBasis: "projection", reason: "workflow_projection_invalid" });
    const interrupted = makeTempDir("workflow-broken-pending-");
    symlinkSync(path.join(interrupted, "missing"), path.join(interrupted, ".dotbabel-projection.pending.json"));
    expect(inspectWorkflowProjection(interrupted)).toMatchObject({ status: "unavailable" });
    const alias = path.join(makeTempDir("workflow-symlink-"), "alias"); symlinkSync(root, alias);
    expect(inspectWorkflowProjection(alias)).toMatchObject({ status: "unavailable" });
    const blocked = path.join(makeTempDir("workflow-blocked-"), "file"); writeFileSync(blocked, "not a directory");
    expect(inspectWorkflowProjection(blocked)).toMatchObject({ status: "unavailable", reason: "ENOTDIR" });
  });
});

describe("native projection emission contract", () => {
  it("rejects unsafe metadata names and incomplete extension declarations", () => {
    for (const keys of [null, [3], ["!name"], ["name!"], ["constructor"], ["prototype"]]) {
      const a = fixture(); a.projectionContract.frontmatterKeys = keys;
      expect(() => render(a)).toThrow("invalid projection metadata contract");
    }
    for (const consumer of [undefined, "", "   "]) {
      const a = fixture(); a.projectionContract.permitsCompute = true; if (consumer !== undefined) a.projectionContract.computeConsumer = consumer;
      expect(() => render(a)).toThrow("private compute metadata needs an explicit consumer");
    }
    for (const axes of [{ unsupported: "model" }, { model: 3 }]) {
      const a = fixture(); a.projectionContract.axisKeys = axes; expect(() => render(a)).toThrow("invalid projection axis mapping");
    }
  });
  it("limits the YAML output contract to a workflow and a string body", () => {
    const a = fixture(); a.projectionContract = { outputFormat: "yaml", outputBody: "name: example\n", frontmatterKeys: [] };
    expect(() => render(a)).toThrow("invalid YAML projection contract");
    a.target.artifactKind = "workflow"; a.projectionContract.outputBody = null;
    expect(() => render(a)).toThrow("invalid YAML projection contract");
  });
  it("never promotes a recommendation or unrelated enforcement basis into emitted native axes", () => {
    for (const enforcement of [undefined, { state: "enforced", basis: "none" }, { state: "unknown", basis: "artifact-binding" }]) {
      const a = fixture(); a.resolverResult.enforcement = enforcement;
      expect(native(render(a))).not.toHaveProperty("model");
    }
    const a = fixture(); delete a.runtimeContract.binding;
    expect(native(render(a))).not.toHaveProperty("model");
    a.projectionContract.frontmatterKeys.push("dotbabel");
    expect(native(render(a))).not.toHaveProperty("dotbabel");
  });
  it("preserves native metadata values and deterministic ordering without YAML references", () => {
    for (const preferUnescapedQuotes of [false, true]) {
      const a = fixture(); const shared = { nested: "same" };
      const source = parseProjectionSource(a); source.frontmatter = { z: 'contains "double" and apostrophe\'s', a: 'contains "double"', n: 3, refs: { left: shared, right: shared } };
      a.projectionContract = { frontmatterKeys: ["z", "refs", "n", "a"], axisKeys: {}, preferUnescapedQuotes };
      const content = render(a, source); expect(native(content)).toEqual(source.frontmatter);
      expect(content.indexOf("a:")).toBeLessThan(content.indexOf("z:")); expect(content).not.toMatch(/&ref|\*ref/);
    }
  });
});

it("rejects a replacement that reaches a comment instead of the executable run string", () => {
  const doc = yaml.load(sourceContent); const current = doc.jobs.review.steps[1].run;
  const prefix = sourceContent.slice(0, sourceContent.indexOf("        run: |"));
  const encoded = JSON.stringify(current).replace("claude-code -p", "claude-code\\u0020-p");
  const changed = prefix + "        run: " + encoded + "\n# npx @anthropic-ai/claude-code -p not-executed\n";
  expect(yaml.load(changed).jobs.review.steps[1].run).toBe(current);
  expect(() => build({ sourceContent: changed })).toThrow("workflow_invocation_invalid");
});
it("rejects every exact axis that the native invocation renderer cannot express", () => {
  const seed = structuredClone(snapshot); seed.runtimes.claude.runtimeContract.capabilities.invocation.axes.contextTier = "supported";
  const compute = { dotbabel: { compute: { requirement: "deep", mode: "pin", binding: "session", rationale: "Preserve every selected axis.", pin: { runtime: "claude", config: { model: "opus", contextTier: "1m" } } } } };
  expect(() => build({ snapshot: createSnapshot(seed), computeContent: yaml.dump(compute) })).toThrow("workflow_invocation_axes_unsupported");
});
it("rejects Actions interpolation in model and effort values before writing workflow code", () => {
  for (const axis of ["model", "reasoning"]) {
    const seed = structuredClone(snapshot); const model = seed.runtimes.claude.models[0]; seed.runtimes.claude.models = [model];
    if (axis === "model") { model.model = "${{ github.event.pull_request.title }}"; for (const entry of model.fields.id) entry.value = model.model; }
    else { model.fields.supportedReasoningLevels[0].value = [{ effort: "${{ inputs.effort }}" }]; model.fields.defaultReasoningLevel[0].value = "${{ inputs.effort }}"; }
    expect(() => build({ snapshot: createSnapshot(seed) })).toThrow("workflow_native_value_invalid");
  }
});
