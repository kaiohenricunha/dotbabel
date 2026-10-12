#!/usr/bin/env node
// Score a replay run against the /review-pr verdicts and apply the decision
// rule fixed in docs/experiments/2026-10-12-jev-finding-triage.md.
//
//   node analyze.mjs --findings findings.jsonl --answers answers.jsonl    Markdown on stdout
//
// The primary set is every finding outside the mechanical categories with a
// valid or false-positive verdict (isPrimary in lib.mjs). The rule counts only
// the primary findings with a usable Jev answer: no error and a noul in
// [0, 1]. Every other answer counts as failed. The output holds numbers and
// fixed strings only, no review text.
//
// Exit 0 ok, 64 usage.

import fs from "node:fs";

import {
  CATEGORIES,
  DECISION_RULE,
  SEVERITIES,
  clusterBootstrap,
  cohensKappa,
  datasetCounts,
  decide,
  isPrimary,
  isUsableAnswer,
  latestAnswers,
  reliability,
  simulateTriage,
} from "./lib.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === "--findings") args.findings = v;
    else if (flag === "--answers") args.answers = v;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!args.findings || !args.answers) throw new Error("--findings and --answers are required");
  return args;
}

const readJsonl = (file) =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`analyze: ${err.message}\n`);
  process.exit(64);
}

const findings = readJsonl(args.findings);
const answers = latestAnswers(readJsonl(args.answers));
const pct = (x, d = 1) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(d)}%`);
const fx = (x, d = 3) => (x === null || x === undefined ? "n/a" : x.toFixed(d));

const answered = findings
  .map((f) => ({ f, a: answers.get(f.comment_id) }))
  .filter(({ a }) => isUsableAnswer(a));
const extractedPrimary = findings.filter(isPrimary);
const primary = answered
  .filter(({ f }) => isPrimary(f))
  .map(({ f, a }) => ({
    f,
    a,
    p: a.answers.real_defect.noul,
    valid: f.verdict === "valid",
    severity: f.severity,
    cluster: `${f.repo}#${f.pr}`,
  }));
const failedPrimary = extractedPrimary.filter((f) => answers.has(f.comment_id) && !isUsableAnswer(answers.get(f.comment_id)));
const missingPrimary = extractedPrimary.filter((f) => !answers.has(f.comment_id));
const fpCount = (list) => list.filter((x) => (x.f ?? x).verdict === "false_positive").length;

const counts = datasetCounts(findings);
const failed = [...answers.values()].filter((a) => !isUsableAnswer(a)).length;
const lines = [];
lines.push("## Dataset", "");
lines.push(`- Findings: ${counts.findings} across ${counts.pull_requests} pull requests.`);
lines.push(`- Jev answers: ${answered.length} usable, ${failed} failed (an error, or no noul in [0, 1]).`);
lines.push(
  `- Primary set, extracted: ${extractedPrimary.length} (false positive ${fpCount(extractedPrimary)}). ` +
    `With a usable answer: ${primary.length} (false positive ${fpCount(primary)}). ` +
    `Failed: ${failedPrimary.length} (false positive ${fpCount(failedPrimary)}). ` +
    `Not sent: ${missingPrimary.length} (false positive ${fpCount(missingPrimary)}).`,
);
lines.push("");

// Agreement at p = 0.5.
const kappaOf = (rows) =>
  cohensKappa(
    rows.map((r) => r.p >= 0.5),
    rows.map((r) => r.valid),
  );
const kappa = kappaOf(primary);
const cm = { tp: 0, fp: 0, fn: 0, tn: 0 };
for (const r of primary) {
  if (r.p >= 0.5 && r.valid) cm.tp += 1;
  else if (r.p >= 0.5) cm.fp += 1;
  else if (r.valid) cm.fn += 1;
  else cm.tn += 1;
}
lines.push("## Agreement with the /review-pr verdict (p ≥ 0.5 means real defect)", "");
lines.push("| | verdict valid | verdict false positive |", "| --- | --- | --- |");
lines.push(`| Jev real | ${cm.tp} | ${cm.fp} |`, `| Jev not real | ${cm.fn} | ${cm.tn} |`, "");
lines.push(`Accuracy ${primary.length ? pct((cm.tp + cm.tn) / primary.length) : "n/a"}, Cohen's kappa ${fx(kappa)}.`, "");

// Calibration.
const rel = reliability(primary.map((r) => ({ p: r.p, valid: r.valid })));
lines.push("## Reliability", "");
lines.push("| p bin | n | mean p | observed valid rate |", "| --- | --- | --- | --- |");
for (const row of rel.table) {
  lines.push(`| ${row.lo.toFixed(1)}–${row.hi.toFixed(1)} | ${row.n} | ${fx(row.meanP, 2)} | ${fx(row.observed, 2)} |`);
}
lines.push("", `Brier ${fx(rel.brier)}, expected calibration error ${fx(rel.ece)}.`, "");

// Triage at the locked thresholds. simulateTriage leaves out the findings that
// state no severity: one could be critical, so it could never be auto-decided.
const rule = DECISION_RULE;
const triage = simulateTriage(primary, rule);
const boot = (stat) => clusterBootstrap(primary, (r) => r.cluster, stat);
const triageStat = (key) => boot((rows) => simulateTriage(rows, rule)[key]);
const gates = [
  ["Kappa (primary set)", kappa, ">=", rule.minKappa, `${primary.length} findings`, boot(kappaOf)],
  [
    "False positives auto-validated",
    triage.falsePositiveLeak,
    "<=",
    rule.maxFalsePositiveLeak,
    `${triage.leakedFalsePositive} of ${triage.eligibleFalsePositive} eligible false positives`,
    triageStat("falsePositiveLeak"),
  ],
  [
    "Precision of the auto-false-positive band",
    triage.autoFalsePositivePrecision,
    ">=",
    rule.minAutoFalsePositivePrecision,
    `${triage.autoFalsePositiveCorrect} of ${triage.autoFalsePositive} findings at p ≤ ${rule.lo}`,
    triageStat("autoFalsePositivePrecision"),
  ],
  [
    "Real defects auto-dismissed",
    triage.droppedDefectRate,
    "<=",
    rule.maxDroppedDefectRate,
    `${triage.droppedDefects} of ${triage.eligibleValid} eligible valid findings`,
    triageStat("droppedDefectRate"),
  ],
  [
    "Auto-decided",
    triage.savedRate,
    ">=",
    rule.minSavedRate,
    `${triage.autoDecided} of ${triage.n} findings that state a severity`,
    triageStat("savedRate"),
  ],
];
// A gate is fragile when its point estimate passes but its interval crosses the threshold.
const fragile = (value, op, threshold, ci) =>
  value !== null && ci !== null && (op === ">=" ? value >= threshold && ci.lo < threshold : value <= threshold && ci.hi > threshold);
lines.push(`## Gates (locked: hi ${rule.hi}, lo ${rule.lo}; the point estimate decides)`, "");
lines.push(
  `- Triage set: ${triage.n} primary findings that state a severity; ${triage.unstated} state none and stay on full validation. ` +
    `Eligible for auto-decision (not critical): ${triage.eligible}. ` +
    `Critical findings held although Jev was outside the band: ${triage.criticalHeld}.`,
);
lines.push(
  `- Auto-valid ${triage.autoValid}, auto-false-positive ${triage.autoFalsePositive}, full validation ${triage.fullValidation}.`,
  "",
);
lines.push(
  "| Gate | Value | Threshold | Over | 95% PR-clustered bootstrap | Fragile |",
  "| --- | --- | --- | --- | --- | --- |",
);
for (const [name, value, op, threshold, over, ci] of gates) {
  const interval = ci ? `${fx(ci.lo)}–${fx(ci.hi)} (${ci.resamples} resamples)` : "n/a";
  lines.push(
    `| ${name} | ${fx(value)} | ${op === ">=" ? "≥" : "≤"} ${threshold} | ${over} | ${interval} | ` +
      `${fragile(value, op, threshold, ci) ? "yes" : "no"} |`,
  );
}
lines.push("");

// A sweep that informs a later experiment and never feeds the decision.
lines.push("## Threshold sweep (informs a later experiment, never the decision)", "");
lines.push("| hi / lo | auto-decided | false positives auto-validated | real defects auto-dismissed |", "| --- | --- | --- | --- |");
for (const [hi, lo] of [
  [0.95, 0.05],
  [0.9, 0.1],
  [0.8, 0.2],
  [0.7, 0.3],
]) {
  const t = simulateTriage(primary, { hi, lo });
  lines.push(
    `| ${hi} / ${lo} | ${pct(t.savedRate)} | ${t.leakedFalsePositive} of ${t.eligibleFalsePositive} | ` +
      `${t.droppedDefects} of ${t.eligibleValid} |`,
  );
}
lines.push("");

// Secondary: does Jev agree with the posting agent on category and severity?
// The severity check assumes Jev's `score` is a 0-based index into the criteria.
const withCategory = answered.filter(
  ({ f, a }) => f.category !== "unknown" && typeof a.answers?.category?.choice === "string",
);
const catAgree = withCategory.filter(({ f, a }) => a.answers.category.choice === f.category).length;
const withSeverity = answered.filter(
  ({ f, a }) => f.severity !== "unknown" && typeof a.answers?.severity?.score === "number",
);
const sevAgree = withSeverity.filter(
  ({ f, a }) => Math.round(a.answers.severity.score) === SEVERITIES.indexOf(f.severity),
).length;
lines.push("## Secondary: category and severity", "");
lines.push(
  `- Category matches the posted one (${CATEGORIES.length} options): ` +
    `${withCategory.length ? pct(catAgree / withCategory.length) : "n/a"} of ${withCategory.length}.`,
);
lines.push(
  `- Rounded severity matches the posted one: ${withSeverity.length ? pct(sevAgree / withSeverity.length) : "n/a"} ` +
    `of ${withSeverity.length}.`,
  "",
);

const verdict = decide({ primary: primary.length, falsePositive: fpCount(primary), kappa, triage });
lines.push("## Decision under the locked rule", "", `**${verdict.decision}**`, "");
for (const reason of verdict.reasons) lines.push(`- ${reason}`);
if (verdict.decision === "ADOPT" && gates.some(([, value, op, threshold, , ci]) => fragile(value, op, threshold, ci))) {
  lines.push("- At least one gate is fragile: its interval crosses the threshold. ADOPT leads to a shadow run first.");
}
process.stdout.write(`${lines.join("\n")}\n`);
