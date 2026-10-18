/** Local task classification. No provider invocation, repository scan, native model or runtime state. */

/** Maximum prompt bytes inspected by the default local strategy. */
export const MAX_PROMPT_BYTES = 16384;
/** Maximum serialized supplied context bytes. */
export const MAX_CONTEXT_BYTES = 4096;
const STRATEGY = Object.freeze({ id: "local-contextual", version: 1 });
const CONTEXT_KEYS = ["componentCount", "specification", "risk", "consequence", "ambiguity", "verification", "priorFailures"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function validContext(context) {
  if (!object(context) || ![Object.prototype, null].includes(Object.getPrototypeOf(context)) || Object.keys(context).some(key => !CONTEXT_KEYS.includes(key))) return false;
  for (const [key, max] of [["componentCount", 64], ["priorFailures", 20]]) {
    if (context[key] !== undefined && (!Number.isInteger(context[key]) || context[key] < 0 || context[key] > max)) return false;
  }
  for (const [key, values] of [["specification", ["present", "absent", "unknown"]], ["risk", ["low", "medium", "high", "unknown"]], ["consequence", ["low", "medium", "high", "unknown"]], ["ambiguity", ["low", "medium", "high", "unknown"]], ["verification", ["simple", "integration", "adversarial", "unknown"]]]) {
    if (context[key] !== undefined && !values.includes(context[key])) return false;
  }
  return Buffer.byteLength(JSON.stringify(context)) <= MAX_CONTEXT_BYTES;
}

function outcome(status, code) {
  return { status, confidence: "low", reasons: [{ code, message: code }], diagnostics: [{ code, message: code }], characteristics: {}, strategy: STRATEGY };
}

function instructions(prompt) {
  return prompt.replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/^\s*>.*$/gm, " ")
    .replace(/\b(?:do not|don't|must not|avoid|without|no changes to)\b[^.;\n]*/gi, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"|(?<![\p{L}\p{N}_])'[^'\n]*'(?![\p{L}\p{N}_])/gu, " ").toLowerCase();
}

/**
 * Classify bounded supplied task context into semantic demand and separate effort intent.
 * Confidence describes rule/input certainty, not calibrated model quality or task success.
 * The function contract permits replacement independently of runtime integrations.
 * @param {{prompt: string, context?: object}} input
 * @returns {object} Semantic requirement, effort intent, characteristics, confidence and reason codes.
 */
export function classify(input) {
  try {
    if (!object(input) || typeof input.prompt !== "string" || !input.prompt.trim()) return outcome("invalid", "invalid_classification_input");
    if (Buffer.byteLength(input.prompt) > MAX_PROMPT_BYTES) return outcome("invalid", "classification_input_too_large");
    const context = input.context === undefined ? {} : input.context;
    if (!validContext(context)) return outcome("invalid", "invalid_classification_input");
    const text = instructions(input.prompt).trim();
    const action = /\b(?:fix|implement|format|rename|sort|lint|investigate|debug|diagnose|design|redesign|review|test|add|update|compare)\b/.test(text);
    const vague = /\b(?:this|that|thing|stuff|it)\b/.test(text) && text.split(/\s+/).length <= 4 && !context.componentCount;
    if (!action || vague || !text) return outcome("uncertain", "classification_uncertain");
    const investigation = /\b(?:investigate|debug|diagnose|race|races|idempotency|consistency)\b/.test(text);
    const integration = context.verification === "integration" || /\b(?:integration|webhook|persistence|cross-component)\b|across services/.test(text);
    const mechanical = /\b(?:format|rename|sort|lint)\b/.test(text) && !integration;
    const systemDesign = /\b(?:design|redesign|architect)\b.*\b(?:architecture|distributed|system)\b/.test(text);
    const lexicalRisk = /\b(?:production|authentication|security|idempotency|race|races|consistency)\b/.test(text);
    const risk = context.risk && context.risk !== "unknown" ? context.risk : lexicalRisk ? "high" : "unknown";
    const consequence = context.consequence ?? risk;
    const ambiguity = context.ambiguity ?? (investigation || systemDesign ? "high" : context.specification === "present" ? "low" : "unknown");
    const verification = context.verification ?? (systemDesign ? "adversarial" : integration ? "integration" : mechanical ? "simple" : "unknown");
    const priorFailures = context.priorFailures ?? 0;
    let demand = mechanical ? "mechanical" : "routine";
    if (integration || investigation || systemDesign || context.componentCount > 1 || risk === "high" || consequence === "high") demand = "deep";
    if (verification === "adversarial" || ambiguity === "high" && (risk === "high" || consequence === "high" || priorFailures >= 2)) demand = "frontier";
    if (systemDesign && context.componentCount >= 4 && ambiguity === "high" && (risk === "high" || consequence === "high")) demand = "exceptional";
    const effortIntent = risk === "high" || consequence === "high" || ambiguity === "high" || priorFailures >= 2 ? "high" : demand === "mechanical" ? "low" : "medium";
    const characteristics = { scope: context.componentCount === undefined ? "unknown" : context.componentCount > 3 ? "system" : context.componentCount > 1 ? "cross-component" : "local", risk, consequence, ambiguity, verification, priorFailures, specification: context.specification ?? "unknown" };
    const reasons = ["task_demand_classified", "scope_considered", "risk_considered", "verification_considered"].map(code => ({ code, message: code }));
    if (priorFailures > 0) reasons.push({ code: "prior_failures_considered", message: "prior_failures_considered" });
    const confidence = [risk, ambiguity, verification].includes("unknown") ? "medium" : "high";
    return { status: "classified", requirement: { requirement: demand, binding: "session", mode: "dynamic", provenance: { sourceId: "local-task-classifier", sourceKind: "artifact" } }, effortIntent, confidence, characteristics, reasons, diagnostics: [], strategy: STRATEGY };
  } catch { return outcome("invalid", "invalid_classification_input"); }
}
