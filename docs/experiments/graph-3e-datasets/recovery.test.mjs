import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolEvents, rosterCalls, linkFailure, scan, reviewOpportunities, pinnedDispatch, sanitizeJSON, sealRecovery, validateRecovery } from "./recovery.mjs";
import { collect, stage, finalize, seal } from "./prepare.mjs";

const sha = "a".repeat(40);
const record = (type, content, extra = {}) => ({ type, timestamp: "2026-10-13T10:00:00Z",
  message: { role: type === "assistant" ? "assistant" : "user", content }, ...extra });
const call = { type: "tool_use", name: "Bash", id: "call-1", input: {
  command: "dotbabel local-attest --pr 1 > /tmp/attest-1.log 2>&1" } };
const result = { type: "tool_result", tool_use_id: "call-1", content: "1 hard leg(s) failed: lint.\nexit=1" };
const receipt = { repo: "owner/repo", pr: 1, head_sha: sha, phase: "local-attest", attempt: 1,
  receipt_n: 1, at: "2026-10-13T10:05:00Z" };

test("scrubs parsed string values without breaking escaped JSON syntax", () => {
  const input = { body: 'API_KEY="canary-secret"\nTail', nested: ['TOKEN="another-canary"'], count: 1 };
  const sanitized = sanitizeJSON(input);
  const parsed = JSON.parse(JSON.stringify(sanitized));
  assert.equal(parsed.count, 1);
  assert.ok(!parsed.body.includes("canary-secret"));
  assert.ok(!parsed.nested[0].includes("another-canary"));
  assert.ok(parsed.body.endsWith("\nTail"));
});

test("pairs actual Claude tool calls and outputs with line provenance", () => {
  const source = [record("assistant", [call]), record("user", [result], { uuid: "result-1" })]
    .map(JSON.stringify).join("\n");
  const [event] = toolEvents(source);
  assert.equal(event.tool_id, "call-1");
  assert.equal(event.call_line, 1);
  assert.equal(event.result_line, 2);
  assert.equal(event.output, result.content);
  assert.equal(event.command, call.input.command);
});

test("ignores request blobs, summaries, unpaired outputs and non-string tool content", () => {
  const source = [record("api-request-blob", [call]), record("user", [result]),
    record("assistant", "A later summary reports a failure."),
    record("assistant", [{ ...call, id: "images" }]),
    record("user", [{ ...result, tool_use_id: "images", content: [{ type: "image" }] }])]
    .map(JSON.stringify).join("\n");
  assert.deepEqual(toolEvents(source), []);
});

test("does not silently accept conflicting duplicate tool results", () => {
  const source = [record("assistant", [call]), record("user", [result]),
    record("user", [{ ...result, content: "Different failure" }])].map(JSON.stringify).join("\n");
  assert.throws(() => toolEvents(source), /conflicting tool result/);
  const conflicts = [];
  assert.deepEqual(toolEvents(source, conflicts), []);
  assert.deepEqual(conflicts, ["call-1"]);
});

test("scans explicit source roots privately, without overwriting or persisting secrets", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-recovery-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions"); fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "a".repeat(36) + ".jsonl"),
    [record("assistant", [call]), record("user", [{ ...result, content: result.content + "\nTOKEN=canary-value" }])]
      .map(JSON.stringify).join("\n"));
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ repositories: [{ repo: "owner/repo", session_roots: [sessions] }] }));
  const out = path.join(root, "out"), summary = scan(config, out);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.failure_outputs, 1);
  const events = fs.readFileSync(path.join(out, "tool-events.jsonl"), "utf8");
  assert.ok(!events.includes("canary-value"));
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(out, "tool-events.jsonl")).mode & 0o777, 0o600);
  assert.throws(() => scan(config, out), /output must be new/);
});

test("extracts literal roster requests but does not call them confirmed dispatches", () => {
  const command = `post-pr-review-post-receipt.sh 42 --sha ${sha} --posted 0 --skipped 0 --agents architect-reviewer,security-auditor --profile small --repo owner/repo`;
  const [row] = rosterCalls([{ command, output: "receipt posted", tool_id: "one" }], "owner/repo");
  assert.equal(row.pr, 42);
  assert.equal(row.head_sha, sha);
  assert.deepEqual(row.reviewers, ["architect-reviewer", "security-auditor"]);
  assert.equal(row.confirmed, false);
  assert.deepEqual(rosterCalls([{ command: command.replace(sha, "$HEAD") }], "owner/repo"), []);
});

test("links a retained original failure through an explicit execution and pinned receipt", () => {
  const invocation = { command: call.input.command, at: "2026-10-13T10:00:00Z" };
  const log = `Attesting PR #1 (owner/repo) at ${sha.slice(0, 8)}.\n1 hard leg(s) failed: lint.`;
  const linked = linkFailure(receipt, invocation, { path: "/tmp/attest-1.log", body: log });
  assert.equal(linked.input.failure_tail, log);
  assert.equal(linked.head_sha, sha);
  assert.equal(linked.label, null);
  assert.equal(linked.labeled_before_replay, false);
});

test("rejects wrong PR, wrong log, diagnostic runs, future commands, cap, and mismatched heads", () => {
  const invocation = { command: call.input.command, at: "2026-10-13T10:00:00Z" };
  const log = { path: "/tmp/attest-1.log", body: `Attesting PR #1 (owner/repo) at ${sha.slice(0, 8)}.\n1 hard leg(s) failed: lint.` };
  for (const [r, i, l] of [
    [{ ...receipt, pr: 2 }, invocation, log],
    [receipt, invocation, { ...log, path: "/tmp/different.log" }],
    [receipt, { ...invocation, command: invocation.command + " --only lint" }, log],
    [receipt, { ...invocation, at: "2026-10-13T11:00:00Z" }, log],
    [{ ...receipt, attempt: 3 }, invocation, log],
    [receipt, invocation, { ...log, body: log.body.replace(sha.slice(0, 8), "bbbbbbbb") }],
  ]) assert.throws(() => linkFailure(r, i, l));
});

test("scrubs the failure tail before persistence and rejects a success summary", () => {
  const invocation = { command: call.input.command, at: "2026-10-13T10:00:00Z" };
  const log = { path: "/tmp/attest-1.log", body: `Attesting PR #1 (owner/repo) at ${sha.slice(0, 8)}.\nAPI_KEY=canary-secret\n1 hard leg(s) failed: lint.` };
  assert.ok(!linkFailure(receipt, invocation, log).input.failure_tail.includes("canary-secret"));
  assert.throws(() => linkFailure(receipt, invocation, { ...log, body: "All checks pass" }));
});

test("keeps a separately recovered original header outside the model input", () => {
  const invocation = { command: call.input.command, at: "2026-10-13T10:00:00Z" };
  const log = { path: "/tmp/attest-1.log", body: "1 hard leg(s) failed: lint.",
    head_body: `Attesting PR #1 (owner/repo) at ${sha.slice(0, 8)}.` };
  assert.equal(linkFailure(receipt, invocation, log).input.failure_tail, log.body);
  assert.throws(() => linkFailure(receipt, invocation, { ...log, head_body: log.head_body.replace("#1", "#2") }));
});

test("expands all original review heads without final-head filtering or duplicate cases", () => {
  const body = "Agents: documentation-writer, security-auditor";
  const first = { id: 1, commit_id: sha, submitted_at: "2026-10-01T00:00:00Z", body };
  const second = { ...first, id: 2, commit_id: "b".repeat(40) };
  const all = { ...first, id: 3, commit_id: "c".repeat(40),
    body: "Agents: architect-reviewer, security-auditor, compliance-auditor, documentation-writer" };
  const prior = [{ repo: "owner/repo", pr: 1, head_sha: sha }];
  const rows = reviewOpportunities("owner/repo", 1, [first, first, second, all], prior);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].head_sha, second.commit_id);
  assert.equal(rows[0].review_anchor.id, 2);
  assert.equal(rows[0].label, null);
  assert.deepEqual(reviewOpportunities("owner/repo", 1, [{ ...first, body: "No findings." }], []), []);
});

test("pins a new dispatch input to the complete historical diff and observed roster", () => {
  const reviews = [{ id: 1, commit_id: sha, body: "Agents: documentation-writer, security-auditor" }];
  const [opportunity] = reviewOpportunities("owner/repo", 1, reviews, []);
  opportunity.reviews = reviews;
  const comparison = { total_commits: 1, commits: [{ sha }], merge_base_commit: { sha: "b".repeat(40) },
    files: [{ filename: "docs/note.md", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+hello" }] };
  const facts = { commit: "b".repeat(40), facts: { protected_paths: [] } };
  const pinned = pinnedDispatch(opportunity, { base: { sha: "c".repeat(40) } }, comparison, facts);
  assert.deepEqual(pinned.row.input.candidates, ["architect-reviewer", "compliance-auditor"]);
  assert.equal(pinned.row.input.changed_lines, 1);
  assert.equal(pinned.row.label, null);
  for (const bad of [{ ...comparison, total_commits: 2 }, { ...comparison, commits: [] },
    { ...comparison, files: [{ ...comparison.files[0], patch: null }] }])
    assert.throws(() => pinnedDispatch(opportunity, {}, bad, facts));
  assert.throws(() => pinnedDispatch(opportunity, {}, comparison, { ...facts, commit: sha }));
});

test("seals a private recovery bundle and rejects changed files or parent provenance", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-recovery-seal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "run"), parent = path.join(dir, "parent");
  fs.mkdirSync(root, { mode: 0o700 });
  const put = (base, name, value) => fs.writeFileSync(path.join(base, name), value, { mode: 0o600 });
  put(dir, "config.json", JSON.stringify({ sources: [], repositories: [] }));
  await collect(path.join(dir, "config.json"), parent); stage(parent);
  put(parent, "annotations.jsonl", ""); put(parent, "verification.jsonl", ""); finalize(parent); seal(parent);
  for (const name of ["retry-annotation-input.jsonl", "dispatch-annotation-input.jsonl"]) put(root, name, "");
  put(root, "scan.json", "{}");
  const sealed = sealRecovery(root, parent);
  assert.equal(sealed.structural_valid, true);
  assert.equal(sealed.sample_floors_met, false);
  assert.equal(sealed.replay_performed, false);
  assert.throws(() => sealRecovery(root, parent), /exist/);
  put(root, "scan.json", '{"changed":true}');
  assert.throws(() => validateRecovery(root, parent), /hash/);
  put(root, "scan.json", "{}"); put(parent, "manifest.json", '{"changed":true}');
  assert.throws(() => validateRecovery(root, parent), /parent/);
});
