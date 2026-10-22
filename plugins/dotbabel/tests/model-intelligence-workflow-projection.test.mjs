import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { scaffoldHarness } from "../src/init-harness-scaffold.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { inspectWorkflowProjection } from "../src/model-intelligence/materialize/runtime/claude-workflow-status.mjs";
import { buildClaudeReviewWorkflow } from "../src/model-intelligence/materialize/runtime/claude-workflow.mjs";
import { createSnapshot } from "../src/model-intelligence/snapshot/core.mjs";
import { parseComputeDeclaration } from "../src/model-intelligence/requirement/index.mjs";
import { validateProjectionBatch } from "../src/model-intelligence/materialize/transaction.mjs";
import { hashContent } from "../src/model-intelligence/materialize/manifest.mjs";

const sourceContent = readFileSync(new URL("../src/model-intelligence/workflows/ai-review.source.yml", import.meta.url), "utf8");
const computeContent = readFileSync(new URL("../src/model-intelligence/workflows/ai-review.compute.yml", import.meta.url), "utf8");
const snapshot = JSON.parse(readFileSync(new URL("../src/model-intelligence/snapshot/release-capabilities.json", import.meta.url), "utf8"));
// The shipped workflow carries the package version, which a release bumps.
const { version: packageVersion } = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
const build = (extra = {}) => buildClaudeReviewWorkflow({ toolVersion: "4.2.0", sourceContent, computeContent, snapshot, ...extra });
const run = doc => doc.jobs.review.steps.find(step => step.name === "Run /review-prs headless").run;

describe("Claude review workflow release projection", () => {
  it("ai-review.compute.yml parses through requirement/ to binding session, and the generated ai-review.yml carries --model from the snapshot", () => {
    const declaration = yaml.load(computeContent);
    expect(parseComputeDeclaration(declaration, { sourcePath: "ai-review.compute.yml" }).requirement).toMatchObject({ requirement: "deep", mode: "floor", binding: "session" });
    const batch = build(); const generated = yaml.load(batch.files[0].content);
    expect(run(generated)).toMatch(/--model '[^']+'/);
    expect(run(generated)).toMatch(/--effort 'medium'/);
    expect(batch.manifest.entries["ai-review.yml"]).toMatchObject({ sourceHash: hashContent(sourceContent), snapshotId: snapshot.snapshotId, artifactKind: "workflow" });
    expect(validateProjectionBatch(batch)).toBe(batch);
  });
  it("ai-review.source.yml is valid workflow YAML with no model flag and no dotbabel key, and the generated file has no dotbabel key", () => {
    const source = yaml.load(sourceContent); const generated = yaml.load(build().files[0].content);
    expect(run(source)).not.toMatch(/--model|--effort/);
    expect(source).not.toHaveProperty("dotbabel"); expect(generated).not.toHaveProperty("dotbabel");
    expect(build().files[0].content).not.toContain("dotbabel.compute");
  });
  it("preserves authentication, provider invocation, settings, permissions, guards and pinned actions", () => {
    const source = yaml.load(sourceContent); const generated = yaml.load(build().files[0].content);
    const sourceRun = run(source);
    expect(run(generated).replace(/ --model '[^']+' --effort '[^']+'/, "")).toBe(sourceRun);
    generated.jobs.review.steps.find(step => step.name === "Run /review-prs headless").run = sourceRun;
    expect(generated).toEqual(source);
    expect(source.jobs.review.steps[0].uses).toMatch(/@[0-9a-f]{40}$/);
    expect(source.jobs.review.steps[1].env.ANTHROPIC_API_KEY).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
  });
  it("the build fails rather than omitting --model when the snapshot cannot satisfy the requirement", () => {
    for (const confidence of [false, true]) {
      const seed = structuredClone(snapshot);
      for (const model of seed.runtimes.claude.models) {
        if (confidence) for (const entries of Object.values(model.fields)) for (const entry of entries) entry.confidence = "low";
        else model.fields.capabilities[0].value.reasoning = false;
      }
      expect(() => build({ snapshot: createSnapshot(seed) })).toThrow("release_requirement_unsatisfied");
    }
  });
  it("rejects malformed, extra-key and non-session sidecars without echoing input", () => {
    for (const computeContent of ["[private-marker", "x-dotbabel: private-marker", "dotbabel:\n  compute:\n    mode: inherit\n    binding: self", "dotbabel:\n  compute:\n    requirement: deep\n    mode: floor\n    binding: session\nextra: private-marker"]) {
      expect(() => build({ computeContent })).toThrow("workflow_compute_invalid");
    }
  });
  it("rejects missing, duplicate or already configured native invocations", () => {
    for (const changed of [sourceContent.replace("npx @anthropic-ai/claude-code", "echo"), sourceContent.replace(" -p ", " --model opus -p "), sourceContent.replace(" --max-turns 40", " --max-turns 40\n          npx @anthropic-ai/claude-code -p duplicate")]) expect(() => build({ sourceContent: changed })).toThrow("workflow_invocation_invalid");
  });
  it("requires verified invocation bindings independently of agent bindings", () => {
    const seed = structuredClone(snapshot); seed.runtimes.claude.runtimeContract.capabilities.invocation.axes.model = "unverified";
    expect(() => build({ snapshot: createSnapshot(seed) })).toThrow("workflow_invocation_unverified");
  });
  it("is deterministic and does not mutate source facts or invent stable alias evidence", () => {
    const before = structuredClone(snapshot); const first = build();
    expect(build()).toEqual(first); expect(snapshot).toEqual(before);
    const generatedModel = run(yaml.load(first.files[0].content)).match(/--model '([^']+)'/)[1];
    expect(snapshot.runtimes.claude.models.some(model => model.model === generatedModel)).toBe(true);
  });
});

it("an initialized consumer retains its installed baseline when a later shipped release changes", () => {
  const templatesDir = path.resolve("plugins/dotbabel/templates"); const targetDir = makeTempDir("workflow-consumer-");
  scaffoldHarness({ templatesDir, targetDir, placeholders: {} });
  const root = path.join(targetDir, ".github/workflows");
  const installed = inspectWorkflowProjection(root); const before = readFileSync(path.join(root, "ai-review.yml"), "utf8");
  expect(installed).toMatchObject({ status: "present", configurationBasis: "projection", snapshotId: snapshot.snapshotId });
  expect(inspectWorkflowProjection(root, installed)).toMatchObject({ matchesShipped: true });
  const later = { ...installed, outputHash: "sha256:" + "0".repeat(64) };
  expect(inspectWorkflowProjection(root, later)).toMatchObject({ status: "present", matchesShipped: false, outputHash: installed.outputHash });
  expect(readFileSync(path.join(root, "ai-review.yml"), "utf8")).toBe(before);
  expect(() => scaffoldHarness({ templatesDir, targetDir, placeholders: {} })).toThrow();
  expect(readFileSync(path.join(root, "ai-review.yml"), "utf8")).toBe(before);
  writeFileSync(path.join(root, "ai-review.yml"), before + "# local edit\n");
  expect(inspectWorkflowProjection(root)).toMatchObject({ status: "unavailable" });
});

it("rejects invalid snapshot annotations and interrupted first installations", () => {
  const root = makeTempDir("workflow-status-"); const batch = build();
  writeFileSync(path.join(root, "ai-review.yml"), batch.files[0].content);
  const manifest = structuredClone(batch.manifest); manifest.entries["ai-review.yml"].snapshotId = [snapshot.snapshotId];
  writeFileSync(path.join(root, ".dotbabel-projection.json"), JSON.stringify(manifest));
  expect(inspectWorkflowProjection(root)).toMatchObject({ status: "unavailable" });
  const pending = path.join(root, "first-install"); mkdirSync(pending);
  writeFileSync(path.join(pending, ".dotbabel-projection.pending.json"), "{}");
  expect(inspectWorkflowProjection(pending)).toMatchObject({ status: "unavailable" });
});

it("public status distinguishes an older installed copy without changing consumer files", () => {
  const target = makeTempDir("workflow-public-status-"); const root = path.join(target, ".github/workflows"); mkdirSync(root, { recursive: true });
  const old = build({ toolVersion: "4.1.0" });
  writeFileSync(path.join(root, "ai-review.yml"), old.files[0].content);
  writeFileSync(path.join(root, ".dotbabel-projection.json"), JSON.stringify(old.manifest));
  const result = spawnSync(process.execPath, [path.resolve("plugins/dotbabel/bin/dotbabel-models.mjs"), "status", "--repo-root", target, "--json"], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: path.join(target, "cache") } });
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.shippedWorkflow).toMatchObject({ status: "present", toolVersion: packageVersion, configurationBasis: "projection", snapshotId: snapshot.snapshotId });
  expect(report.installedWorkflow).toMatchObject({ status: "present", toolVersion: "4.1.0", matchesShipped: false });
  expect(readFileSync(path.join(root, "ai-review.yml"), "utf8")).toBe(old.files[0].content);
});
