/** Opt-in typed Jev questions. Every step remains experimental and shadow-only. */
import { probability } from "./decision-value.mjs";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** The model evaluated by the locked triage experiment. */
export const JEV_MODEL = "jev-1.13.0";

/** Construct only the documented step payload, without configuration or a key.
 * @param {string} step
 * @param {object} input
 * @returns {object}
 */
export function jevRequest(step, input) {
  let questions;
  if (step === "review-triage") questions = { real_defect: { type: "noul", instructions: "This finding is a real defect.", criteria: { true: "The finding describes a real defect in the diff.", false: "The finding is a false positive." } } };
  else if (step === "retry") questions = { action: { type: "choice", instructions: "Choose the next action after this phase failure, within the attempt cap.", criteria: { retry: "A transient failure; retry.", fix: "Repair the cause before retrying.", "ask-owner": "Ask the owner for a decision." } } };
  else questions = Object.fromEntries(input.candidates.map((name, i) => [`reviewer_${i}`, { type: "noul", instructions: `This diff needs ${name}.`, criteria: { true: "This additional reviewer is needed.", false: "This additional reviewer is not needed." } }]));
  return { model: JEV_MODEL, state: JSON.stringify(input), questions };
}

function decode(step, answers, input) {
  if (step === "review-triage") {
    const p = answers?.real_defect?.noul;
    if (!probability(p)) throw new Error("invalid Jev probability");
    return { answer: p >= 0.9 ? "auto-valid" : p <= 0.1 ? "auto-false-positive" : "full-validation", confidence: Math.max(p, 1 - p) };
  }
  if (step === "retry") {
    const choice = answers?.action;
    if (!choice || !["retry", "fix", "ask-owner"].includes(choice.choice) || !probability(choice.confidence)) throw new Error("invalid Jev choice");
    return { answer: choice.choice, confidence: choice.confidence };
  }
  const answer = [];
  const confidence = [];
  for (const [i, name] of input.candidates.entries()) {
    const p = answers?.[`reviewer_${i}`]?.noul;
    if (!probability(p)) throw new Error("invalid Jev probability");
    if (p >= 0.9) answer.push(name);
    confidence.push(Math.max(p, 1 - p));
  }
  return { answer, confidence: confidence.length ? Math.min(...confidence) : 1 };
}

/** Bind a user key and a transport. Retries share the caller's five-second budget.
 * @param {string} key
 * @param {{fetch?: typeof globalThis.fetch}} [opts]
 * @returns {Function}
 */
export function jevAdapter(key, { fetch = globalThis.fetch } = {}) {
  return async (step, input, { signal }) => {
    if (!key) throw new Error("missing adapter key");
    const request = jevRequest(step, input);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(request), signal, redirect: "error" });
      if (response.ok) return decode(step, (await response.json()).answers, input);
      if (attempt === 2 || (response.status !== 429 && response.status < 500)) throw new Error("adapter request failed");
      const retryAfter = response.headers.get("retry-after");
      const delay = retryAfter && Number.isFinite(Number(retryAfter)) ? Math.max(0, Number(retryAfter) * 1000) : 100 * 2 ** attempt;
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("adapter aborted"));
        const aborted = () => { clearTimeout(timer); reject(new Error("adapter aborted")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, delay);
        signal.addEventListener("abort", aborted, { once: true });
      });
    }
  };
}
