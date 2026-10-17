import { expect, it, vi } from "vitest";
import { decide, deciderAdapter } from "../src/decider.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { writeTask, createTask } from "../src/task-state.mjs";

const finding = { file: "src/a.mjs", title: "A defect", body: "Check the condition", diff_hunk: "+ return true", severity: "important", category: "bug" };
const consent = { adapter: "jev", steps: ["review-triage", "retry", "dispatch"] };
const options = { config: consent, consent: true, key: "canary-key-123", adapter: async () => ({ answer: "auto-valid", confidence: 0.99 }) };

it("each decider declares the operation capability contract", () => {
  for (const [name, support, network, auth, execution] of [["builtin", "supported", "never", "none", "read-only"], ["jev", "unverified", "required", "required-existing", "may-execute-model"], ["unknown", "unsupported", "never", "none", "read-only"]]) {
    const descriptor = deciderAdapter(name);
    expect(descriptor).toMatchObject({ name, support, network, auth, execution, cacheable: false });
    expect(Object.keys(descriptor.steps)).toEqual(["review-triage", "retry", "dispatch"]);
    for (const capability of Object.values(descriptor.steps)) {
      expect(capability).toMatchObject({ support, network, auth, execution, cacheable: false });
      expect(capability.evidence).toEqual(expect.any(String));
      expect(capability.evidence.length).toBeGreaterThan(0);
    }
  }
});

it("the built-in review-triage rule matches the fast path and the full validation", async () => {
  // The skill handles its authenticated mechanical fast path before calling decide.
  for (const category of ["bug", "design", "security", "test", "style"]) {
    expect(await decide("review-triage", { finding: { ...finding, category } })).toMatchObject({ answer: "full-validation", decider: "builtin", fallback: false, shadow: null });
  }
});
it("a critical or missing severity always gets full-validation for any adapter answer", async () => {
  for (const severity of ["critical", undefined, null, ""]) {
    for (const answer of ["auto-valid", "auto-false-positive", "full-validation", null, 1, { bad: true }]) {
      const out = await decide("review-triage", { finding: { ...finding, severity } }, { ...options, adapter: async () => ({ answer, confidence: 1 }) });
      expect(out.answer).toBe("full-validation");
      if (out.shadow) expect(out.shadow.answer).toBe("full-validation");
    }
  }
});
it("without the repository's consent the adapter is never called", async () => {
  const adapter = vi.fn();
  expect(await decide("review-triage", { finding }, { ...options, consent: false, adapter })).toMatchObject({ fallback: true, decider: "builtin" });
  expect(adapter).not.toHaveBeenCalled();
});
it("in shadow mode the skill follows the built-in answer", async () => {
  const out = await decide("review-triage", { finding }, options);
  expect(out).toMatchObject({ answer: "full-validation", decider: "builtin", shadow: { decider: "jev", answer: "auto-valid", confidence: 0.99 } });
});
it("an adapter answers a step only when that step is adopted", async () => {
  // The locked triage experiment returned REJECT; retry and dispatch have no ADOPT evidence.
  for (const step of ["review-triage", "retry", "dispatch"]) {
    expect(deciderAdapter("jev").steps[step].support).toBe("unverified");
  }
  const out = await decide("review-triage", { finding }, { ...options, config: { ...consent, adopted: true, hi: 0.1 } });
  expect(out.answer).toBe("full-validation");
});
it("an adapter timeout returns the built-in answer with fallback true and exit 0", async () => {
  vi.useFakeTimers();
  try {
    let signal;
    const pending = decide("review-triage", { finding }, { ...options, adapter: (_, __, opts) => { signal = opts.signal; return new Promise(() => {}); } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ answer: "full-validation", fallback: true });
    expect(signal.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});
it.each([null, {}, { answer: "bogus", confidence: 1 }, { answer: "auto-valid", confidence: NaN }, { answer: "auto-valid", confidence: 2 }])("malformed adapter output falls back: %j", async (result) => {
  expect(await decide("review-triage", { finding }, { ...options, adapter: async () => result })).toMatchObject({ fallback: true, shadow: null });
});
it("exceptions, missing keys, and disabled steps use the built-in rule", async () => {
  const adapter = vi.fn(() => { throw new Error(options.key); });
  for (const overrides of [{ adapter }, { key: "" }, { config: { ...consent, steps: [] } }]) {
    const out = await decide("review-triage", { finding }, { ...options, ...overrides });
    expect(out).toMatchObject({ decider: "builtin", fallback: true });
    expect(JSON.stringify(out)).not.toContain(options.key);
  }
});
it("retry cannot exceed the attempt cap, even with an adapter answer", async () => {
  const out = await decide("retry", { phase: "review-pr", attempt: 3, failure_tail: "error" }, { ...options, adapter: async () => ({ answer: "retry", confidence: 1 }) });
  expect(out.answer).toBe("ask-owner");
  expect(out.shadow.answer).toBe("ask-owner");
  expect((await decide("retry", { phase: "review-pr", attempt: 1, failure_tail: "error" })).answer).toBe("fix");
});
it("dispatch only adds candidates and preserves the security reviewer", async () => {
  const input = { profile: ["architect-reviewer"], changed_files: ["a.mjs"], changed_lines: 10, candidates: ["documentation-writer"] };
  const out = await decide("dispatch", input, { ...options, adapter: async () => ({ answer: ["evil", "documentation-writer"], confidence: 1 }) });
  expect(out.answer).toEqual(["security-auditor"]);
  expect(out.shadow).toBeNull();
  expect(out.fallback).toBe(true);
  const candidates = Array.from({ length: 100 }, (_, i) => `reviewer-${i}`);
  const oversized = await decide("dispatch", { ...input, candidates, profile: [] }, { ...options, adapter: async () => ({ answer: candidates, confidence: 1 }) });
  expect(oversized).toMatchObject({ answer: ["security-auditor"], shadow: null, fallback: true });
  const valid = await decide("dispatch", input, { ...options, adapter: async () => ({ answer: ["documentation-writer"], confidence: 1 }) });
  expect(valid.shadow.answer).toEqual(expect.arrayContaining(["documentation-writer", "security-auditor"]));
  expect(input.profile).toEqual(["architect-reviewer"]);
});
it("rejects unknown steps, malformed input, and unbounded payloads", async () => {
  for (const [step, input] of [["unknown", {}], ["review-triage", {}], ["retry", { phase: "x", attempt: -1, failure_tail: "x" }], ["dispatch", { profile: [], changed_files: [], changed_lines: -1, candidates: [] }], ["review-triage", { finding: { ...finding, body: "x".repeat(65537) } }]]) {
    await expect(decide(step, input)).rejects.toThrow();
  }
  await expect(decide("review-triage", { finding: { ...finding, body: "é".repeat(40000) } })).rejects.toThrow(/oversized/);
});
it("the adapter receives only the step input and an abort signal", async () => {
  const adapter = vi.fn(async () => ({ answer: "auto-valid", confidence: 1 }));
  await decide("review-triage", { finding }, { ...options, adapter });
  const [step, input, opts] = adapter.mock.calls[0];
  expect(step).toBe("review-triage");
  expect(input).toEqual({ finding });
  expect(Object.keys(opts)).toEqual(["signal"]);
});

it("invalid fields and boundary violations never reach an adapter", async () => {
  const adapter = vi.fn();
  const invalid = [null, [], "payload", { finding, unknown: "private" }, { finding: [] }, { finding: { ...finding, unknown: "private" } }];
  for (const field of ["file", "title", "body", "diff_hunk"]) {
    const missing = { ...finding }; delete missing[field];
    invalid.push({ finding: missing }, { finding: { ...finding, [field]: 1 } });
  }
  invalid.push({ finding: { ...finding, severity: {} } }, { finding: { ...finding, category: 1 } }, { finding: { ...finding, body: "x".repeat(60001) } });
  for (const input of invalid) await expect(decide("review-triage", input, { ...options, adapter })).rejects.toThrow();
  const retry = { phase: "review-pr", attempt: 1, failure_tail: "error" };
  for (const change of [{ phase: "" }, { phase: 1 }, { attempt: 0 }, { attempt: 1.5 }, { failure_tail: {} }]) await expect(decide("retry", { ...retry, ...change }, { ...options, adapter })).rejects.toThrow();
  const dispatch = { profile: ["security-auditor"], candidates: ["architect-reviewer"], changed_files: ["a.mjs"], changed_lines: 1 };
  for (const change of [{ profile: "security-auditor" }, { profile: ["bad id"] }, { candidates: "reviewer" }, { candidates: [1] }, { candidates: Array(101).fill("reviewer") }, { changed_files: "a.mjs" }, { changed_files: [1] }, { changed_lines: 0.5 }]) await expect(decide("dispatch", { ...dispatch, ...change }, { ...options, adapter })).rejects.toThrow();
  expect(adapter).not.toHaveBeenCalled();
});

it("a model cannot mutate the original finding or introduce arbitrary receipt metadata", async () => {
  const input = { finding: { ...finding, severity: "critical" } };
  const out = await decide("review-triage", input, { ...options, adapter: async (_, payload) => { payload.finding.severity = "important"; return { answer: "auto-valid", confidence: 1, key: options.key }; } });
  expect(input.finding.severity).toBe("critical");
  expect(out.shadow.answer).toBe("full-validation");
  expect(JSON.stringify(out)).not.toContain(options.key);
});

it("a canary key never reaches the receipt, an export, or a log line", async () => {
  const key = "canary-secret-graph-123";
  const decision = await decide("review-triage", { finding }, { ...options, key, adapter: async () => { throw new Error(key); } });
  const cwd = makeTempDir("canary-");
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(cwd, "file"), "test");
  git("add", "file");
  git("-c", "user.name=t", "-c", "user.email=t@example.org", "commit", "-qm", "init");
  const sha = git("rev-parse", "HEAD").trim();
  const binDir = path.join(cwd, "bin"); fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "gh"), `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({headRefOid:${JSON.stringify(sha)},baseRefName:"main"}));\n`, { mode: 0o755 });
  const env = { ...process.env, TYPESAFE_API_KEY: key, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  fs.writeFileSync(path.join(cwd, "decisions.json"), JSON.stringify([decision]));
  const bins = path.resolve(import.meta.dirname, "../bin");
  const record = spawnSync(process.execPath, [path.join(bins, "dotbabel-pr-stack.mjs"), "record", "--pr", "7", "--phase", "review-pr", "--outcome", "fail", "--decisions", "decisions.json"], { cwd, env, encoding: "utf8" });
  expect(record.status).toBe(0);
  const receipt = fs.readFileSync(path.join(cwd, ".git/dotbabel/receipts/pr-7.json"), "utf8");
  expect(JSON.parse(receipt).attempts[0].decisions).toEqual([decision]);
  writeTask(cwd, createTask({ slug: "test", goal: `Contains ${key}`, doneWhen: ["done"], worktree: cwd }));
  const logs = [record.stdout, record.stderr];
  for (const format of ["a2a", "otlp"]) {
    const target = path.join(cwd, `${format}.json`);
    const out = spawnSync(process.execPath, [path.join(bins, "dotbabel-export.mjs"), `--${format}`, target], { cwd, env, encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(fs.readFileSync(target, "utf8")).not.toContain(key);
    logs.push(out.stdout, out.stderr);
  }
  expect(receipt + logs.join("")).not.toContain(key);
  const injected = { step: "dispatch", answer: [key], decider: "builtin", confidence: 1, fallback: false, shadow: null };
  fs.writeFileSync(path.join(cwd, "decisions.json"), JSON.stringify([injected]));
  const rejected = spawnSync(process.execPath, [path.join(bins, "dotbabel-pr-stack.mjs"), "record", "--pr", "7", "--phase", "review-pr", "--outcome", "fail", "--decisions", "decisions.json"], { cwd, env, encoding: "utf8" });
  expect(rejected.status).toBe(64);
  expect(rejected.stdout + rejected.stderr).not.toContain(key);
  expect(fs.readFileSync(path.join(cwd, ".git/dotbabel/receipts/pr-7.json"), "utf8")).toBe(receipt);
});
