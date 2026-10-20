/** Bounded decisions. Unadopted adapters run only in shadow mode. No default IO. */
import { DECISION_STEPS, validAnswer, probability } from "./decision-value.mjs";

/** Locked adoption evidence; configuration cannot promote a step. */
export const ADOPTION = Object.freeze({
  "review-triage": Object.freeze({ status: "REJECT", report: "docs/experiments/2026-10-12-jev-finding-triage.md", hi: 0.9, lo: 0.1 }),
  retry: Object.freeze({ status: "UNMEASURED", report: null }),
  dispatch: Object.freeze({ status: "REJECT", report: "docs/experiments/graph-step-adoption-v3/dispatch-results-2026-10-19.md" }),
});

/** The adapter's execution capabilities and per-step adoption states.
 * @param {string} [name]
 * @returns {object}
 */
export function deciderAdapter(name = "builtin") {
  const builtin = name === "builtin";
  const known = builtin || name === "jev";
  const support = builtin ? "supported" : known ? "unverified" : "unsupported";
  const capability = { support, network: builtin || !known ? "never" : "required", auth: builtin || !known ? "none" : "required-existing", cacheable: false, execution: builtin || !known ? "read-only" : "may-execute-model" };
  return { name, ...capability, steps: Object.fromEntries(DECISION_STEPS.map((step) => [step, { ...capability, evidence: builtin ? "built-in rules" : ADOPTION[step].report ?? "no locked ADOPT result" }])) };
}

function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function text(value) { return typeof value === "string" && value.length <= 60000; }
function ids(value) { return Array.isArray(value) && value.length <= 100 && value.every((s) => typeof s === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(s)); }

/** Validate the exact step payload, so only documented fields leave the process.
 * @param {string} step
 * @param {unknown} input
 * @returns {void}
 */
export function validateDecisionInput(step, input) {
  if (!DECISION_STEPS.includes(step)) throw new Error("unknown decision step");
  if (!object(input) || Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error("invalid or oversized decision input");
  const keys = { "review-triage": ["finding"], retry: ["phase", "attempt", "failure_tail"], dispatch: ["profile", "changed_files", "changed_lines", "candidates"] }[step];
  if (Object.keys(input).some((k) => !keys.includes(k))) throw new Error("unknown decision input field");
  if (step === "review-triage") {
    const f = input.finding;
    const fields = ["file", "title", "body", "diff_hunk", "severity", "category"];
    if (!object(f) || Object.keys(f).some((k) => !fields.includes(k)) || !["file", "title", "body", "diff_hunk"].every((k) => text(f[k]))) throw new Error("invalid finding");
    if (["severity", "category"].some((k) => f[k] != null && !text(f[k]))) throw new Error("invalid finding metadata");
  } else if (step === "retry") {
    if (!text(input.phase) || !input.phase || !Number.isInteger(input.attempt) || input.attempt < 1 || !text(input.failure_tail)) throw new Error("invalid retry input");
  } else if (!ids(input.profile) || !ids(input.candidates) || !Array.isArray(input.changed_files) || !input.changed_files.every(text) || !Number.isInteger(input.changed_lines) || input.changed_lines < 0) {
    throw new Error("invalid dispatch input");
  }
}

function builtinAnswer(step, input, maxAttempts) {
  if (step === "review-triage") return "full-validation";
  if (step === "retry") return input.attempt >= maxAttempts ? "ask-owner" : "fix";
  return input.profile.includes("security-auditor") ? [] : ["security-auditor"];
}

function boundedAnswer(step, answer, input, maxAttempts) {
  if (step === "review-triage" && (!input.finding.severity || input.finding.severity === "critical")) return "full-validation";
  if (step === "retry" && input.attempt >= maxAttempts) return "ask-owner";
  if (step === "dispatch") return [...new Set([...answer.filter((s) => !input.profile.includes(s)), ...builtinAnswer(step, input, maxAttempts)])];
  return answer;
}

function adapterResult(step, result, input) {
  if (!object(result) || !validAnswer(step, result.answer) || !probability(result.confidence)) throw new Error("invalid adapter answer");
  if (step === "dispatch" && result.answer.some((s) => !input.candidates.includes(s) && s !== "security-auditor")) throw new Error("invalid reviewer");
  return { answer: result.answer, confidence: result.confidence };
}

/** Answer a step within hard limits. An adapter failure never escapes this call.
 * `adapter` is injected: the CLI binds the key without passing config to it.
 * @param {string} step
 * @param {object} input
 * @param {{config?: object, consent?: boolean, key?: string, adapter?: Function, maxAttempts?: number}} [opts]
 * @returns {Promise<object>}
 */
export async function decide(step, input, opts = {}) {
  validateDecisionInput(step, input);
  const { config = {}, consent = false, key = "", adapter, maxAttempts = 3 } = opts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("invalid attempt cap");
  const answer = builtinAnswer(step, input, maxAttempts);
  const output = { step, answer, confidence: 1, decider: "builtin", fallback: false, shadow: null };
  if (!config.adapter || config.adapter === "builtin") return output;
  if (config.adapter !== "jev" || !consent || !key || !config.steps?.includes(step) || typeof adapter !== "function") return { ...output, fallback: true };
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("adapter timeout")); }, 5000); });
    const raw = await Promise.race([Promise.resolve().then(() => adapter(step, structuredClone(input), { signal: controller.signal })), timeout]);
    const result = adapterResult(step, raw, input);
    const bounded = boundedAnswer(step, result.answer, input, maxAttempts);
    if (!validAnswer(step, bounded)) throw new Error("bounded answer is too large");
    // No step has ADOPT evidence. Promotion requires a reviewed source change.
    return { ...output, shadow: { decider: "jev", answer: bounded, confidence: result.confidence } };
  } catch {
    return { ...output, fallback: true };
  } finally { clearTimeout(timer); }
}
