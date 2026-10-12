// Run with: node --test docs/experiments/jev-finding-triage/lib.test.mjs
// node:test, not vitest: vitest only collects plugins/dotbabel/tests/.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DECISION_RULE,
  buildRequest,
  classifyReply,
  cohensKappa,
  decide,
  pairFindings,
  parseFinding,
  reliability,
  sendAll,
  simulateTriage,
  tailHunk,
} from "./lib.mjs";

const finding = (title = "Retry is unbounded", category = "bug", severity = "important") =>
  `**[${severity}] ${title}** · _architect-reviewer_ · ${category}\n\nThe loop never stops.\n\n<!-- post-pr-review:v1:0123456789abcdef -->`;

test("parseFinding reads the posted header and strips the marker", () => {
  const f = parseFinding(finding());
  assert.deepEqual(f, {
    finding_id: "0123456789abcdef",
    severity: "important",
    title: "Retry is unbounded",
    agent: "architect-reviewer",
    category: "bug",
    body: "The loop never stops.",
  });
});

test("parseFinding rejects a comment without the marker", () => {
  assert.equal(parseFinding("**[important] x** · _a_ · bug\n\nbody"), null);
  assert.equal(parseFinding(undefined), null);
});

test("parseFinding reads the older renderings and reports absent fields as unknown", () => {
  const m = "\n\n<!-- post-pr-review:v1:0123456789abcdef -->";
  const a = parseFinding(`**suggestion** · \`design\` · _architect-reviewer_ (confidence 88)\n\n### Order is duplicated in six lists\n\nBody text.${m}`);
  assert.deepEqual([a.severity, a.category, a.agent, a.title, a.body], ["suggestion", "design", "architect-reviewer", "Order is duplicated in six lists", "Body text."]);
  const b = parseFinding(`**[🟠 important] Filenames lack a terminator**\n\nSame class.\n\n<sub>security-auditor · category: \`security\` · confidence: 84</sub>${m}`);
  assert.deepEqual([b.severity, b.category, b.agent, b.title, b.body], ["important", "security", "security-auditor", "Filenames lack a terminator", "Same class."]);
  const c = parseFinding(`**Clarify which gate requires project-sync**\n\n_via \`compliance-auditor\` (comment)_\n\nThe guide says x.${m}`);
  assert.deepEqual([c.severity, c.category, c.agent, c.title, c.body], ["unknown", "comment", "compliance-auditor", "Clarify which gate requires project-sync", "The guide says x."]);
  const d = parseFinding(`plain text${m}`);
  assert.deepEqual([d.severity, d.category, d.agent], ["unknown", "unknown", "unknown"]);
});

test("parseFinding scrubs every agent name from the title", () => {
  const f = parseFinding("**[important] Both architect-reviewer + compliance-auditor flag the order** · design\n\nx\n\n<!-- post-pr-review:v1:0123456789abcdef -->");
  assert.doesNotMatch(f.title, /reviewer|auditor/);
  const g = parseFinding("**[important] `high_confidence` is dropped** · security-auditor (confidence 92) · security\n\nx\n\n<!-- post-pr-review:v1:0123456789abcdef -->");
  assert.equal(g.title, "high_confidence is dropped");
});

test("classifyReply maps the reply openings seen in this repository", () => {
  const cases = [
    ["Fixed in abc123 — bounded the loop.", "valid", "fixed"],
    ["**Declining** this one.", "false_positive", "declined"],
    ["False positive. The guard already exists.", "false_positive", "false-positive"],
    ["Not an issue with the gh this repository uses.", "false_positive", "not-an-issue"],
    ["Note: all four negative tests already exist — see :135.", "false_positive", "already-exists"],
    ["Intentional design choice.", "false_positive", "intentional"],
    ["Deferred, deliberately.", "valid", "deferred"],
    ["The point is valid, and I am deferring it.", "valid", "point-valid"],
    ["Partly fixed in 7077b5f, partly deferred.", "unknown", "partial"],
    ["Partially adopted.", "unknown", "partial"],
    ["Acknowledged — keeping it.", "unknown", "unmatched"],
    ["Acknowledged, deferring as the comment notes.", "valid", "deferred"],
    ["Applied in 7649ec8.", "valid", "applied"],
    ["Deliberate design choice — the header documents why.", "false_positive", "intentional"],
    ["Kept byte-identity on purpose. The stored copy is what P4 reads.", "false_positive", "kept-as-is"],
    ["Verified handled — not a gap.", "false_positive", "not-a-gap"],
    ["Not changed in this PR; recorded instead.", "unknown", "unmatched"],
    ["", "unknown", "no-reply"],
  ];
  for (const [body, verdict, rule] of cases) {
    assert.deepEqual(classifyReply(body), { verdict, rule }, body);
  }
  assert.deepEqual(classifyReply(undefined), { verdict: "unknown", rule: "no-reply" });
});

test("tailHunk keeps the last lines, where the commented line is", () => {
  assert.equal(tailHunk("a\nb\nc\nd", 2), "c\nd");
  assert.equal(tailHunk("a\nb", 5), "a\nb");
  assert.equal(tailHunk(null, 5), "");
});

test("pairFindings pairs each finding with the earliest reply in its thread", () => {
  const rows = [
    { id: 1, pr: 7, path: "a.mjs", in_reply_to_id: null, body: finding("A", "style"), diff_hunk: "@@\n+x", created_at: "2026-01-01T00:00:00Z" },
    { id: 2, pr: 7, path: "a.mjs", in_reply_to_id: 1, body: "False positive.", created_at: "2026-01-01T00:02:00Z" },
    { id: 3, pr: 7, path: "a.mjs", in_reply_to_id: 1, body: "Fixed in abc.", created_at: "2026-01-01T00:01:00Z" },
    { id: 4, pr: 6, path: "b.mjs", in_reply_to_id: null, body: finding("B"), diff_hunk: "@@\n+y", created_at: "2026-01-01T00:00:00Z" },
    { id: 5, pr: 6, path: "b.mjs", in_reply_to_id: null, body: "a human comment", diff_hunk: "", created_at: "2026-01-01T00:00:00Z" },
  ];
  const out = pairFindings(rows, { repo: "o/r" });
  assert.equal(out.length, 2);
  assert.equal(out[0].repo, "o/r");
  assert.deepEqual(
    out.map((f) => [f.pr, f.comment_id, f.verdict, f.verdict_rule, f.mechanical]),
    [
      [6, 4, "unknown", "no-reply", false],
      [7, 1, "valid", "fixed", true],
    ],
  );
});

test("buildRequest never leaks the posted severity, category, or agent into the state", () => {
  const req = buildRequest({ path: "a.mjs", title: "T", body: "B", hunk: "@@\n+x", severity: "critical", category: "security", agent: "security-auditor" });
  assert.equal(req.model, "jev-latest");
  assert.doesNotMatch(req.state, /critical|security-auditor/);
  assert.equal(req.questions.real_defect.type, "noul");
  assert.equal(req.questions.category.type, "choice");
  assert.equal(Object.keys(req.questions.category.criteria).length, 9);
  assert.equal(req.questions.severity.type, "score");
  assert.equal(req.questions.severity.criteria.length, 3);
});

test("sendAll records answers and errors without a network", async () => {
  const f = { comment_id: 1, finding_id: "x", verdict: "valid", severity: "important", category: "bug", mechanical: false, path: "a", title: "t", body: "b", hunk: "h" };
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ model: "jev-1.13.0", answers: { real_defect: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 10 } }) };
  };
  const [good] = await sendAll([f], { fetchImpl: ok, apiKey: "k" });
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].auth, "Bearer k");
  assert.equal(good.answers.real_defect.noul, 0.8);
  const [bad] = await sendAll([f], { fetchImpl: async () => ({ ok: false, status: 429 }), apiKey: "k" });
  assert.equal(bad.error, "HTTP 429");
  const [thrown] = await sendAll([f], { fetchImpl: async () => { throw new Error("offline"); }, apiKey: "k" });
  assert.equal(thrown.error, "offline");
});

test("cohensKappa is 1 for perfect agreement, 0 for chance, null when undefined", () => {
  assert.equal(cohensKappa([true, false, true, false], [true, false, true, false]), 1);
  assert.equal(cohensKappa([true, true, false, false], [true, false, true, false]), 0);
  assert.equal(cohensKappa([true, true], [true, true]), null);
  assert.equal(cohensKappa([], []), null);
});

test("reliability bins p and reports Brier and ECE", () => {
  const r = reliability([
    { p: 0.95, valid: true },
    { p: 0.95, valid: true },
    { p: 0.05, valid: false },
    { p: 1, valid: true },
  ]);
  assert.equal(r.table[9].n, 3);
  assert.equal(r.table[0].n, 1);
  assert.ok(r.brier < 0.01);
  assert.ok(r.ece < 0.05);
});

test("simulateTriage never auto-decides a critical or unstated-severity finding, and counts wrong calls", () => {
  const rows = [
    { p: 0.95, valid: true, severity: "important" },
    { p: 0.95, valid: false, severity: "suggestion" },
    { p: 0.05, valid: false, severity: "important" },
    { p: 0.5, valid: true, severity: "important" },
    { p: 0.99, valid: true, severity: "critical" },
    { p: 0.01, valid: true, severity: "unknown" },
  ];
  const t = simulateTriage(rows, { hi: 0.9, lo: 0.1 });
  assert.equal(t.autoValid, 2);
  assert.equal(t.autoFalsePositive, 1);
  assert.equal(t.fullValidation, 3);
  assert.equal(t.wrong, 1);
  assert.equal(t.droppedDefects, 0);
  assert.equal(t.criticalHeld, 2);
  const dropped = simulateTriage([{ p: 0.05, valid: true, severity: "important" }], { hi: 0.9, lo: 0.1 });
  assert.equal(dropped.droppedDefects, 1);
});

test("decide is INCONCLUSIVE below the sample floor, else ADOPT or REJECT", () => {
  const goodTriage = { wrongRate: 0.01, droppedDefectRate: 0, savedRate: 0.5 };
  assert.equal(decide({ primary: 400, falsePositive: 12, kappa: 0.9, triage: goodTriage }).decision, "INCONCLUSIVE");
  assert.equal(decide({ primary: 400, falsePositive: 40, kappa: 0.7, triage: goodTriage }).decision, "ADOPT");
  const rejected = decide({
    primary: 400,
    falsePositive: 40,
    kappa: 0.5,
    triage: { wrongRate: 0.05, droppedDefectRate: 0.01, savedRate: 0.1 },
  });
  assert.equal(rejected.decision, "REJECT");
  assert.equal(rejected.reasons.length, 4);
  assert.equal(DECISION_RULE.minKappa, 0.6);
});
