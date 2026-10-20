import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RULES, protocolHash as v1Hash } from "../graph-step-adoption/protocol.mjs";
import * as v2 from "../graph-step-adoption-v2/protocol.mjs";
import { evaluate as v2Evaluate } from "../graph-step-adoption-v2/analysis.mjs";
import { publicFixture } from "../graph-step-adoption-v2/fixture.mjs";
import { POLICY, protocolHash, sourceBindings, createLock, validateLock, requestPlan } from "./protocol.mjs";
import { evaluate, disposition } from "./analysis.mjs";
import { sendPlan } from "./send.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-ai-adoption-v3-"));
let corpus, lock, v2Lock;
before(async () => {
  corpus = await publicFixture(root); lock = path.join(root, "study-lock.json"); v2Lock = path.join(root, "v2-lock.json");
  createLock(corpus, lock, { repo: "owner/repo" }); v2.createLock(corpus, v2Lock, { repo: "owner/repo" });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
const rows = file => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const gold = () => rows(path.join(corpus, "public-dispatch.jsonl"));
const perfect = (plan, labels) => plan.map((p, i) => ({ id: p.id, protocol_hash: p.protocol_hash, lock_sha256: p.lock_sha256,
  sample_hash: p.sample_hash, answer: labels[i].label, confidence: 1, fallback: false }));

test("v3 records owner approval, keeps every v1 rule, and binds v2 and v3 implementation bytes", () => {
  assert.equal(POLICY.version, 3); assert.equal(POLICY.human_labels, false);
  assert.equal(POLICY.label_source, "ai-annotation-verified"); assert.equal(POLICY.approval.date, "2026-10-19");
  assert.equal(POLICY.numeric_rules_changed, false); assert.deepEqual(read(lock).rules, RULES);
  assert.notEqual(protocolHash(), v2.protocolHash()); assert.notEqual(protocolHash(), v1Hash());
  const bindings = sourceBindings(), paths = new Set(bindings.map(r => r.path));
  for (const v2File of v2.sourceBindings()) assert.ok(paths.has(v2File.path), v2File.path);
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  for (const entry of bindings) for (const match of fs.readFileSync(path.join(repo, entry.path), "utf8").matchAll(/^import\s[\s\S]*?from\s*["'](\.[^"']+)["']/gm))
    assert.ok(paths.has(path.relative(repo, path.resolve(path.dirname(path.join(repo, entry.path)), match[1]))), match[1]);
});

test("a v3 lock is private, new, consented, and rejects v2 locks and changed policies", () => {
  assert.equal(validateLock(lock).compatible, true); assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
  assert.throws(() => createLock(corpus, lock, { repo: "owner/repo" }), /output must be new/);
  assert.throws(() => createLock(corpus, path.join(root, "wrong.json"), { repo: "owner/other" }), /public repository consent/);
  assert.throws(() => validateLock(v2Lock), /locked protocol/);
  const value = read(lock);
  for (const changed of [{ ...value, policy: { ...POLICY, human_labels: true } }, { ...value, rules: { ...RULES, dispatch_recall: 0.5 } },
    { ...value, v2_protocol_hash: "0".repeat(64) }, { ...value, source_files: [] }]) {
    const file = path.join(root, `changed-${Math.random()}.json`); fs.writeFileSync(file, JSON.stringify(changed), { mode: 0o600 });
    assert.throws(() => validateLock(file));
  }
});

test("v3 numbers equal v2 numbers on the same answers, and v3 alone can report ADOPT", () => {
  const plan = requestPlan(lock, "owner/repo"), labels = gold();
  const result = evaluate(lock, perfect(plan, labels));
  const reference = v2Evaluate(v2Lock, perfect(v2.requestPlan(v2Lock, "owner/repo"), labels));
  assert.deepEqual(result.metrics, reference.metrics); assert.deepEqual(result.bootstrap, reference.bootstrap);
  assert.deepEqual(result.gates, reference.gates); assert.equal(reference.adoption_eligible, false);
  assert.equal(result.decision, "ADOPT"); assert.equal(result.promotion, "review-required");
  assert.equal(result.adoption_eligible, true); assert.equal(result.human_labels, false); assert.equal(result.unknown, 2);
  assert.equal(evaluate(lock, []).decision, "INCONCLUSIVE"); assert.equal(evaluate(lock, []).adoption_eligible, false);
  assert.equal(evaluate(lock, perfect(plan, labels).map(a => ({ ...a, answer: [] }))).decision, "REJECT");
  assert.equal(evaluate(lock, perfect(plan, labels).map(a => ({ ...a, confidence: 0.89 }))).decision, "REJECT");
  assert.equal(evaluate(lock, perfect(plan, labels).map(a => ({ ...a, protocol_hash: v2.protocolHash() }))).answered, 0);
  assert.throws(() => evaluate(lock, [...perfect(plan, labels), perfect(plan, labels)[0]]), /duplicate/);
});

test("a fragile interval keeps an ADOPT decision shadow-only", () => {
  const gates = { precision: true, recall: true, improvement: true, availability: true };
  assert.deepEqual(disposition(gates, false), { decision: "ADOPT", promotion: "review-required", adoption_eligible: true });
  assert.deepEqual(disposition(gates, true), { decision: "ADOPT", promotion: "shadow-only", adoption_eligible: false });
  assert.match(POLICY.adoption, /only ADOPT with a stable bootstrap interval is review-required/);
  assert.deepEqual(disposition({ ...gates, recall: false }, false), { decision: "REJECT", promotion: "shadow-only", adoption_eligible: false });
});

// Identical fixture inputs carry different labels, so the fake follows the send order instead of the payload.
function fakeJev(labels, { failFirst = new Set() } = {}) {
  const calls = [], failures = new Map();
  let queue = labels.map(r => r.id), next = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body), input = JSON.parse(body.state);
    calls.push({ url, init, body });
    const row = labels.find(r => r.id === queue[next]);
    if (failFirst.has(row.id) && (failures.get(row.id) ?? 0) < 3) {
      failures.set(row.id, (failures.get(row.id) ?? 0) + 1);
      if (failures.get(row.id) === 3) next++;
      return { ok: false, status: 500, headers: { get: () => "0" } };
    }
    next++;
    const answers = Object.fromEntries(input.candidates.map((c, i) => [`reviewer_${i}`, { noul: row.label.includes(c) ? 0.99 : 0.01 }]));
    return { ok: true, status: 200, json: async () => ({ answers }) };
  };
  return { fetch, calls, expect: ids => { queue = ids; next = 0; } };
}

test("send posts only each locked request, after fresh consent and a public visibility check", async () => {
  const labels = gold(), plan = requestPlan(lock, "owner/repo"), jev = fakeJev(labels), out = path.join(root, "answers.jsonl");
  const key = "test-key-canary";
  const sent = await sendPlan(lock, out, { consent: "owner/repo", key, fetch: jev.fetch, visibility: () => "public" });
  assert.deepEqual({ sent: sent.sent, failed: sent.failed, answered: sent.answered }, { sent: 100, failed: 0, answered: 100 });
  assert.equal(jev.calls.length, 100); assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  for (const [i, call] of jev.calls.entries()) {
    assert.equal(call.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(call.init.headers.Authorization, `Bearer ${key}`);
    assert.deepEqual(call.body, plan[i].request);
    for (const secret of ["rationale", "per_candidate_reasons", "annotator", "verifier", "label_source", corpus]) assert.ok(!call.init.body.includes(secret), secret);
  }
  assert.ok(!fs.readFileSync(out, "utf8").includes(key));
  assert.equal(evaluate(lock, rows(out)).decision, "ADOPT");
});

test("send refuses missing consent, missing key, private repositories, and existing output before any request", async () => {
  const jev = fakeJev(gold()), base = { consent: "owner/repo", key: "k", fetch: jev.fetch, visibility: () => "public" };
  const out = path.join(root, "refused.jsonl");
  await assert.rejects(sendPlan(lock, out, { ...base, consent: undefined }), /fresh send consent/);
  await assert.rejects(sendPlan(lock, out, { ...base, consent: "owner/other" }), /fresh send consent/);
  await assert.rejects(sendPlan(lock, out, { ...base, key: "" }), /TYPESAFE_API_KEY/);
  await assert.rejects(sendPlan(lock, out, { ...base, visibility: () => "private" }), /not public/);
  await assert.rejects(sendPlan(lock, out, { ...base, resume: true }), /nothing to resume/);
  fs.writeFileSync(out, "", { mode: 0o600 });
  await assert.rejects(sendPlan(lock, out, base), /output must be new/);
  assert.equal(jev.calls.length, 0);
});

test("a failed request is recorded as unanswered and --resume sends only that request again", async () => {
  const labels = gold(), first = labels[0].id, jev = fakeJev(labels, { failFirst: new Set([first]) });
  const out = path.join(root, "resume.jsonl"), opts = { consent: "owner/repo", key: "k", fetch: jev.fetch, visibility: () => "public" };
  const once = await sendPlan(lock, out, opts);
  assert.equal(once.failed, 1); assert.equal(evaluate(lock, rows(out)).answered, 99);
  jev.expect([first]);
  const again = await sendPlan(lock, out, { ...opts, resume: true });
  assert.deepEqual({ sent: again.sent, failed: again.failed, answered: again.answered }, { sent: 1, failed: 0, answered: 100 });
  assert.equal(rows(out).length, 100); assert.equal(evaluate(lock, rows(out)).answered, 100);
});

test("send appends each answer as it arrives and --resume sends again every record that evaluate would reject", async () => {
  const labels = gold(), jev = fakeJev(labels), out = path.join(root, "journal.jsonl"), seen = [];
  const fetch = async (url, init) => { seen.push(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).length); return jev.fetch(url, init); };
  const opts = { consent: "owner/repo", key: "k", fetch, visibility: () => "public" };
  await sendPlan(lock, out, opts);
  assert.deepEqual(seen, Array.from({ length: 100 }, (_, i) => i));
  const records = rows(out); records[0] = { ...records[0], confidence: 1.2 }; records[1] = { ...records[1], sample_hash: "stale" };
  fs.writeFileSync(out, records.map(r => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  jev.expect([labels[0].id, labels[1].id]);
  const again = await sendPlan(lock, out, { ...opts, fetch: jev.fetch, resume: true });
  assert.deepEqual({ sent: again.sent, answered: again.answered }, { sent: 2, answered: 100 });
  assert.equal(rows(out).length, 100); assert.equal(evaluate(lock, rows(out)).answered, 100);
  assert.deepEqual(fs.readdirSync(root).filter(f => f.endsWith(".tmp")), []);
});

test("a lock with a malformed timestamp is rejected at the lock layer", () => {
  const file = path.join(root, "bad-time.json"); fs.writeFileSync(file, JSON.stringify({ ...read(lock), locked_at: "garbage" }), { mode: 0o600 });
  assert.throws(() => validateLock(file), /invalid lock timestamp/);
  assert.throws(() => createLock(corpus, path.join(root, "bad-at.json"), { repo: "owner/repo", at: "2026-10-19" }), /invalid lock timestamp/);
});

test("the CLI send needs the key and the send consent, and makes no request without them", () => {
  const cli = fileURLToPath(new URL("./run.mjs", import.meta.url));
  const guard = path.join(root, "no-network.mjs"); fs.writeFileSync(guard, 'globalThis.fetch=()=>{throw new Error("network forbidden")};');
  const run = (args, key = "") => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: key, NODE_OPTIONS: `--import=${guard}` } });
  assert.equal(JSON.parse(run(["check", "--lock", lock]).stdout).requests, 100);
  const out = path.join(root, "cli-answers.jsonl");
  const noKey = run(["send", "--lock", lock, "--consent-send", "owner/repo", "--out", out]);
  assert.equal(noKey.status, 2); assert.match(noKey.stderr, /TYPESAFE_API_KEY/);
  const noConsent = run(["send", "--lock", lock, "--out", out], "secret-canary");
  assert.equal(noConsent.status, 2); assert.ok(!noConsent.stderr.includes("secret-canary")); assert.ok(!fs.existsSync(out));
  const dry = run(["dry-run", "--lock", lock, "--consent-public-repo", "owner/repo", "--out", path.join(root, "requests.jsonl")]);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).network_requests, 0);
});
