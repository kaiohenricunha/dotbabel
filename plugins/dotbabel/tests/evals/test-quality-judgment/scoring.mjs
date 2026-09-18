/**
 * Scoring and the OPS-9 exit contract for the test-quality-judgment eval.
 *
 * Separated from `run.mjs` on purpose: `run.mjs` spends real `claude -p`
 * invocations, so the part that decides pass or fail has to be testable
 * without them. Everything here is pure — `eval-thresholds.test.mjs` drives it
 * with synthetic counts, and `run.mjs` drives it with counts from a live run.
 *
 * The judgment flags a test as low-quality. So, per case:
 *   - a true positive is a genuinely low-quality test the judgment flagged
 *   - a false positive is a good test the judgment flagged, which is the
 *     expensive error: it sends a reviewer to argue with a correct test
 *   - a false negative is a low-quality test the judgment missed
 *
 * Precision is weighted above recall in the thresholds for that reason —
 * OPS-9 asks 0.80 of precision and 0.70 of recall.
 */

/** OPS-9 floors. A release may not ship the judgment below either. */
export const THRESHOLDS = Object.freeze({ precision: 0.8, recall: 0.7 });

/**
 * Precision, recall, and the raw confusion counts for one run.
 *
 * A denominator of zero yields 0, never NaN or 1. "Flagged nothing, so
 * precision is perfect" is exactly the degenerate reading this guards against.
 *
 * @param {Array<{expected: boolean, predicted: boolean}>} cases
 * @returns {{precision: number, recall: number, tp: number, fp: number, fn: number, tn: number, n: number}}
 */
export function score(cases) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const c of cases) {
    if (c.predicted && c.expected) tp += 1;
    else if (c.predicted && !c.expected) fp += 1;
    else if (!c.predicted && c.expected) fn += 1;
    else tn += 1;
  }
  const ratio = (num, den) => (den === 0 ? 0 : num / den);
  return {
    tp,
    fp,
    fn,
    tn,
    n: cases.length,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
  };
}

/**
 * Apply OPS-9 to a candidate run, optionally against a baseline.
 *
 * Three independent ways to fail, each reported rather than collapsed into one
 * message, because the remedies differ: too few cases means the eval set is not
 * yet an eval set, a floor breach means the judgment is not good enough, and a
 * regression means it got worse than the prose it replaces.
 *
 * @param {ReturnType<typeof score>} candidate
 * @param {ReturnType<typeof score>|null} [baseline]
 * @param {number} [minCases] OPS-9 requires at least 40 labeled tests.
 * @returns {{ok: boolean, breaches: string[]}}
 */
export function checkThresholds(candidate, baseline = null, minCases = 40) {
  const breaches = [];

  if (candidate.n < minCases) {
    breaches.push(`eval set has ${candidate.n} labeled tests, OPS-9 requires at least ${minCases}`);
  }
  if (candidate.precision < THRESHOLDS.precision) {
    breaches.push(`precision ${candidate.precision.toFixed(3)} is below the OPS-9 floor of ${THRESHOLDS.precision}`);
  }
  if (candidate.recall < THRESHOLDS.recall) {
    breaches.push(`recall ${candidate.recall.toFixed(3)} is below the OPS-9 floor of ${THRESHOLDS.recall}`);
  }

  // "No lower than the baseline" is a regression check, so equality passes.
  if (baseline !== null) {
    if (candidate.precision < baseline.precision) {
      breaches.push(`precision ${candidate.precision.toFixed(3)} regressed against the baseline ${baseline.precision.toFixed(3)}`);
    }
    if (candidate.recall < baseline.recall) {
      breaches.push(`recall ${candidate.recall.toFixed(3)} regressed against the baseline ${baseline.recall.toFixed(3)}`);
    }
  }

  return { ok: breaches.length === 0, breaches };
}

/**
 * Render RESULTS.md. Kept here so the report cannot drift from the numbers the
 * exit code was computed from.
 *
 * @param {{candidate: ReturnType<typeof score>, baseline: ReturnType<typeof score>|null,
 *          verdict: ReturnType<typeof checkThresholds>, generatedAt: string}} run
 * @returns {string}
 */
export function renderResults(run) {
  const header = ["run", "cases", "TP", "FP", "FN", "precision", "recall"];
  const cells = (label, s) => [label, s.n, s.tp, s.fp, s.fn, s.precision.toFixed(3), s.recall.toFixed(3)].map(String);
  const rows = [];
  if (run.baseline !== null) rows.push(cells("baseline", run.baseline));
  rows.push(cells("candidate", run.candidate));

  // Pad every column to its widest cell, with a minimum of three so the
  // separator keeps `---`. This reproduces prettier's own markdown table
  // layout: RESULTS.md is committed and `npm run lint` runs prettier over it,
  // so a renderer that emits a different alignment leaves the repository
  // lint-dirty after every eval run. `eval-thresholds.test.mjs` pins the two
  // together by formatting this output and asserting it is unchanged.
  const widths = header.map((name, i) => Math.max(3, name.length, ...rows.map((row) => row[i].length)));
  const line = (values) => `| ${values.map((value, i) => value.padEnd(widths[i])).join(" | ")} |`;

  const lines = [
    "# Test-quality judgment — eval results",
    "",
    `> Generated ${run.generatedAt}. OPS-9 floors: precision ${THRESHOLDS.precision}, recall ${THRESHOLDS.recall}.`,
    "",
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(line),
  ];
  // A baseline-less run measured only two of OPS-9's three clauses, so it must
  // not print the word that authorises a ship. TEST-3 treats `run.mjs` exit 0
  // as the release gate, and a verdict line reading "OPS-9 satisfied" after an
  // unmeasured regression check is exactly the overclaim that would slip past.
  const headline = !run.verdict.ok
    ? "**FAIL** — OPS-9 breached:"
    : run.baseline === null
      ? "**PARTIAL** — floors met, but the baseline was skipped, so OPS-9's no-regression clause is UNMEASURED."
      : "**PASS** — OPS-9 satisfied.";
  lines.push("", headline, "");
  for (const b of run.verdict.breaches) lines.push(`- ${b}`);
  return `${lines.join("\n").trimEnd()}\n`;
}
