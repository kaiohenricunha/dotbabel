import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RULES, analyze as v1Analyze, sampleHash, protocolHash as v1Hash } from "../graph-step-adoption/protocol.mjs";
import * as v3 from "../graph-step-adoption-v3/protocol.mjs";
import { POLICY, protocolHash, sourceBindings, inspectDataset, createLock, validateLock, requestPlan } from "./protocol.mjs";
import { evaluate } from "./analysis.mjs";
import { sendPlan } from "./send.mjs";
import { retryFixture, rewrite } from "./fixture.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-retry-v4-"));
let fixture, lock;
before(() => { fixture = retryFixture(path.join(root, "data")); lock = path.join(root, "study-lock.json"); createLock(fixture.root, lock); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const rows = file => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
let copies = 0;
const copy = () => { const dir = path.join(root, `copy-${copies++}`); fs.cpSync(fixture.root, dir, { recursive: true }); fs.chmodSync(dir, 0o700); return dir; };
const answersFor = (plan, eligible, pick = r => r.label, confidence = 1) => plan.map((p, i) => ({ id: p.id, protocol_hash: p.protocol_hash,
  lock_sha256: p.lock_sha256, sample_hash: p.sample_hash, answer: pick(eligible[i]), confidence, fallback: false }));

test("v4 keeps every v1 rule, records owner approval, and binds the v3 and v4 implementation bytes", () => {
  assert.equal(POLICY.version, 4); assert.equal(POLICY.step, "retry"); assert.equal(POLICY.human_labels, false);
  assert.equal(POLICY.approval.date, "2026-10-19"); assert.deepEqual(read(lock).rules, RULES);
  assert.notEqual(protocolHash(), v3.protocolHash()); assert.notEqual(protocolHash(), v1Hash());
  const bindings = sourceBindings(), paths = new Set(bindings.map(r => r.path));
  for (const entry of v3.sourceBindings()) assert.ok(paths.has(entry.path), entry.path);
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  for (const entry of bindings) for (const match of fs.readFileSync(path.join(repo, entry.path), "utf8").matchAll(/^import\s[\s\S]*?from\s*["'](\.[^"']+)["']/gm))
    assert.ok(paths.has(path.relative(repo, path.resolve(path.dirname(path.join(repo, entry.path)), match[1]))), match[1]);
});

test("the inspector admits attempts 1 and 2, counts cap-determined cases and unknowns, and meets the floors", () => {
  const result = inspectDataset(fixture.root);
  assert.deepEqual(result.eligible, { rows: 120, prs: 120, classes: { retry: 40, fix: 40, "ask-owner": 40 } });
  assert.equal(result.cap_determined, 3); assert.equal(result.unknown, 2); assert.equal(result.sample_floors_met, true);
  assert.equal(result.tail_sufficient_both, 120); assert.equal(result.repositories.length, 35);
  assert.match(result.repositories_sha256, /^[a-f0-9]{64}$/);
  assert.equal(validateLock(lock).compatible, true); assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
  assert.throws(() => createLock(fixture.root, lock), /output must be new/);
});

test("the inspector refuses each broken contract field", () => {
  const cases = [
    [dir => fs.chmodSync(path.join(dir, "retry.jsonl"), 0o644), /private regular file/],
    [dir => fs.appendFileSync(path.join(dir, "unknown.jsonl"), "\n{}"), /hashes differ/],
    [dir => rewrite(dir, "retry.jsonl", r => r.map((x, i) => i ? x : { ...x, tail_rule: undefined })), /provenance/],
    [dir => rewrite(dir, "retry.jsonl", r => r.map((x, i) => i ? x : { ...x, tail_line_range: [5, 2] })), /provenance/],
    [dir => rewrite(dir, "retry.jsonl", r => r.map((x, i) => i ? x : { ...x, selection_stratum: "other" })), /provenance/],
    [dir => rewrite(dir, "retry.jsonl", r => r.map((x, i) => i ? x : { ...x, input: { ...x.input, phase: "verify" } })), /retry input/],
    [dir => rewrite(dir, "retry.jsonl", r => r.map((x, i) => i ? x : { ...x, input: { ...x.input, failure_tail: "x".repeat(16001) } })), /retry input/],
    [dir => rewrite(dir, "retry.jsonl", r => r.map((x, i) => i ? x : { ...x, input: { ...x.input, job: "build" } })), /input field/],
    [dir => rewrite(dir, "retry.jsonl", r => r.map((x, i) => i ? x : { ...x, label_source: "independent-human" })), /retry label/],
    [dir => rewrite(dir, "verification.jsonl", r => r.map((x, i) => i ? x : { ...x, verifier: "agent:a" })), /checked AI provenance/],
    [dir => rewrite(dir, "annotations.jsonl", r => r.map((x, i) => i ? x : { ...x, labeled_at: "2026-10-19T00:05:00.000Z" })), /inspection/],
    [dir => rewrite(dir, "annotations.jsonl", r => r.map((x, i) => i ? x : { ...x, per_action_reasons: { retry: "a", fix: "b" } })), /inspection/],
    [dir => rewrite(dir, "verification.jsonl", r => r.map((x, i) => i ? x : { ...x, tail_sufficient: "yes" })), /inspection/],
    [dir => rewrite(dir, "verification.jsonl", r => r.map((x, i) => i ? x : { ...x, label: "retry" === x.label ? "fix" : "retry" })), /inspection/],
    [dir => rewrite(dir, "unknown.jsonl", r => [...r, { id: fixture.rows[0].id, label: null, reason: "repeat" }]), /unknown/],
    [dir => rewrite(dir, "retry.jsonl", r => r.map((x, i) => i < 3 ? { ...x, repo: "owner0/repo0", pr: 100, source: "https://github.com/owner0/repo0/x" } : x)), /pull request|counts/],
    [dir => { const m = read(path.join(dir, "manifest.json")); m.counts.rows++; fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m), { mode: 0o600 }); }, /counts/],
    [dir => { const m = read(path.join(dir, "manifest.json")); m.sealed_at = "2099-01-01T00:00:00.000Z"; fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m), { mode: 0o600 }); }, /chronology/],
  ];
  for (const [i, [mutate, message]] of cases.entries()) {
    const dir = copy(); mutate(dir);
    assert.throws(() => inspectDataset(dir), message, `case ${i}`);
  }
});

test("an underpowered dataset is valid but cannot export requests and evaluates INCONCLUSIVE", () => {
  const small = retryFixture(path.join(root, "small"), { perClass: 19 }), smallLock = path.join(root, "small-lock.json");
  createLock(small.root, smallLock);
  const checked = validateLock(smallLock);
  assert.equal(checked.sample_floors_met, false); assert.deepEqual(checked.shortfall, { rows: 43, prs: 0, classes: { retry: 1, fix: 1, "ask-owner": 1 } });
  assert.throws(() => requestPlan(smallLock), /sample floor/);
  assert.equal(evaluate(smallLock, []).decision, "INCONCLUSIVE");
});

test("v4 retry numbers equal the v1 retry analysis on the same synthetic answers", () => {
  const plan = requestPlan(lock), eligible = validateLock(lock).rows;
  for (const pick of [r => r.label, () => "fix", r => (r.label === "retry" ? "fix" : r.label)]) {
    const result = evaluate(lock, answersFor(plan, eligible, pick));
    // Synthetic fixtures exercise v1 math only; no real annotation is relabeled.
    const reference = eligible.map(r => ({ ...r, label_source: "independent-human" }));
    const v1 = v1Analyze("retry", reference, reference.map(r => ({ id: r.id, protocol_hash: v1Hash(), sample_hash: sampleHash(r),
      answer: pick(r), confidence: 1, fallback: false })));
    assert.deepEqual(result.metrics, v1.metrics); assert.deepEqual(result.bootstrap, v1.bootstrap);
    assert.deepEqual(result.gates, v1.gates); assert.equal(result.decision, v1.decision);
  }
});

test("only a correct, confident, safe answer set reaches review-required ADOPT", () => {
  const plan = requestPlan(lock), eligible = validateLock(lock).rows;
  const perfect = evaluate(lock, answersFor(plan, eligible));
  assert.equal(perfect.decision, "ADOPT"); assert.equal(perfect.promotion, "review-required"); assert.equal(perfect.adoption_eligible, true);
  assert.equal(perfect.metrics.kappa, 1); assert.equal(perfect.cap_determined, 3); assert.equal(perfect.human_labels, false);
  assert.equal(evaluate(lock, answersFor(plan, eligible, () => "fix")).decision, "REJECT");
  assert.equal(evaluate(lock, answersFor(plan, eligible, r => r.label, 0.89)).decision, "REJECT");
  const oneUnsafe = evaluate(lock, answersFor(plan, eligible, r => (r.id === eligible.find(e => e.label === "ask-owner").id ? "retry" : r.label)));
  assert.equal(oneUnsafe.gates.safety, false); assert.equal(oneUnsafe.decision, "REJECT");
  assert.equal(evaluate(lock, answersFor(plan, eligible).map(a => ({ ...a, answer: "skip" }))).answered, 0);
  assert.equal(evaluate(lock, answersFor(plan, eligible).slice(7)).gates.availability, false);
  assert.throws(() => evaluate(lock, [...answersFor(plan, eligible), answersFor(plan, eligible)[0]]), /duplicate/);
});

// The fake follows the send order; it answers each locked row with its label.
function fakeJev(eligible, { failFirst = new Set() } = {}) {
  const calls = [], failures = new Map();
  let queue = eligible.map(r => r.id), next = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const row = eligible.find(r => r.id === queue[next]);
    if (failFirst.has(row.id) && (failures.get(row.id) ?? 0) < 3) {
      failures.set(row.id, (failures.get(row.id) ?? 0) + 1);
      if (failures.get(row.id) === 3) next++;
      return { ok: false, status: 503, headers: { get: () => "0" } };
    }
    next++;
    return { ok: true, status: 200, json: async () => ({ answers: { action: { choice: row.label, confidence: 0.95 } } }) };
  };
  return { fetch, calls, expect: ids => { queue = ids; next = 0; } };
}

test("send posts only the locked requests after consent to the exact repository set and a check of every repository", async () => {
  const checked = validateLock(lock), plan = requestPlan(lock), jev = fakeJev(checked.rows), out = path.join(root, "answers.jsonl"), seen = [];
  const opts = { consent: checked.repositories_sha256, key: "key-canary", fetch: jev.fetch, visibility: repo => { seen.push(repo); return "public"; } };
  const sent = await sendPlan(lock, out, opts);
  assert.deepEqual({ sent: sent.sent, failed: sent.failed, answered: sent.answered }, { sent: 120, failed: 0, answered: 120 });
  assert.equal(new Set(seen).size, 35); assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  for (const [i, call] of jev.calls.entries()) {
    assert.deepEqual(call.body, plan[i].request);
    for (const secret of ["rationale", "per_action_reasons", "annotator", "label_source", "tail_line_range", "selection_stratum"]) assert.ok(!call.init.body.includes(secret), secret);
  }
  assert.ok(!fs.readFileSync(out, "utf8").includes("key-canary"));
  assert.equal(evaluate(lock, rows(out)).decision, "ADOPT");
});

test("send refuses wrong consent, a missing key, one private repository, and existing output before any request", async () => {
  const checked = validateLock(lock), jev = fakeJev(checked.rows), out = path.join(root, "refused.jsonl");
  const base = { consent: checked.repositories_sha256, key: "k", fetch: jev.fetch, visibility: () => "public" };
  await assert.rejects(sendPlan(lock, out, { ...base, consent: "owner0/repo0" }), /repository set/);
  await assert.rejects(sendPlan(lock, out, { ...base, key: "" }), /TYPESAFE_API_KEY/);
  await assert.rejects(sendPlan(lock, out, { ...base, visibility: repo => (repo === "owner3/repo3" ? "private" : "public") }), /not public/);
  await assert.rejects(sendPlan(lock, out, { ...base, resume: true }), /nothing to resume/);
  fs.writeFileSync(out, "", { mode: 0o600 });
  await assert.rejects(sendPlan(lock, out, base), /output must be new/);
  assert.equal(jev.calls.length, 0);
});

test("a failed request stays unanswered and --resume sends only that request again", async () => {
  const checked = validateLock(lock), first = checked.rows[0].id, jev = fakeJev(checked.rows, { failFirst: new Set([first]) });
  const out = path.join(root, "resume.jsonl"), opts = { consent: checked.repositories_sha256, key: "k", fetch: jev.fetch, visibility: () => "public" };
  assert.equal((await sendPlan(lock, out, opts)).failed, 1); assert.equal(evaluate(lock, rows(out)).answered, 119);
  jev.expect([first]);
  const again = await sendPlan(lock, out, { ...opts, resume: true });
  assert.deepEqual({ sent: again.sent, answered: again.answered }, { sent: 1, answered: 120 });
  assert.equal(rows(out).length, 120);
});

test("the CLI send needs the key and the repository-set consent, and makes no request without them", () => {
  const cli = fileURLToPath(new URL("./run.mjs", import.meta.url));
  const guard = path.join(root, "no-network.mjs"); fs.writeFileSync(guard, 'globalThis.fetch=()=>{throw new Error("network forbidden")};');
  const run = (args, key = "") => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: key, NODE_OPTIONS: `--import=${guard}` } });
  const checked = JSON.parse(run(["check", "--lock", lock]).stdout);
  assert.equal(checked.requests, 120); assert.match(checked.repositories_sha256, /^[a-f0-9]{64}$/);
  const out = path.join(root, "cli-answers.jsonl");
  const noKey = run(["send", "--lock", lock, "--consent-send", checked.repositories_sha256, "--out", out]);
  assert.equal(noKey.status, 2); assert.match(noKey.stderr, /TYPESAFE_API_KEY/);
  const noConsent = run(["send", "--lock", lock, "--out", out], "secret-canary");
  assert.equal(noConsent.status, 2); assert.ok(!noConsent.stderr.includes("secret-canary")); assert.ok(!fs.existsSync(out));
  const dry = run(["dry-run", "--lock", lock, "--out", path.join(root, "requests.jsonl")]);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).network_requests, 0);
});
