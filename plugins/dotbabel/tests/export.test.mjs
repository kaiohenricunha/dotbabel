import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { a2aTasks, otlpSpans, exportJson, CONVENTION_VERSION } from "../src/export.mjs";
import { createReceipt, appendAttempt } from "../src/run-receipt.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { createTask, closeTask, writeTask } from "../src/task-state.mjs";
import { registerClone, registryFile } from "../src/clone-registry.mjs";

const tasks = [
  { slug: "a", status: "open", phase: null, depends_on: [], worktree: "/repo", updated_at: "2026-10-16T00:00:00Z", goal: "First" },
  { slug: "b", status: "open", phase: "review-pr", depends_on: ["a"], worktree: "/repo", updated_at: "2026-10-16T00:00:00Z", goal: "Second" },
  { slug: "c", status: "closed", phase: "stop", depends_on: [], worktree: "/repo", updated_at: "2026-10-16T00:00:00Z", goal: "Third" },
];
it("export serialization redacts keys while preserving valid JSON and value types", () => {
  const value = { text: "key-with-quotes-\"\\ is private", count: 2, nested: [true, null] };
  const output = exportJson(value, ["", "key-with-quotes-\"\\"]);
  expect(JSON.parse(output)).toEqual({ ...value, text: "<redacted> is private" });
  expect(JSON.parse(exportJson(value))).toEqual(value);
});
it("the A2A export maps open, phase-set, and closed tasks", () => {
  const out = a2aTasks(tasks, "github.com/a/b");
  expect(out.map((t) => t.status.state)).toEqual(["TASK_STATE_SUBMITTED", "TASK_STATE_WORKING", "TASK_STATE_COMPLETED"]);
  expect(out[1].metadata.blockedBy).toEqual([{ ref: "a", state: "open" }]);
  expect(out[0].metadata).toMatchObject({ slug: "a", goal: "First", phase: null });
  expect(out[1].metadata).toMatchObject({ slug: "b", goal: "Second", phase: "review-pr" });
  expect(out[0].status.timestamp).toBe(tasks[0].updated_at);
  for (const task of out) expect(task.contextId).toMatch(/^[0-9a-f]{32}$/);
  expect(new Set(out.map((t) => t.id)).size).toBe(3);
  expect(a2aTasks(tasks, "github.com/a/b")).toEqual(out);
});
it("the OTLP export names its convention version", () => {
  expect(CONVENTION_VERSION).toMatch(/^gen-ai-development@[0-9a-f]{40}$/);
  const decision = { step: "review-triage", answer: "full-validation", decider: "builtin", confidence: 1, fallback: false, shadow: { decider: "jev", answer: "auto-valid", confidence: 0.9 } };
  const receipt = appendAttempt(createReceipt({ pr: 7 }), { phase: "review-pr", outcome: "pass", headSha: "a".repeat(40), decisions: [decision] });
  const output = otlpSpans([receipt]);
  const resource = output.resourceSpans[0];
  expect(resource.resource.attributes).toContainEqual({ key: "dotbabel.otel.convention.version", value: { stringValue: CONVENTION_VERSION } });
  const spans = resource.scopeSpans[0].spans;
  expect(spans.map((s) => s.name)).toEqual(["phase review-pr", "decide review-triage"]);
  for (const span of spans) {
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.startTimeUnixNano).toMatch(/^\d+$/);
    expect(span.endTimeUnixNano).toBe(span.startTimeUnixNano);
  }
  expect(spans[1].parentSpanId).toBe(spans[0].spanId);
  expect(spans[0].kind).toBe(1);
  expect(spans[0].attributes).toContainEqual({ key: "dotbabel.outcome", value: { stringValue: "pass" } });
  expect(spans[0].attributes).toContainEqual({ key: "dotbabel.self_reported", value: { boolValue: true } });
  expect(spans[1].attributes).toEqual(expect.arrayContaining([
    { key: "dotbabel.decider", value: { stringValue: "builtin" } },
    { key: "dotbabel.answer", value: { stringValue: "full-validation" } },
    { key: "dotbabel.confidence", value: { doubleValue: 1 } },
    { key: "dotbabel.fallback", value: { boolValue: false } },
    { key: "gen_ai.request.model", value: { stringValue: "jev-1.13.0" } },
  ]));
  expect(spans[1].attributes).toContainEqual({ key: "gen_ai.provider.name", value: { stringValue: "typesafe" } });
});
it("empty exports are valid and invalid receipts are refused", () => {
  expect(a2aTasks([], "r")).toEqual([]);
  expect(otlpSpans([]).resourceSpans[0].scopeSpans[0].spans).toEqual([]);
  expect(() => otlpSpans([{ schema_version: 99 }])).toThrow();
});
it("OTLP IDs distinguish receipts and attempts, and timestamps use nanoseconds", () => {
  const at = new Date("2026-10-16T12:00:00Z");
  const decision = { step: "dispatch", answer: ["security-auditor"], decider: "builtin", confidence: 0, fallback: true, shadow: null };
  let receipt = createReceipt({ pr: 7, now: at });
  for (let i = 0; i < 2; i++) receipt = appendAttempt(receipt, { phase: "review-pr", outcome: "fail", headSha: "a".repeat(40), decisions: [decision], now: at });
  const other = appendAttempt(createReceipt({ pr: 8, now: at }), { phase: "review-pr", outcome: "pass", headSha: "b".repeat(40), decisions: [{ ...decision, decider: "jev" }], now: at });
  const resource = otlpSpans([receipt, other]).resourceSpans[0];
  const spans = resource.scopeSpans[0].spans;
  expect(new Set(spans.map((s) => s.spanId)).size).toBe(6);
  expect(new Set(spans.map((s) => s.traceId)).size).toBe(2);
  expect(spans[0].startTimeUnixNano).toBe(String(BigInt(at.getTime()) * 1000000n));
  expect(spans[1].attributes.some((a) => a.key === "dotbabel.shadow" || a.key === "gen_ai.provider.name")).toBe(false);
  expect(spans[5].attributes).toContainEqual({ key: "gen_ai.provider.name", value: { stringValue: "typesafe" } });
  expect(resource.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "dotbabel" } });
  expect(resource.scopeSpans[0].scope).toEqual({ name: "dotbabel.graph-engineering", version: CONVENTION_VERSION });
});
it("the export CLI writes a private file and refuses to overwrite an existing file", () => {
  const cwd = makeTempDir("export-cli-");
  execFileSync("git", ["init", "-q"], { cwd });
  const bin = path.resolve(import.meta.dirname, "../bin/dotbabel-export.mjs");
  const output = path.join(cwd, "tasks.json");
  const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
  expect(run(["--a2a", output]).status).toBe(0);
  expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual([]);
  expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  expect(run(["--a2a", output]).status).toBe(2);
  expect(run([]).status).toBe(64);
  expect(run(["--a2a", output, "--otlp", output]).status).toBe(64);
  const receiptDir = path.join(cwd, ".git", "dotbabel", "receipts");
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(path.join(receiptDir, "pr-7.json"), JSON.stringify(createReceipt({ pr: 8 })));
  const otlp = path.join(cwd, "spans.json");
  expect(run(["--otlp", otlp]).status).toBe(2);
  expect(fs.existsSync(otlp)).toBe(false);
});
it("A2A export resolves registered cross-repository tasks offline", () => {
  const cwd = makeTempDir("export-local-");
  const foreign = makeTempDir("export-foreign-");
  for (const root of [cwd, foreign]) execFileSync("git", ["init", "-q"], { cwd: root });
  const external = createTask({ slug: "external", goal: "External", doneWhen: ["done"], worktree: foreign });
  writeTask(foreign, closeTask(external));
  writeTask(cwd, createTask({ slug: "consumer", goal: "Consumer", doneWhen: ["done"], worktree: cwd, dependsOn: ["github.com/acme/foreign:external"] }));
  const env = { ...process.env, XDG_STATE_HOME: path.join(cwd, "state") };
  registerClone(registryFile(env), "github.com/acme/foreign", foreign);
  const output = path.join(cwd, "tasks.json");
  const bin = path.resolve(import.meta.dirname, "../bin/dotbabel-export.mjs");
  const out = spawnSync(process.execPath, [bin, "--a2a", output], { cwd, env, encoding: "utf8" });
  expect(out.status).toBe(0);
  expect(JSON.parse(fs.readFileSync(output, "utf8"))[0].metadata.blockedBy).toEqual([]);
});
