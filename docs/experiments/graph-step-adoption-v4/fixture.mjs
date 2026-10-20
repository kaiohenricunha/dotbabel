// Synthetic test sources only. Never part of a collected research dataset.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonl = rows => rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
const ACTIONS = ["retry", "fix", "ask-owner"];

/** A sealed retry dataset with `perClass` cases of each action, `capped` attempt-3 cases, and two unknowns. */
export function retryFixture(root, { perClass = 40, capped = 3 } = {}) {
  fs.mkdirSync(root, { mode: 0o700 });
  const t = minutes => new Date(Date.parse("2026-10-19T00:00:00Z") + minutes * 60000).toISOString();
  const rows = [];
  for (let i = 0; i < perClass * 3 + capped; i++) {
    const label = ACTIONS[i % 3], repo = `owner${i % 7}/repo${i % 5}`, pr = 100 + i;
    rows.push({ id: `${repo}#${pr}:retry:${i}`, step: "retry", repo, pr, head_sha: digest(String(i)).slice(0, 40),
      source: `https://github.com/${repo}/actions/runs/${i}/job/${i}`, visibility: "public",
      selection_stratum: ["enriched", "control", "unselected-prior"][i % 3], cohort: `cohort-${i % 2}`,
      tail_rule: i % 4 ? "last-error" : "log-end", tail_line_range: [10, 40],
      input: { phase: "ci", attempt: i >= perClass * 3 ? 3 : 1 + (i % 2), failure_tail: i % 4 ? `step ${i} ran\n##[error]synthetic failure ${i}` : `synthetic log end ${i}` },
      label, label_source: "ai-annotation-verified", labeled_before_replay: true });
  }
  const common = r => ({ id: r.id, head_sha: r.head_sha, label: r.label, blind_to_predictions: true, inspection_complete: true,
    tail_sufficient: true, rationale: "Synthetic log inspected.", evidence: [r.source],
    per_action_reasons: { retry: "Synthetic reason.", fix: "Synthetic reason.", "ask-owner": "Synthetic reason." } });
  const annotations = rows.map(r => ({ ...common(r), annotator: "agent:a", status: "labeled", labeled_at: t(20) }));
  const verification = rows.map(r => ({ ...common(r), verifier: "agent:b", status: "agree", disagreements: [], verified_at: t(30) }));
  const unknown = [{ id: "owner0/repo0#1:retry:u1", repo: "owner0/repo0", pr: 1, label: null, reason: "reviewers disagree" },
    { id: "owner1/repo1#2:retry:u2", repo: "owner1/repo1", pr: 2, label: null, reason: "insufficient evidence" }];
  const contents = { "retry.jsonl": jsonl(rows), "annotations.jsonl": jsonl(annotations), "verification.jsonl": jsonl(verification), "unknown.jsonl": jsonl(unknown) };
  for (const [name, body] of Object.entries(contents)) fs.writeFileSync(path.join(root, name), body, { mode: 0o600 });
  const count = key => rows.reduce((acc, r) => ({ ...acc, [r[key]]: (acc[r[key]] ?? 0) + 1 }), {});
  const manifest = { version: 1, created_at: t(0), packet_frozen_at: t(10), sealed_at: t(40), label_source: "ai-annotation-verified",
    repositories: [...new Set(rows.map(r => r.repo))].sort(),
    counts: { rows: rows.length, prs: new Set(rows.map(r => `${r.repo}#${r.pr}`)).size,
      classes: Object.fromEntries(ACTIONS.map(a => [a, rows.filter(r => r.label === a).length])), unknown: unknown.length,
      strata: { enriched: 0, control: 0, "unselected-prior": 0, ...count("selection_stratum") }, cohorts: count("cohort") },
    files: Object.fromEntries(Object.entries(contents).map(([name, body]) => [name, digest(body)])) };
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return { root, rows, manifest };
}

/** Rewrite one data file and its manifest hash, so a test reaches the check after the hash check. */
export function rewrite(root, name, mutate) {
  const file = path.join(root, name), manifestFile = path.join(root, "manifest.json");
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const body = jsonl(mutate(rows));
  fs.writeFileSync(file, body, { mode: 0o600 });
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.files[name] = digest(body);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
}
