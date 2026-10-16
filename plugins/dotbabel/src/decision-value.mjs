/** Decision data validation shared by receipts and the decider; no execution.
 * @typedef {object} DecisionRecord
 * @property {"review-triage"|"retry"|"dispatch"} step
 * @property {string|string[]} answer
 * @property {"builtin"|"jev"} decider
 * @property {number} confidence A finite probability from 0 to 1.
 * @property {boolean} fallback
 * @property {{decider: "jev", answer: string|string[], confidence: number}|null} shadow
 */
export const DECISION_STEPS = Object.freeze(["review-triage", "retry", "dispatch"]);
const ANSWERS = { "review-triage": ["auto-valid", "auto-false-positive", "full-validation"], retry: ["retry", "fix", "ask-owner"] };
const ID = /^[a-z][a-z0-9-]{0,63}$/;

/** Whether an answer has the step's closed shape.
 * @param {string} step
 * @param {unknown} answer
 * @returns {boolean}
 */
export function validAnswer(step, answer) {
  if (step === "dispatch") return Array.isArray(answer) && answer.length <= 100 && answer.every((v) => typeof v === "string" && ID.test(v));
  return ANSWERS[step]?.includes(answer) ?? false;
}

/** A diagnostic that contains no input data, or null for a valid decision.
 * @param {unknown} value
 * @returns {string|null}
 */
export function decisionProblem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "decision must be an object";
  const keys = ["step", "answer", "decider", "confidence", "fallback", "shadow"];
  if (Object.keys(value).some((k) => !keys.includes(k)) || keys.some((k) => !(k in value))) return "decision has missing or unknown fields";
  if (!DECISION_STEPS.includes(value.step) || !validAnswer(value.step, value.answer)) return "invalid decision step or answer";
  if (!["builtin", "jev"].includes(value.decider) || !probability(value.confidence) || typeof value.fallback !== "boolean") return "invalid decision metadata";
  if (value.shadow !== null) {
    const s = value.shadow;
    if (!s || typeof s !== "object" || Object.keys(s).length !== 3 || s.decider !== "jev" || !validAnswer(value.step, s.answer) || !probability(s.confidence)) return "invalid shadow decision";
  }
  return null;
}

/** A finite probability.
 * @param {unknown} value
 * @returns {boolean}
 */
export function probability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
