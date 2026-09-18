/**
 * P-B4 — the OPS-9 exit contract for the test-quality-judgment eval.
 *
 * `run.mjs` spends real `claude -p` invocations, so the decision it makes
 * cannot be tested by running it. The decision lives in `scoring.mjs` instead,
 * and these tests drive it with synthetic counts — which is the only way to
 * exercise the failure branches at all, since a live run that happens to pass
 * proves nothing about what a breach does.
 */
import { describe, it, expect } from "vitest";
import prettier from "prettier";

import { score, checkThresholds, renderResults, THRESHOLDS } from "./evals/test-quality-judgment/scoring.mjs";

/** Build `n` cases with the given confusion-matrix shape. */
function cases({ tp = 0, fp = 0, fn = 0, tn = 0 }) {
  return [
    ...Array.from({ length: tp }, () => ({ expected: true, predicted: true })),
    ...Array.from({ length: fp }, () => ({ expected: false, predicted: true })),
    ...Array.from({ length: fn }, () => ({ expected: true, predicted: false })),
    ...Array.from({ length: tn }, () => ({ expected: false, predicted: false })),
  ];
}

/** A run that clears every OPS-9 floor: P=0.90, R=0.90, 40 cases. */
const passing = () => score(cases({ tp: 18, fp: 2, fn: 2, tn: 18 }));

describe("score", () => {
  it("computes precision and recall from the confusion matrix", () => {
    const s = score(cases({ tp: 8, fp: 2, fn: 4, tn: 6 }));
    expect(s).toMatchObject({ tp: 8, fp: 2, fn: 4, tn: 6, n: 20 });
    expect(s.precision).toBeCloseTo(0.8, 5);
    expect(s.recall).toBeCloseTo(8 / 12, 5);
  });

  it("scores an empty denominator as 0, never as a perfect score", () => {
    // A judgment that flags nothing has undefined precision. Reading that as
    // 1.0 would let the laziest possible candidate clear the precision floor.
    const flaggedNothing = score(cases({ fn: 10, tn: 30 }));
    expect(flaggedNothing.precision).toBe(0);
    expect(flaggedNothing.recall).toBe(0);
    expect(Number.isNaN(flaggedNothing.precision)).toBe(false);
  });
});

describe("checkThresholds — run.mjs exits 1 when precision is below 0.80, recall is below 0.70, or either is below the baseline", () => {
  it("passes a run that clears every floor", () => {
    expect(checkThresholds(passing())).toEqual({ ok: true, breaches: [] });
  });

  it("fails when precision is below 0.80", () => {
    // 15 TP / 10 FP = 0.60 precision, recall still 0.75.
    const v = checkThresholds(score(cases({ tp: 15, fp: 10, fn: 5, tn: 10 })));
    expect(v.ok).toBe(false);
    expect(v.breaches.join(" ")).toMatch(/precision .* below the OPS-9 floor/);
  });

  it("fails when recall is below 0.70", () => {
    // 10 TP / 10 FN = 0.50 recall, precision a clean 1.0.
    const v = checkThresholds(score(cases({ tp: 10, fp: 0, fn: 10, tn: 20 })));
    expect(v.ok).toBe(false);
    expect(v.breaches.join(" ")).toMatch(/recall .* below the OPS-9 floor/);
  });

  it("fails when either metric regresses against the baseline, even above the floors", () => {
    const baseline = score(cases({ tp: 19, fp: 1, fn: 1, tn: 19 })); // P=0.950 R=0.950
    const candidate = score(cases({ tp: 18, fp: 2, fn: 2, tn: 18 })); // P=0.900 R=0.900
    expect(checkThresholds(candidate).ok).toBe(true); // clears the floors alone
    const v = checkThresholds(candidate, baseline);
    expect(v.ok).toBe(false);
    expect(v.breaches.join(" ")).toMatch(/regressed against the baseline/);
  });

  it("treats matching the baseline exactly as no regression", () => {
    const s = passing();
    expect(checkThresholds(s, s)).toEqual({ ok: true, breaches: [] });
  });

  it("fails an eval set smaller than the 40 labeled tests OPS-9 requires", () => {
    // Perfect scores on a tiny set are not evidence; the size floor is what
    // stops a 4-case run from certifying the judgment.
    const v = checkThresholds(score(cases({ tp: 2, fp: 0, fn: 0, tn: 2 })));
    expect(v.ok).toBe(false);
    expect(v.breaches.join(" ")).toMatch(/at least 40/);
  });

  it("reports every breach rather than only the first", () => {
    const v = checkThresholds(score(cases({ tp: 2, fp: 8, fn: 8, tn: 2 })));
    expect(v.breaches.length).toBeGreaterThanOrEqual(3);
  });

  it("pins the OPS-9 floors themselves, so loosening them is a visible diff", () => {
    expect(THRESHOLDS).toEqual({ precision: 0.8, recall: 0.7 });
  });
});

/** Table rows are padded for prettier, so compare values rather than spacing. */
const unpadded = (md) => md.replace(/[ \t]+\|/g, " |").replace(/\|[ \t]+/g, "| ");

describe("renderResults", () => {
  it("reports the same verdict the exit code is computed from", () => {
    const candidate = score(cases({ tp: 15, fp: 10, fn: 5, tn: 10 }));
    const verdict = checkThresholds(candidate);
    const md = renderResults({ candidate, baseline: null, verdict, generatedAt: "2026-01-01" });
    expect(md).toContain("**FAIL**");
    expect(md).toContain("precision");
    // The table carries the raw counts, so a reader can recompute the metrics.
    expect(unpadded(md)).toContain("| candidate | 40 | 15 | 10 | 5 |");
  });

  it("shows the baseline row only when a baseline ran", () => {
    const s = passing();
    const withOut = renderResults({ candidate: s, baseline: null, verdict: checkThresholds(s), generatedAt: "x" });
    expect(unpadded(withOut)).not.toContain("| baseline |");
    const withIn = renderResults({ candidate: s, baseline: s, verdict: checkThresholds(s, s), generatedAt: "x" });
    expect(unpadded(withIn)).toContain("| baseline |");
  });
});

describe("renderResults formatting", () => {
  // RESULTS.md is committed, and `npm run lint` runs prettier over every
  // markdown file. A renderer that emits a differently-aligned table leaves the
  // repository lint-dirty after every eval run — so the generator, not the
  // artifact, has to match prettier.
  it("emits markdown that prettier leaves unchanged", async () => {
    const s = score([
      { expected: true, flagged: true },
      { expected: true, flagged: false },
      { expected: false, flagged: true },
      { expected: false, flagged: false },
    ]);
    const md = renderResults({ candidate: s, baseline: s, verdict: checkThresholds(s, s), generatedAt: "2026-01-01T00:00:00.000Z" });
    expect(md).toBe(await prettier.format(md, { parser: "markdown" }));
  });
});
