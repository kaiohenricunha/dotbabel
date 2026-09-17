#!/usr/bin/env node
/**
 * OPS-9 eval for the test-quality judgment in `skills/review-pr/SKILL.md`.
 *
 * Runs every labeled case in `cases/` past two prompts through headless
 * `claude -p` — the BASELINE (the review-pr prose as it stood before the
 * judgment was added) and the CANDIDATE (the judgment shipped in step 11) —
 * scores both, writes RESULTS.md, and exits 1 on any OPS-9 breach (TEST-3).
 *
 * This spends real model invocations: two per case, so 80 for the shipped set.
 * That is why it is a release gate rather than part of `npm test`, and why the
 * decision it makes lives in `scoring.mjs`, which `eval-thresholds.test.mjs`
 * covers for free.
 *
 * Usage:
 *   node run.mjs                 # baseline + candidate, write RESULTS.md
 *   node run.mjs --candidate-only  # skip the baseline; exits 3, never 0
 *   node run.mjs --dry-run       # list what would run, spend nothing
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { score, checkThresholds, renderResults } from "./scoring.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "cases");

/**
 * The prose under evaluation. The baseline is deliberately the instruction
 * that existed BEFORE P-B4 — "review the tests" with no criteria — so the
 * regression check answers the question that matters: did adding the judgment
 * make the reviewer better, or only more verbose?
 */
const PROMPTS = Object.freeze({
  baseline:
    "You are reviewing a pull request. Consider the test below and decide whether it is a low-quality test that a reviewer should raise. Answer with exactly one word: FLAG or PASS.",
  candidate: [
    "You are reviewing a pull request. Decide whether the test below is low-quality and should have a review thread opened against it.",
    "",
    "Flag it when any of these hold:",
    "- Assertion-free: it executes code and asserts nothing, or asserts only that a call did not throw, or commits a snapshot nothing has reviewed.",
    "- Implementation-mirroring: it asserts the sequence of internal calls, or re-derives the expected value with the same expression the code under test uses, so both move together.",
    "- Vacuously true: it passes for a reason unrelated to the behaviour — an always-true condition, an empty fixture, a guard that skips the body.",
    "",
    "A test that asserts a concrete expected value for a concrete input is NOT low-quality, even if it is short or covers an edge case.",
    "",
    "Answer with exactly one word: FLAG or PASS.",
  ].join("\n"),
});

/**
 * Ask the model once. Returns true for FLAG, false for PASS.
 *
 * A reply that is neither counts as PASS, the conservative reading: an
 * unparseable answer must not be scored as a catch.
 *
 * @param {string} instruction
 * @param {string} test
 * @returns {boolean}
 */
function judge(instruction, test) {
  const r = spawnSync("claude", ["-p", `${instruction}\n\n---\n\n${test}`], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  if (r.status !== 0) {
    throw new Error(`claude -p failed (${r.status}): ${String(r.stderr).trim().slice(0, 400)}`);
  }
  return /\bFLAG\b/i.test(String(r.stdout));
}

/** @returns {Array<{id: string, low_quality: boolean, kind: string, test: string}>} */
function loadCases() {
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), "utf8")));
}

function runVariant(label, instruction, cases) {
  const results = [];
  for (const [i, c] of cases.entries()) {
    process.stderr.write(`\r${label}: ${i + 1}/${cases.length}`);
    results.push({ expected: c.low_quality, predicted: judge(instruction, c.test) });
  }
  process.stderr.write("\n");
  return score(results);
}

function main() {
  const argv = process.argv.slice(2);
  const cases = loadCases();

  if (argv.includes("--dry-run")) {
    const low = cases.filter((c) => c.low_quality).length;
    const variants = argv.includes("--candidate-only") ? 1 : 2;
    process.stdout.write(
      `${cases.length} cases (${low} low-quality, ${cases.length - low} good)\n` +
        `would spend ${cases.length * variants} claude -p invocations\n`,
    );
    return 0;
  }

  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) {
    process.stderr.write("claude CLI is not available; cannot run the eval.\n");
    return 2;
  }

  const candidate = runVariant("candidate", PROMPTS.candidate, cases);
  const baseline = argv.includes("--candidate-only") ? null : runVariant("baseline", PROMPTS.baseline, cases);

  const verdict = checkThresholds(candidate, baseline);
  const md = renderResults({ candidate, baseline, verdict, generatedAt: new Date().toISOString() });
  writeFileSync(join(HERE, "RESULTS.md"), md);
  process.stdout.write(md);

  if (!verdict.ok) return 1;
  // Exit 0 is what TEST-3 reads as "may ship". A candidate-only run never
  // measured the no-regression clause, so it reports success without claiming
  // that authority.
  if (baseline === null) {
    process.stderr.write("Baseline skipped: floors met, but OPS-9's no-regression clause is unmeasured. Not a release-gate pass.\n");
    return 3;
  }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  // An infrastructure failure must not wear the exit code that means "the
  // judgment missed OPS-9". 2 is this repo's environment-error code.
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
