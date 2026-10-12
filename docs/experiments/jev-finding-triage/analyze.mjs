#!/usr/bin/env node
// Score a replay run against the /review-pr verdicts and apply the decision
// rule fixed in docs/experiments/2026-10-12-jev-finding-triage.md.
//
//   node analyze.mjs --findings findings.jsonl --answers answers.jsonl    Markdown on stdout
//
// The primary set is every finding outside the mechanical categories with a
// valid or false-positive verdict and a Jev answer. Exit 0 ok, 64 usage.

import fs from "node:fs";

import {
  CATEGORIES,
  DECISION_RULE,
  SEVERITIES,
  cohensKappa,
  datasetCounts,
  decide,
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
const answers = new Map(readJsonl(args.answers).map((a) => [a.comment_id, a]));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fx = (x, d = 3) => (x === null || x === undefined ? "n/a" : x.toFixed(d));

const answered = findings
  .map((f) => ({ f, a: answers.get(f.comment_id) }))
  .filter(({ a }) => a && !a.error && typeof a.answers?.real_defect?.noul === "number");
const primary = answered
  .filter(({ f }) => !f.mechanical && f.verdict !== "unknown")
  .map(({ f, a }) => ({ f, a, p: a.answers.real_defect.noul, valid: f.verdict === "valid", severity: f.severity }));

const counts = datasetCounts(findings);
const errors = [...answers.values()].filter((a) => a.error).length;
const lines = [];
lines.push("## Dataset", "");
lines.push(`- Findings: ${counts.findings} across ${counts.pull_requests} pull requests.`);
lines.push(`- Jev answers: ${answered.length} usable, ${errors} failed.`);
lines.push(
  `- Primary set: ${primary.length} (valid ${primary.filter((r) => r.valid).length}, ` +
    `false positive ${primary.filter((r) => !r.valid).length}).`,
);
lines.push("");

// Agreement at p = 0.5.
const jevSays = primary.map((r) => r.p >= 0.5);
const llmSays = primary.map((r) => r.valid);
const kappa = cohensKappa(jevSays, llmSays);
const cm = { tp: 0, fp: 0, fn: 0, tn: 0 };
primary.forEach((r, i) => {
  if (jevSays[i] && r.valid) cm.tp += 1;
  else if (jevSays[i]) cm.fp += 1;
  else if (r.valid) cm.fn += 1;
  else cm.tn += 1;
});
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

// Triage at the locked thresholds, and a sweep that informs but never decides.
// Only findings that state their severity: today's contract always does, and
// one that does not could be critical, so it could never be auto-decided.
const triageRows = primary.filter((r) => r.severity !== "unknown");
const triage = simulateTriage(triageRows, DECISION_RULE);
lines.push(`## Three-band triage (locked: hi ${DECISION_RULE.hi}, lo ${DECISION_RULE.lo})`, "");
lines.push(`- Findings that state a severity: ${triageRows.length} of ${primary.length}. Rates below are of these.`);
lines.push(
  `- Auto-valid ${triage.autoValid}, auto-false-positive ${triage.autoFalsePositive}, ` +
    `full validation ${triage.fullValidation}.`,
);
lines.push(`- Full validations saved: ${pct(triage.savedRate)}. Wrong auto-decisions: ${triage.wrong} (${pct(triage.wrongRate)}).`);
lines.push(`- Real defects auto-dismissed: ${triage.droppedDefects} (${pct(triage.droppedDefectRate)}).`);
lines.push(`- Critical findings kept on full validation although Jev was outside the band: ${triage.criticalHeld}.`, "");
lines.push("| hi / lo | saved | wrong | real defects dismissed |", "| --- | --- | --- | --- |");
for (const [hi, lo] of [
  [0.95, 0.05],
  [0.9, 0.1],
  [0.8, 0.2],
  [0.7, 0.3],
]) {
  const t = simulateTriage(triageRows, { hi, lo });
  lines.push(`| ${hi} / ${lo} | ${pct(t.savedRate)} | ${t.wrong} (${pct(t.wrongRate)}) | ${t.droppedDefects} |`);
}
lines.push("");

// Secondary: does Jev agree with the posting agent on category and severity?
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

const verdict = decide({
  primary: primary.length,
  falsePositive: primary.filter((r) => !r.valid).length,
  kappa,
  triage,
});
lines.push("## Decision under the locked rule", "", `**${verdict.decision}**`, "");
for (const reason of verdict.reasons) lines.push(`- ${reason}`);
process.stdout.write(`${lines.join("\n")}\n`);
