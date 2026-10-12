// Run with: node --test docs/experiments/jev-finding-triage/lib.test.mjs
// node:test, not vitest: vitest only collects plugins/dotbabel/tests/.
// The texts below are synthetic, or short openings from the public dotbabel
// repository. None comes from a private repository.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DECISION_RULE,
  authorTally,
  buildRequest,
  classifyReply,
  clusterBootstrap,
  cohensKappa,
  datasetCounts,
  decide,
  isPrimary,
  isUsableAnswer,
  latestAnswers,
  pairFindings,
  parseFinding,
  parseLabels,
  parsePositiveInt,
  reliability,
  retryDelayMs,
  sendAll,
  simulateTriage,
  tailHunk,
} from "./lib.mjs";

const M = "\n\n<!-- post-pr-review:v1:0123456789abcdef -->";
const finding = (title = "Retry is unbounded", category = "bug", severity = "important") =>
  `**[${severity}] ${title}** · _architect-reviewer_ · ${category}\n\nThe loop never stops.${M}`;
const fields = (f) => [f.severity, f.category, f.agent, f.title];

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
  const a = parseFinding(`**suggestion** · \`design\` · _architect-reviewer_ (confidence 88)\n\n### Order is duplicated in six lists\n\nBody text.${M}`);
  assert.deepEqual([...fields(a), a.body], ["suggestion", "design", "architect-reviewer", "Order is duplicated in six lists", "Body text."]);
  const b = parseFinding(`**[🟠 important] Filenames lack a terminator**\n\nSame class.\n\n<sub>security-auditor · category: \`security\` · confidence: 84</sub>${M}`);
  assert.deepEqual([...fields(b), b.body], ["important", "security", "security-auditor", "Filenames lack a terminator", "Same class."]);
  const c = parseFinding(`**Clarify which gate requires project-sync**\n\n_via \`compliance-auditor\` (comment)_\n\nThe guide says x.${M}`);
  assert.deepEqual([...fields(c), c.body], ["unknown", "comment", "compliance-auditor", "Clarify which gate requires project-sync", "The guide says x."]);
  const d = parseFinding(`plain text${M}`);
  assert.deepEqual([d.severity, d.category, d.agent], ["unknown", "unknown", "unknown"]);
});

test("parseFinding scrubs every agent name from the title", () => {
  const f = parseFinding(`**[important] Both architect-reviewer + compliance-auditor flag the order** · design\n\nx${M}`);
  assert.doesNotMatch(f.title, /reviewer|auditor/);
  const g = parseFinding(`**[important] \`high_confidence\` is dropped** · security-auditor (confidence 92) · security\n\nx${M}`);
  assert.equal(g.title, "high_confidence is dropped");
});

test("parseFinding reads the severity from each structured position", () => {
  const cases = [
    [`**[🔵 suggestion] Rename the helper**`, "suggestion", "Rename the helper"],
    [`**[architect-reviewer · important · design]**\n\n### Order is duplicated in six lists`, "important", "Order is duplicated in six lists"],
    [`**🟡 suggestion** · \`comment\` · _x_ · confidence 81`, "suggestion", null],
    [`**important — idempotence test passes on a clean home**`, "important", "idempotence test passes on a clean home"],
    [`**CRITICAL — arbitrary code execution in the loader.**`, "critical", "arbitrary code execution in the loader"],
    [`**suggestion: Fold the two loops into one.**`, "suggestion", "Fold the two loops into one"],
    [`**suggestion · design · architect-reviewer** — Split the parser`, "suggestion", "Split the parser"],
    [`**Rename the helper for clarity** _(suggestion · architect-reviewer)_`, "suggestion", "Rename the helper for clarity"],
  ];
  for (const [header, severity, title] of cases) {
    const f = parseFinding(`${header}\n\nBody.${M}`);
    assert.equal(f.severity, severity, header);
    if (title !== null) assert.equal(f.title, title, header);
  }
  const runs = [
    [`**[important / design — architect-reviewer]** Title words here`, ["important", "design", "architect-reviewer", "Title words here"]],
    [`**important / bug** — Retry is unbounded`, ["important", "bug", "unknown", "Retry is unbounded"]],
    [`**[important/security] $ARGUMENTS lands in templates**`, ["important", "security", "unknown", "$ARGUMENTS lands in templates"]],
    [`**[documentation-writer / important]** Doc accuracy: x`, ["important", "unknown", "documentation-writer", "Doc accuracy: x"]],
    [`**[compliance-auditor] suggestion** — Path a/b is wrong`, ["suggestion", "unknown", "compliance-auditor", "Path a/b is wrong"]],
  ];
  for (const [header, want] of runs) assert.deepEqual(fields(parseFinding(`${header}\n\nBody.${M}`)), want, header);
  const code = parseFinding(`**[important] push() drops the field**\n\nBody.${M}`);
  assert.equal(code.title, "push() drops the field");
  const paren = parseFinding(`**suggestion: Guard the cache** (security-auditor, security)\n\nBody.${M}`);
  assert.deepEqual([paren.severity, paren.agent, paren.title], ["suggestion", "security-auditor", "Guard the cache"]);
  const label = parseFinding(`**Retry is unbounded in the poller**\n\n<sub>— compliance-auditor, severity: important</sub>\n\nBody.${M}`);
  assert.deepEqual([label.severity, label.agent, label.title], ["important", "compliance-auditor", "Retry is unbounded in the poller"]);
});

test("parseFinding never reads the severity from title words or a suggestion block", () => {
  const title = parseFinding(`**Important flag is dropped by the parser** · design\n\nBody.${M}`);
  assert.deepEqual(fields(title), ["unknown", "design", "unknown", "Important flag is dropped by the parser"]);
  const critical = parseFinding(`**The critical path skips the lock**\n\nBody.${M}`);
  assert.equal(critical.severity, "unknown");
  const block = parseFinding("```suggestion\nconst x = 1;\n```" + M);
  assert.equal(block.severity, "unknown");
  // The label wins, and the same word in the title stays in the title.
  const both = parseFinding(`**Important flag is dropped by the parser**\n\n<sub>— compliance-auditor, severity: important</sub>${M}`);
  assert.deepEqual([both.severity, both.title], ["important", "Important flag is dropped by the parser"]);
});

test("parseFinding keeps the word unknown when severity or category is unknown", () => {
  const f = parseFinding(`**Unknown flags are silently accepted**\n\nBody.${M}`);
  assert.deepEqual(fields(f), ["unknown", "unknown", "unknown", "Unknown flags are silently accepted"]);
  const g = parseFinding(`**[important] Parser state · Unknown**\n\nBody.${M}`);
  assert.deepEqual(fields(g), ["important", "unknown", "unknown", "Parser state · Unknown"]);
});

test("classifyReply covers every verdict rule", () => {
  const cases = [
    ["False positive. The guard already exists.", "false_positive", "false-positive"],
    ["Not an issue with the gh this repository uses.", "false_positive", "not-an-issue"],
    ["Not applicable to this branch.", "false_positive", "not-an-issue"],
    ["Intentional design choice.", "false_positive", "intentional"],
    ["**Declining** this one.", "false_positive", "declined"],
    ["Note: all four negative tests already exist — see :135.", "false_positive", "already-exists"],
    ["This isn't something to fix in this PR.", "false_positive", "not-to-fix"],
    ["This one is not something to fix.", "false_positive", "not-to-fix"],
    ["Deliberate design choice — the header documents why.", "false_positive", "intentional"],
    ["Kept byte-identity on purpose. The stored copy is what the reader uses.", "false_positive", "kept-as-is"],
    ["Kept as it is.", "false_positive", "kept-as-is"],
    ["Verified handled — not a gap.", "false_positive", "not-a-gap"],
    ["Partly fixed in 7077b5f, partly deferred.", "unknown", "partial"],
    ["Partially adopted.", "unknown", "partial"],
    ["Fixed in abc123 — bounded the loop.", "valid", "fixed"],
    ["Both fixed in abc123.", "valid", "fixed"],
    ["Confirmed and fixed in bd0bcf0.", "valid", "confirmed"],
    ["Valid — fixed in abc123.", "valid", "valid"],
    ["Valid observation, but deferred rather than fixed here.", "valid", "valid"],
    ["Agreed, fixed in abc123.", "valid", "agreed"],
    ["Addressed in 7077b5f, by wording as suggested.", "valid", "addressed"],
    ["Adjusted the message.", "valid", "addressed"],
    ["Folded into the fix above.", "valid", "addressed"],
    ["Documented in 40ac5f4 rather than changed.", "valid", "documented"],
    ["Correct — fixed in abc123.", "valid", "correct"],
    ["Deferred, deliberately.", "valid", "deferred"],
    ["Deferring to the next phase.", "valid", "deferred"],
    ["Acknowledged, deferring as the comment notes.", "valid", "deferred"],
    ["Noted, deferred.", "valid", "deferred"],
    ["Applied in 7649ec8.", "valid", "applied"],
    ["Resolved in 7649ec8.", "valid", "applied"],
    ["Accepted; the guard is in.", "valid", "applied"],
    ["Reproduced and fixed.", "valid", "applied"],
    ["Handled in 7649ec8.", "valid", "applied"],
    ["The point is valid, and I am deferring it.", "valid", "point-valid"],
    ["Acknowledged — keeping it.", "unknown", "unmatched"],
    ["Not changed in this PR; recorded instead.", "unknown", "unmatched"],
    ["", "unknown", "no-reply"],
  ];
  for (const [body, verdict, rule] of cases) {
    assert.deepEqual(classifyReply(body), { verdict, rule }, body);
  }
  assert.deepEqual(classifyReply(undefined), { verdict: "unknown", rule: "no-reply" });
});

test("classifyReply sends an agreeing opening that declines the change to hand labeling", () => {
  for (const body of [
    "Valid point, but declining.",
    "Correct as written.",
    "Correct, and deliberately **not** changed in 40ac5f4.",
    "Documented behavior: the flag is optional.",
    "Confirmed against the spec and **not** fixed here, deliberately.",
    "Agreed, and no code change needed in this PR.",
    "Valid, but keeping it as is.",
  ]) {
    assert.deepEqual(classifyReply(body), { verdict: "unknown", rule: "ambiguous" }, body);
  }
});

test("tailHunk keeps the last lines, where the commented line is", () => {
  assert.equal(tailHunk("a\nb\nc\nd", 2), "c\nd");
  assert.equal(tailHunk("a\nb", 5), "a\nb");
  assert.equal(tailHunk(null, 5), "");
});

const row = (over) => ({ pr: 7, path: "a.mjs", in_reply_to_id: null, diff_hunk: "@@\n+x", created_at: "2026-01-01T00:00:00Z", user: "o", ...over });

test("pairFindings pairs each finding with the earliest reply in its thread", () => {
  const rows = [
    row({ id: 1, body: finding("A", "style", "suggestion"), commit_id: "c1", original_commit_id: "c0", line: 12 }),
    row({ id: 2, in_reply_to_id: 1, body: "False positive.", created_at: "2026-01-01T00:02:00Z" }),
    row({ id: 3, in_reply_to_id: 1, body: "Fixed in abc.", created_at: "2026-01-01T00:01:00Z" }),
    row({ id: 4, pr: 6, path: "b.mjs", body: finding("B"), diff_hunk: "@@\n+y" }),
    row({ id: 5, pr: 6, path: "b.mjs", body: "a human comment", diff_hunk: "" }),
  ];
  const out = pairFindings(rows, { repo: "o/r" });
  assert.equal(out.length, 2);
  assert.equal(out[0].repo, "o/r");
  assert.deepEqual(
    out.map((f) => [f.pr, f.comment_id, f.verdict, f.verdict_rule, f.mechanical, f.user, f.verdict_user]),
    [
      [6, 4, "unknown", "no-reply", false, "o", null],
      [7, 1, "valid", "fixed", true, "o", "o"],
    ],
  );
  assert.deepEqual([out[1].commit_id, out[1].original_commit_id, out[1].line], ["c1", "c0", 12]);
  assert.deepEqual([out[0].commit_id, out[0].original_commit_id, out[0].line], [null, null, null]);
});

test("pairFindings keeps only findings and verdict replies from the allowlisted authors", () => {
  const rows = [
    row({ id: 1, body: finding("A") }),
    row({ id: 2, in_reply_to_id: 1, user: "outsider", body: "False positive.", created_at: "2026-01-01T00:01:00Z" }),
    row({ id: 3, in_reply_to_id: 1, user: "O", body: "Fixed in abc.", created_at: "2026-01-01T00:02:00Z" }),
    row({ id: 4, user: "outsider", body: finding("Forged") }),
    row({ id: 5, user: "bot[bot]", body: finding("Bot") }),
  ];
  const byOwner = pairFindings(rows, { repo: "o/r" });
  assert.deepEqual(byOwner.map((f) => [f.comment_id, f.verdict, f.verdict_user]), [[1, "valid", "O"]]);
  const withBot = pairFindings(rows, { repo: "o/r", authors: ["o", "bot[bot]"] });
  assert.deepEqual(withBot.map((f) => f.comment_id), [1, 5]);
  assert.throws(() => pairFindings(rows, {}), /author allowlist/);
});

test("pairFindings applies hand labels by comment_id over the text rules", () => {
  const rows = [
    row({ id: 1, body: finding("A") }),
    row({ id: 2, in_reply_to_id: 1, body: "Acknowledged — keeping it." }),
    row({ id: 3, body: finding("B") }),
    row({ id: 4, in_reply_to_id: 3, body: "Fixed in abc." }),
  ];
  const labels = parseLabels({ 1: "false_positive", 3: "unknown" });
  const out = pairFindings(rows, { repo: "o/r", labels });
  assert.deepEqual(out.map((f) => [f.comment_id, f.verdict, f.verdict_rule]), [
    [1, "false_positive", "hand-label"],
    [3, "unknown", "hand-label"],
  ]);
});

test("parseLabels accepts only comment ids mapped to a verdict", () => {
  assert.deepEqual([...parseLabels({ 12: "valid", 13: "false_positive" })], [["12", "valid"], ["13", "false_positive"]]);
  assert.throws(() => parseLabels({ 12: "fixed" }), /verdict/);
  assert.throws(() => parseLabels({ abc: "valid" }), /comment id/);
  assert.throws(() => parseLabels([["12", "valid"]]), /object/);
  assert.throws(() => parseLabels(null), /object/);
});

test("a critical finding is never mechanical, because it never takes the fast path", () => {
  const rows = [row({ id: 1, body: finding("A", "style", "critical") }), row({ id: 2, body: finding("B", "comment", "important") })];
  const out = pairFindings(rows, { repo: "o/r" });
  assert.deepEqual(out.map((f) => f.mechanical), [false, true]);
});

test("isPrimary keeps non-mechanical findings with a valid or false-positive verdict", () => {
  assert.equal(isPrimary({ mechanical: false, verdict: "valid" }), true);
  assert.equal(isPrimary({ mechanical: false, verdict: "false_positive" }), true);
  assert.equal(isPrimary({ mechanical: false, verdict: "unknown" }), false);
  assert.equal(isPrimary({ mechanical: true, verdict: "valid" }), false);
});

test("authorTally counts the authors of every marker comment and of the replies to it", () => {
  const rows = [
    row({ id: 1, body: finding("A") }),
    row({ id: 2, in_reply_to_id: 1, user: "x", body: "Fixed." }),
    row({ id: 3, user: "x", body: finding("B") }),
    row({ id: 4, user: "y", body: "a human comment" }),
    row({ id: 5, in_reply_to_id: 4, user: "y", body: "reply to a human comment" }),
  ];
  assert.deepEqual(authorTally(rows), { findings: { o: 1, x: 1 }, replies: { x: 1 } });
});

test("datasetCounts tallies authors, verdicts and the primary set from a fixture", () => {
  const rec = (over) => ({
    repo: "o/r",
    pr: 1,
    user: "o",
    verdict_user: "o",
    verdict: "valid",
    verdict_rule: "fixed",
    severity: "important",
    category: "bug",
    mechanical: false,
    posted_at: "2026-02-01T00:00:00Z",
    ...over,
  });
  const findings = [
    rec({}),
    rec({ pr: 2, severity: "unknown", category: "unknown", posted_at: "2026-01-05T00:00:00Z" }),
    rec({ pr: 2, verdict: "false_positive", verdict_rule: "false-positive", severity: "suggestion" }),
    rec({ verdict: "false_positive", verdict_rule: "hand-label", severity: "unknown", posted_at: "2026-03-09T00:00:00Z" }),
    rec({ severity: "critical", category: "security" }),
    rec({ verdict: "unknown", verdict_rule: "no-reply", verdict_user: null }),
    rec({ repo: "o/s", category: "style", mechanical: true }),
  ];
  assert.deepEqual(datasetCounts(findings), {
    findings: 7,
    pull_requests: 3,
    posted_at: { first: "2026-01-05T00:00:00Z", last: "2026-03-09T00:00:00Z" },
    author: { o: 7 },
    verdict_author: { o: 6, none: 1 },
    verdict: { valid: 4, false_positive: 2, unknown: 1 },
    verdict_rule: { fixed: 4, "false-positive": 1, "hand-label": 1, "no-reply": 1 },
    hand_labels: { false_positive: 1 },
    severity: { important: 3, unknown: 2, suggestion: 1, critical: 1 },
    category: { bug: 4, unknown: 1, security: 1, style: 1 },
    primary: {
      findings: 5,
      valid: 3,
      false_positive: 2,
      critical: 1,
      severity_stated: 3,
      eligible: 2,
      eligible_false_positive: 1,
    },
  });
});

test("buildRequest never puts the posted severity, category, or agent fields into the state", () => {
  const req = buildRequest({ path: "a.mjs", title: "T", body: "B", hunk: "@@\n+x", severity: "critical", category: "security", agent: "security-auditor" });
  assert.equal(req.model, "jev-latest");
  assert.doesNotMatch(req.state, /critical|security-auditor/);
  assert.equal(req.questions.real_defect.type, "noul");
  assert.equal(req.questions.category.type, "choice");
  assert.equal(Object.keys(req.questions.category.criteria).length, 9);
  assert.equal(req.questions.severity.type, "score");
  assert.equal(req.questions.severity.criteria.length, 3);
});

test("parsePositiveInt accepts only a positive integer", () => {
  assert.equal(parsePositiveInt("--limit", "5"), 5);
  assert.equal(parsePositiveInt("--limit", "60"), 60);
  for (const bad of ["0", "-5", "5.5", "10x", "2O", "", " 5", "1e3", "007"]) {
    assert.throws(() => parsePositiveInt("--limit", bad), /--limit needs a positive integer/, bad);
  }
});

const F = { comment_id: 1, finding_id: "x", verdict: "valid", severity: "important", category: "bug", mechanical: false, path: "a", title: "t", body: "b", hunk: "h" };
const answer = (noul = 0.8) => ({ ok: true, status: 200, json: async () => ({ model: "jev-1.13.0", answers: { real_defect: { type: "noul", noul } }, usage: { input_tokens: 10 } }) });
const failure = (status, retryAfter = null) => ({ ok: false, status, headers: { get: (h) => (h === "retry-after" ? retryAfter : null) } });

test("sendAll records answers and errors without a network", async () => {
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return answer();
  };
  const [good] = await sendAll([F], { fetchImpl: ok, apiKey: "k" });
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].auth, "Bearer k");
  assert.equal(good.answers.real_defect.noul, 0.8);
  assert.equal(good.attempts, 1);
  const [bad] = await sendAll([F], { fetchImpl: async () => failure(400), apiKey: "k", sleep: async () => {} });
  assert.deepEqual([bad.error, bad.attempts], ["HTTP 400", 1]);
});

test("sendAll retries 429 and 5xx with backoff and honors Retry-After", async () => {
  const delays = [];
  const sleep = async (ms) => delays.push(ms);
  const script = [failure(429, "2"), failure(503), answer(0.3)];
  const [rec] = await sendAll([F], { fetchImpl: async () => script.shift(), apiKey: "k", sleep, baseDelayMs: 100 });
  assert.equal(rec.answers.real_defect.noul, 0.3);
  assert.equal(rec.attempts, 3);
  assert.deepEqual(delays, [2000, 200]);

  const always = await sendAll([F], { fetchImpl: async () => failure(500), apiKey: "k", sleep: async () => {}, maxAttempts: 3 });
  assert.deepEqual([always[0].error, always[0].attempts], ["HTTP 500", 3]);

  const thrown = [];
  const flaky = await sendAll([F], {
    fetchImpl: async () => {
      if (thrown.length < 1) {
        thrown.push(1);
        throw new Error("offline");
      }
      return answer();
    },
    apiKey: "k",
    sleep: async () => {},
  });
  assert.equal(flaky[0].attempts, 2);

  const tooLong = await sendAll([F], { fetchImpl: async () => failure(429, "900"), apiKey: "k", sleep: async () => assert.fail("must not wait"), maxDelayMs: 1000 });
  assert.match(tooLong[0].error, /HTTP 429/);
  assert.equal(tooLong[0].attempts, 1);
});

test("sendAll never writes the key into an error record", async () => {
  const [rec] = await sendAll([F], {
    fetchImpl: async (url, init) => {
      throw new TypeError(`invalid header value: ${init.headers.Authorization}`);
    },
    apiKey: "sk-secret",
    sleep: async () => {},
    maxAttempts: 1,
  });
  assert.doesNotMatch(rec.error, /sk-secret/);
});

test("retryDelayMs reads Retry-After in seconds or as a date, else backs off", () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  assert.equal(retryDelayMs("3", 1, { baseDelayMs: 100, maxDelayMs: 10000, now }), 3000);
  assert.equal(retryDelayMs("Mon, 12 Oct 2026 00:00:05 GMT", 1, { baseDelayMs: 100, maxDelayMs: 10000, now }), 5000);
  assert.equal(retryDelayMs(null, 1, { baseDelayMs: 100, maxDelayMs: 10000, now }), 100);
  assert.equal(retryDelayMs(null, 3, { baseDelayMs: 100, maxDelayMs: 10000, now }), 400);
  assert.equal(retryDelayMs("900", 1, { baseDelayMs: 100, maxDelayMs: 10000, now }), null);
  assert.equal(retryDelayMs(null, 20, { baseDelayMs: 100, maxDelayMs: 10000, now }), 10000);
});

test("isUsableAnswer needs a numeric noul in [0, 1] and no error", () => {
  const rec = (noul, extra = {}) => ({ comment_id: 1, answers: { real_defect: { noul } }, ...extra });
  assert.equal(isUsableAnswer(rec(0)), true);
  assert.equal(isUsableAnswer(rec(1)), true);
  assert.equal(isUsableAnswer(rec(0.5)), true);
  assert.equal(isUsableAnswer(rec(-0.1)), false);
  assert.equal(isUsableAnswer(rec(1.1)), false);
  assert.equal(isUsableAnswer(rec(Number.NaN)), false);
  assert.equal(isUsableAnswer(rec("0.5")), false);
  assert.equal(isUsableAnswer(rec(0.5, { error: "HTTP 500" })), false);
  assert.equal(isUsableAnswer({ comment_id: 1 }), false);
  assert.equal(isUsableAnswer(undefined), false);
});

test("latestAnswers keeps the last usable record for each comment", () => {
  const ok = (id, noul) => ({ comment_id: id, answers: { real_defect: { noul } } });
  const err = (id) => ({ comment_id: id, error: "HTTP 500" });
  const m = latestAnswers([err(1), ok(1, 0.2), err(1), ok(2, 0.4), ok(2, 0.6), err(3)]);
  assert.equal(m.get(1).answers.real_defect.noul, 0.2);
  assert.equal(m.get(2).answers.real_defect.noul, 0.6);
  assert.equal(m.get(3).error, "HTTP 500");
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

test("clusterBootstrap resamples whole clusters with a fixed seed", () => {
  const rows = [
    { pr: 1, v: 1 },
    { pr: 1, v: 1 },
    { pr: 2, v: 0 },
    { pr: 3, v: 0 },
    { pr: 4, v: 1 },
  ];
  const mean = (rs) => (rs.length ? rs.reduce((s, r) => s + r.v, 0) / rs.length : null);
  const a = clusterBootstrap(rows, (r) => r.pr, mean, { resamples: 500, seed: 7 });
  const b = clusterBootstrap(rows, (r) => r.pr, mean, { resamples: 500, seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a.lo <= 0.6 && 0.6 <= a.hi);
  assert.ok(a.lo >= 0 && a.hi <= 1);
  assert.deepEqual(clusterBootstrap(rows, (r) => r.pr, () => 0.25, { resamples: 50 }), { lo: 0.25, hi: 0.25, resamples: 50 });
  assert.deepEqual(clusterBootstrap([{ pr: 1, v: 1 }], (r) => r.pr, mean, { resamples: 20 }), { lo: 1, hi: 1, resamples: 20 });
  assert.equal(clusterBootstrap([], (r) => r.pr, mean), null);
  assert.equal(clusterBootstrap(rows, (r) => r.pr, () => null, { resamples: 20 }), null);
});

const tri = (p, valid, severity = "important") => ({ p, valid, severity });

test("simulateTriage never auto-decides a critical or unstated-severity finding", () => {
  const t = simulateTriage(
    [tri(0.95, true), tri(0.95, false, "suggestion"), tri(0.05, false), tri(0.5, true), tri(0.99, true, "critical"), tri(0.01, true, "unknown")],
    { hi: 0.9, lo: 0.1 },
  );
  assert.deepEqual(
    [t.n, t.unstated, t.eligible, t.autoValid, t.autoFalsePositive, t.fullValidation, t.criticalHeld],
    [5, 1, 4, 2, 1, 2, 1],
  );
});

test("simulateTriage computes each gate over the findings it applies to", () => {
  const rows = [
    tri(0.95, false), // leaked false positive
    tri(0.5, false), // false positive kept on full validation
    tri(0.05, false), // false positive auto-dismissed
    tri(0.05, true), // real defect auto-dismissed
    tri(0.95, true),
    tri(0.5, true),
    tri(0.99, false, "critical"), // never eligible
  ];
  const t = simulateTriage(rows, { hi: 0.9, lo: 0.1 });
  assert.equal(t.eligibleFalsePositive, 3);
  assert.equal(t.leakedFalsePositive, 1);
  assert.equal(t.falsePositiveLeak, 1 / 3);
  assert.equal(t.autoFalsePositiveCorrect, 1);
  assert.equal(t.autoFalsePositivePrecision, 0.5);
  assert.equal(t.eligibleValid, 3);
  assert.equal(t.droppedDefects, 1);
  assert.equal(t.droppedDefectRate, 1 / 3);
  assert.equal(t.savedRate, 4 / 7);
});

test("simulateTriage boundaries are inclusive: p = hi is auto-valid, p = lo is auto-false-positive", () => {
  const t = simulateTriage([tri(0.9, true), tri(0.1, false), tri(0.8999, true), tri(0.1001, false)], { hi: 0.9, lo: 0.1 });
  assert.deepEqual([t.autoValid, t.autoFalsePositive, t.fullValidation], [1, 1, 2]);
});

test("simulateTriage reports null for a gate with an empty denominator", () => {
  const t = simulateTriage([tri(0.5, true)], { hi: 0.9, lo: 0.1 });
  assert.equal(t.falsePositiveLeak, null);
  assert.equal(t.autoFalsePositivePrecision, null);
  assert.equal(t.droppedDefectRate, 0);
  assert.equal(simulateTriage([], { hi: 0.9, lo: 0.1 }).savedRate, 0);
});

test("a constant high answer fails the false-positive leak gate", () => {
  const rows = [...Array.from({ length: 98 }, () => tri(0.95, true)), ...Array.from({ length: 30 }, () => tri(0.95, false))];
  const t = simulateTriage(rows, DECISION_RULE);
  assert.equal(t.falsePositiveLeak, 1);
  const d = decide({ primary: 128, falsePositive: 30, kappa: 0.7, triage: t });
  assert.equal(d.decision, "REJECT");
  assert.match(d.reasons.join("\n"), /false positives auto-validated/);
});

test("DECISION_RULE is locked", () => {
  assert.deepEqual(
    { ...DECISION_RULE },
    {
      minPrimary: 100,
      minFalsePositive: 30,
      minEligibleFalsePositive: 20,
      minKappa: 0.6,
      hi: 0.9,
      lo: 0.1,
      maxFalsePositiveLeak: 0.25,
      minAutoFalsePositivePrecision: 0.8,
      maxDroppedDefectRate: 0.005,
      minSavedRate: 0.2,
    },
  );
  assert.ok(Object.isFrozen(DECISION_RULE));
});

// A triage result that passes every gate at exactly its threshold.
const edge = (over = {}) => ({
  eligibleFalsePositive: 20,
  leakedFalsePositive: 5,
  falsePositiveLeak: 5 / 20,
  autoFalsePositive: 5,
  autoFalsePositiveCorrect: 4,
  autoFalsePositivePrecision: 4 / 5,
  eligibleValid: 200,
  droppedDefects: 1,
  droppedDefectRate: 1 / 200,
  n: 220,
  autoDecided: 44,
  savedRate: 44 / 220,
  ...over,
});
const at = (over = {}, triage = {}) => decide({ primary: 100, falsePositive: 30, kappa: 0.6, triage: edge(triage), ...over });

test("decide is ADOPT when every gate holds exactly at its threshold", () => {
  assert.deepEqual(at(), { decision: "ADOPT", reasons: [] });
  assert.equal(at({}, { autoFalsePositive: 0, autoFalsePositiveCorrect: 0, autoFalsePositivePrecision: null }).decision, "ADOPT");
});

test("decide is INCONCLUSIVE just below each sample floor", () => {
  assert.equal(at({ primary: 99 }).decision, "INCONCLUSIVE");
  assert.equal(at({ falsePositive: 29 }).decision, "INCONCLUSIVE");
  assert.equal(at({}, { eligibleFalsePositive: 19, falsePositiveLeak: 5 / 19 }).decision, "INCONCLUSIVE");
});

test("decide is REJECT just past each gate", () => {
  const cases = [
    [{ kappa: 0.5999 }, {}, /kappa/],
    [{ kappa: null }, {}, /kappa/],
    [{}, { leakedFalsePositive: 6, falsePositiveLeak: 6 / 20 }, /false positives auto-validated 6 of 20/],
    [{}, { autoFalsePositiveCorrect: 3, autoFalsePositivePrecision: 3 / 5 }, /auto-dismissed findings that are false positives 3 of 5/],
    [{}, { droppedDefects: 2, droppedDefectRate: 2 / 200 }, /real defects auto-dismissed 2 of 200/],
    [{}, { autoDecided: 43, savedRate: 43 / 220 }, /auto-decided 43 of 220/],
  ];
  for (const [over, triage, reason] of cases) {
    const d = at(over, triage);
    assert.equal(d.decision, "REJECT", String(reason));
    assert.equal(d.reasons.length, 1, String(reason));
    assert.match(d.reasons[0], reason);
  }
});
