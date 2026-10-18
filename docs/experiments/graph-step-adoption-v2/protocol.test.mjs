import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, after, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RULES, analyze as v1Analyze, sampleHash, protocolHash as v1Hash } from "../graph-step-adoption/protocol.mjs";
import { POLICY, protocolHash, sourceBindings, inspectDataset, createLock, validateLock, checkAnnotationPair, requestPlan } from "./protocol.mjs";
import { evaluate, sampleFloor } from "./analysis.mjs";
import { copyEvidenceTree } from "../graph-3e-datasets/labels.mjs";
import { publicFixture } from "./fixture.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-ai-protocol-"));
let corpus, lock;
before(async () => { corpus = await publicFixture(root); lock = path.join(root, "study-lock.json"); createLock(corpus, lock, { repo: "owner/repo" }); });
after(() => fs.rmSync(root, { recursive: true, force: true }));
const rows = file => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));

test("v2 keeps every v1 numeric rule and binds implementation bytes without claiming human evidence", () => {
  assert.equal(v1Hash(), "f3079d8d3fa6697de4bf0e1fe68f7001a9ab586c85b64532008814e9fbf0952a");
  assert.equal(POLICY.version, 2); assert.equal(POLICY.human_labels, false);
  assert.equal(POLICY.adoption_eligible, false); assert.deepEqual(read(lock).rules, RULES);
  assert.notEqual(protocolHash(), v1Hash());
  const bindings = sourceBindings(); assert.ok(bindings.length >= 12);
  assert.ok(bindings.every(r => /^[a-f0-9]{64}$/.test(r.sha256)));
  const paths = new Set(bindings.map(r => r.path)), repo = fileURLToPath(new URL("../../../", import.meta.url));
  for (const entry of bindings) for (const match of fs.readFileSync(path.join(repo, entry.path), "utf8").matchAll(/^import\s[\s\S]*?from\s*["'](\.[^"']+)["']/gm))
    assert.ok(paths.has(path.relative(repo, path.resolve(path.dirname(path.join(repo, entry.path)), match[1]))), match[1]);
});

test("the source-backed ledger passes at exactly 100 rows while unknowns remain distinct", () => {
  const result = inspectDataset(corpus);
  assert.equal(result.datasets.dispatch.rows, 100); assert.equal(result.datasets.dispatch.groups, 51);
  assert.equal(result.unknown, 2); assert.equal(result.sample_floors_met, true);
  assert.equal(result.human_labels, false); assert.equal(result.adoption_eligible, false);
  assert.deepEqual(result.cohorts, { "offline-locked-baseline": 50, "public-historical-review-head-baseline": 50 });
  assert.equal(validateLock(lock).compatible, true); assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
  assert.throws(() => createLock(corpus, lock, { repo: "owner/repo" }), /output must be new/);
  assert.throws(() => createLock(corpus, path.join(root, "wrong-consent.json"), { repo: "owner/other" }), /public repository consent/);
});

test("annotation checks reject false human claims, reused actors, future labels and incomplete candidate inspection", () => {
  const row = rows(path.join(corpus, "public-dispatch.jsonl"))[0];
  const a = rows(path.join(corpus, "annotations.jsonl")).find(a => a.id === row.id);
  const v = rows(path.join(corpus, "verification.jsonl")).find(a => a.id === row.id);
  const cutoff = new Date().toISOString(); checkAnnotationPair(row, a, v, cutoff);
  for (const changed of [{ ...v, verifier: a.annotator }, { ...v, verified_at: "2099-01-01T00:00:00Z" },
    { ...v, inspection_complete: false }, { ...v, per_candidate_reasons: {} }, { ...v, label: ["not-a-reviewer"] }])
    assert.throws(() => checkAnnotationPair(row, a, changed, cutoff));
  assert.throws(() => checkAnnotationPair({ ...row, label_source: "independent-human" }, a, v, cutoff));
});

test("a lock rejects policy, numeric rule, source binding and dataset changes", () => {
  const original = fs.readFileSync(lock, "utf8"), value = JSON.parse(original);
  for (const changed of [{ ...value, protocol_hash: v1Hash() }, { ...value, rules: { ...RULES, minimum_rows: 99 } },
    { ...value, policy: { ...POLICY, human_labels: true } }, { ...value, source_files: [] },
    { ...value, dataset: { ...value.dataset, ledger_sha256: "0".repeat(64) } }]) {
    const file = path.join(root, "changed-lock.json"); fs.writeFileSync(file, JSON.stringify(changed), { mode: 0o600 });
    assert.throws(() => validateLock(file));
  }
  const corpusCopy = path.join(root, "changed-corpus"); copyEvidenceTree(corpus, corpusCopy);
  fs.writeFileSync(path.join(corpusCopy, "annotations.jsonl"), "");
  assert.throws(() => inspectDataset(corpusCopy), /hashes differ/);
});

test("offline request plans contain only typed public state and stable binding hashes", () => {
  assert.throws(() => requestPlan(lock, "owner/other"), /public repository consent/);
  const plan = requestPlan(lock, "owner/repo"); assert.equal(plan.length, 100);
  const gold = rows(path.join(corpus, "public-dispatch.jsonl"));
  for (const [i, request] of plan.entries()) {
    assert.equal(request.id, gold[i].id); assert.deepEqual(JSON.parse(request.request.state), gold[i].input);
    assert.equal(request.protocol_hash, protocolHash()); assert.match(request.lock_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(request).sort(), ["id", "lock_sha256", "protocol_hash", "request", "sample_hash"].sort());
  }
});

test("the unchanged sample floor rejects each boundary shortfall", () => {
  assert.equal(sampleFloor(100, 30, [20, 80]), true);
  assert.equal(sampleFloor(99, 30, [20, 79]), false);
  assert.equal(sampleFloor(100, 29, [20, 80]), false);
  assert.equal(sampleFloor(100, 30, [19, 81]), false);
  assert.equal(sampleFloor(100, 30, []), false);
});

test("a structurally valid underpowered study cannot export requests", async () => {
  const smallRoot = path.join(root, "underpowered"); fs.mkdirSync(smallRoot, { mode: 0o700 });
  const smallCorpus = await publicFixture(smallRoot, 3), smallLock = path.join(smallRoot, "lock.json");
  createLock(smallCorpus, smallLock, { repo: "owner/repo" });
  const checked = validateLock(smallLock); assert.equal(checked.compatible, true); assert.equal(checked.sample_floors_met, false);
  assert.equal(checked.requests, 4); assert.throws(() => requestPlan(smallLock, "owner/repo"), /sample floor/);
});

test("perfect AI agreement passes unchanged numeric gates but never reports ADOPT or human accuracy", () => {
  const plan = requestPlan(lock, "owner/repo"), gold = rows(path.join(corpus, "public-dispatch.jsonl"));
  const answers = plan.map((p, i) => ({ id: p.id, protocol_hash: p.protocol_hash, lock_sha256: p.lock_sha256,
    sample_hash: p.sample_hash, answer: gold[i].label, confidence: 1, fallback: false }));
  const result = evaluate(lock, answers);
  assert.equal(result.decision, "AI_AGREEMENT_PASS"); assert.equal(result.adoption_eligible, false);
  assert.equal(result.answered, 100); assert.equal(result.bootstrap.samples, 2000);
  assert.equal(result.metrics.precision, 1); assert.equal(result.metrics.recall, 1);
  assert.equal(result.promotion, "shadow-only"); assert.equal(result.unknown, 2);
  // Synthetic fixtures exercise v1 math only; no real annotation is relabeled.
  const referenceRows = gold.map(r => ({ ...r, label_source: "independent-human" }));
  const reference = v1Analyze("dispatch", referenceRows, referenceRows.map(r => ({ id: r.id,
    protocol_hash: v1Hash(), sample_hash: sampleHash(r), answer: r.label, confidence: 1, fallback: false })));
  assert.deepEqual(result.metrics, reference.metrics); assert.deepEqual(result.bootstrap, reference.bootstrap);
  assert.deepEqual(result.gates, reference.gates);
  assert.equal(evaluate(lock, []).decision, "INCONCLUSIVE");
  assert.equal(evaluate(lock, answers.map(a => ({ ...a, answer: [], confidence: 1 }))).decision, "AI_AGREEMENT_FAIL");
  assert.equal(evaluate(lock, answers.map(a => ({ ...a, protocol_hash: v1Hash() }))).answered, 0);
  const invalid = answers.map((a, i) => ({ ...a, ...[
    { lock_sha256: "stale" }, { sample_hash: "stale" }, { fallback: true }, { confidence: 1.1 },
    { answer: ["architect-reviewer", "architect-reviewer"] }][i] }));
  assert.equal(evaluate(lock, invalid).answered, 95);
  assert.equal(evaluate(lock, answers.map(a => ({ ...a, confidence: 0.89 }))).decision, "AI_AGREEMENT_FAIL");
  assert.equal(evaluate(lock, answers.slice(1)).decision, "INCONCLUSIVE");
  assert.throws(() => evaluate(lock, [...answers, answers[0]]), /duplicate/);
  assert.throws(() => evaluate(lock, [{ ...answers[0], id: "not-in-locked-population" }]), /outside the locked sample/);
  assert.deepEqual(evaluate(lock, answers).bootstrap, result.bootstrap);
});

test("the CLI creates an offline request plan, never overwrites output, and rejects send", () => {
  const cli = fileURLToPath(new URL("./run.mjs", import.meta.url));
  const guard = path.join(root, "no-network.mjs"); fs.writeFileSync(guard, 'globalThis.fetch=()=>{throw new Error("network forbidden")};');
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "", NODE_OPTIONS: `--import=${guard}` } });
  const checked = run(["check", "--lock", lock]); assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).requests, 100);
  const out = path.join(root, "requests.jsonl"), args = ["dry-run", "--lock", lock, "--consent-public-repo", "owner/repo", "--out", out];
  const dry = run(args); assert.equal(dry.status, 0, dry.stderr); assert.equal(rows(out).length, 100);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600); assert.equal(run(args).status, 2);
  assert.equal(run([...args, "--send"]).status, 2);
  assert.equal(JSON.parse(run(["evaluate", "--lock", lock]).stdout).decision, "INCONCLUSIVE");
  const malformed = path.join(root, "malformed-answers.jsonl"); fs.writeFileSync(malformed, "private-canary-do-not-print");
  const rejected = run(["evaluate", "--lock", lock, "--answers", malformed]);
  assert.equal(rejected.status, 2); assert.ok(!rejected.stderr.includes("private-canary"));
});
