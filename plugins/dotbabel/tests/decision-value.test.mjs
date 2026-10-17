import { expect, it } from "vitest";
import { decisionProblem, validAnswer } from "../src/decision-value.mjs";

const base = { step: "retry", answer: "fix", decider: "builtin", confidence: 1, fallback: false, shadow: null };
it("receipt decisions accept each step's closed answer type and inclusive probability bounds", () => {
  for (const [step, answers] of [["retry", ["retry", "fix", "ask-owner"]], ["review-triage", ["auto-valid", "auto-false-positive", "full-validation"]], ["dispatch", [[], ["security-auditor"]]]]) {
    for (const answer of answers) for (const confidence of [0, 1]) {
      expect(decisionProblem({ ...base, step, answer, confidence })).toBeNull();
      expect(decisionProblem({ ...base, step, answer, shadow: { decider: "jev", answer, confidence } })).toBeNull();
    }
  }
});
it("a receipt refuses malformed decisions and foreign fields without echoing their data", () => {
  const invalid = [null, [], 1, {}, { ...base, step: "foreign" }, { ...base, answer: "auto-valid" }, { ...base, decider: "foreign" }, { ...base, fallback: "false" }, { ...base, extra: "private" }];
  for (const confidence of [null, undefined, -0.1, 1.1, NaN, Infinity, "1"]) invalid.push({ ...base, confidence });
  for (const field of Object.keys(base)) { const missing = { ...base }; delete missing[field]; invalid.push(missing); }
  for (const shadow of [[], {}, { decider: "builtin", answer: "fix", confidence: 1 }, { decider: "jev", answer: "fix", confidence: -1 }, { decider: "jev", answer: "auto-valid", confidence: 1 }, { decider: "jev", answer: "fix", confidence: 1, key: "private" }]) invalid.push({ ...base, shadow });
  for (const value of invalid) {
    const problem = decisionProblem(value);
    expect(problem).toEqual(expect.any(String));
    expect(problem.length).toBeGreaterThan(0);
    expect(problem).not.toContain("private");
  }
});
it("reviewer answers use bounded IDs rather than arbitrary payloads", () => {
  expect(validAnswer("dispatch", Array.from({ length: 100 }, (_, i) => `reviewer-${i}`))).toBe(true);
  for (const answer of [null, "security-auditor", [""], ["bad reviewer"], ["../secret"], [1], Array(101).fill("reviewer")]) expect(validAnswer("dispatch", answer)).toBe(false);
  expect(validAnswer("unknown", "retry")).toBe(false);
});
