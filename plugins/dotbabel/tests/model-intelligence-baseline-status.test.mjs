import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectClaudeProjection } from "../src/model-intelligence/materialize/runtime/claude-baseline.mjs";
import { materializeClaude } from "../src/model-intelligence/materialize/runtime/claude.mjs";
import { claudeProjectionFixture } from "./fixtures/model-intelligence/claude-projection.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

it("distinguishes a local projection from the immutable shipped baseline", () => {
  const root = makeTempDir("mi-baseline-status-"); const localRoot = path.join(root, ".claude");
  const options = claudeProjectionFixture(); options.artifacts[0].snapshotId = null;
  const batch = materializeClaude(options);
  for (const file of batch.files) { const target = path.join(localRoot, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content); }
  fs.writeFileSync(path.join(localRoot, ".dotbabel-projection.json"), JSON.stringify(batch.manifest));
  const local = inspectClaudeProjection(localRoot);
  expect(local).toMatchObject({ status: "present", origin: "local-projection", configurationBasis: "projection", snapshotIds: [], projections: [{ path: "agents/example.md", axes: { model: "deep-model", reasoning: "focused" } }] });
  const bin = path.resolve("plugins/dotbabel/bin/dotbabel-models.mjs");
  const processResult = spawnSync(process.execPath, [bin, "status", "--repo-root", root, "--json"], { encoding: "utf8" });
  expect(processResult.status, processResult.stderr).toBe(0);
  const status = JSON.parse(processResult.stdout);
  expect(status.localProjection).toEqual(local);
  expect(status.shippedBaseline.status).toBe("present");
  expect(status.shippedBaseline.origin).toBe("release-baseline");
  expect(status.shippedBaseline.snapshotIds).toEqual([status.releaseSnapshot.snapshotId]);
  expect(status.shippedBaseline.configurationBasis).toBe("projection");
  expect(status.shippedBaseline).not.toHaveProperty("effective");
});
it("reports absent and modified projections without treating them as execution evidence", () => {
  const root = makeTempDir("mi-baseline-status-");
  expect(inspectClaudeProjection(root)).toMatchObject({ status: "absent" });
  fs.writeFileSync(path.join(root, ".dotbabel-projection.json"), "{}");
  expect(inspectClaudeProjection(root)).toMatchObject({ status: "unavailable", reason: "claude_baseline_manifest_invalid" });
});
it("does not publish an unvalidated snapshot identity from otherwise valid generated output", () => {
  const root = makeTempDir("mi-baseline-status-"); const batch = materializeClaude(claudeProjectionFixture());
  for (const file of batch.files) { const target = path.join(root, file.path); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content); }
  batch.manifest.entries[batch.files[0].path].snapshotId = "unreviewed-private-marker";
  fs.writeFileSync(path.join(root, ".dotbabel-projection.json"), JSON.stringify(batch.manifest));
  const result = inspectClaudeProjection(root);
  expect(result).toMatchObject({ status: "unavailable", reason: "claude_baseline_manifest_invalid" });
  expect(JSON.stringify(result)).not.toContain("unreviewed-private-marker");
});
it("reports an interrupted first installation before a manifest exists", () => {
  const root = makeTempDir("mi-baseline-status-");
  fs.writeFileSync(path.join(root, ".dotbabel-projection.pending.json"), "{}");
  expect(inspectClaudeProjection(root)).toMatchObject({ status: "unavailable", reason: "claude_baseline_incomplete" });
});
