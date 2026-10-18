/** Pure main-session decisions. Runtime application and observation belong to adapters. */
import { WORKLOAD_CLASSES, EFFORT_INTENTS, compareWorkloadClass, checkOpaqueValue } from "../model-intelligence/domain/index.mjs";
import { resolve } from "../model-intelligence/resolver/index.mjs";

/** @param {string} status @param {string} code @param {object} [extra] @returns {object} */
const decision = (status, code, extra = {}) => ({ status, confidence: "low", diagnostics: [{ code, message: code }], ...extra });
/** @param {object} result @returns {boolean} */
const fresh = result => !result.explanation.some(item => ["stale_evidence_used", "expired_evidence_used"].includes(item.code));
/**
 * Validate the semantic output before any capability loading or route composition.
 * @param {object|undefined} task Classification supplied by the selected strategy.
 * @returns {boolean}
 */
export function isClassificationUsable(task) {
  return task?.status === "classified" && ["medium", "high"].includes(task.confidence) && WORKLOAD_CLASSES.includes(task.requirement?.requirement) && EFFORT_INTENTS.includes(task.effortIntent);
}
/** @param {object} input @returns {string|undefined} */
function eligibility(input) {
  if (input.activation?.enabled !== true) return "intelligence_disabled";
  if (input.activation.routingEnabled !== true) return "routing_disabled";
  if (input.runtimeCapability?.support !== "supported") return input.runtimeCapability?.support === "unsupported" ? "routing_unsupported" : "routing_unverified";
  const task = input.classification;
  if (!isClassificationUsable(task)) return "classification_uncertain";
}
/**
 * Compose one classification with the existing shared resolver, without I/O or application.
 * Unknown manual provenance preserves that axis; the resolver retains all binding floors.
 * A proposed configuration is never evidence that a runtime applied or used it.
 * @param {object} input Activation, classification, resolverInput, current, manual, runtimeCapability.
 * @returns {object} A proposed, preserved, or blocked decision with stable diagnostics.
 */
export function route(input) {
  try {
    const unavailable = eligibility(input);
    if (unavailable) return decision("preserved", unavailable);
    const { resolverInput, classification, current, manual = {}, runtimeCapability } = input;
    const diagnostics = [];
    const overrides = { ...resolverInput.invocation?.overrides };
    for (const axis of ["model", "reasoning"]) {
      const selection = manual[axis];
      if (selection?.source === "inherited") continue;
      const value = selection?.source === "manual" ? selection.value ?? current?.axes?.[axis] : current?.axes?.[axis];
      if (typeof value !== "string" || !checkOpaqueValue(axis, value)) return decision("preserved", "manual_provenance_unknown");
      overrides[axis] = value;
      diagnostics.push({ code: selection?.source === "manual" ? "manual_selection_preserved" : "manual_provenance_unknown" });
    }
    const declaration = resolverInput.requirement;
    const demand = classification.requirement.requirement;
    const level = declaration?.requirement && compareWorkloadClass(declaration.requirement, demand) > 0 ? declaration.requirement : demand;
    const requirement = { ...declaration, mode: declaration?.mode === "inherit" || declaration === undefined ? "dynamic" : declaration.mode, binding: declaration?.binding ?? "session", requirement: level };
    const invocation = { ...resolverInput.invocation, overrides, effortIntent: classification.effortIntent };
    const request = { ...resolverInput, requirement, invocation };
    let resolution = resolve(request);
    if (resolution.status !== "resolved") return decision(resolution.status === "conflict" || resolution.enforcement.state === "unsatisfied" ? "blocked" : "preserved", "resolution_unavailable", { resolution, diagnostics: [...diagnostics, ...resolution.diagnostics] });
    const rejectReplacement = code => decision(resolution.enforcement.state === "unsatisfied" ? "blocked" : "preserved", code, { resolution, diagnostics: [...diagnostics, ...resolution.diagnostics, { code, message: code }] });
    if (!fresh(resolution)) return rejectReplacement("stale_capability_evidence");
    if (resolution.confidence === "low") return rejectReplacement("capability_confidence_low");
    // A retention probe uses the same resolver and cannot shadow any actual model pin.
    const pinnedModel = overrides.model ?? invocation.pin?.config.model ?? declaration?.pin?.config.model ?? resolverInput.policy.pin?.config.model;
    const currentModel = current?.axes?.model;
    if (current?.turnExecuted !== false && pinnedModel === undefined && typeof currentModel === "string" && currentModel !== resolution.configuration.axes.model) {
      const retained = resolve({ ...request, invocation: { ...invocation, modelSelection: "automatic", pin: { runtime: request.target.runtimeId, config: { ...invocation.pin?.config, model: currentModel } } } });
      if (retained.status === "resolved" && retained.confidence !== "low" && fresh(retained)) {
        resolution = retained;
        diagnostics.push({ code: "current_model_retained" });
      }
    }
    const axes = resolution.configuration.axes;
    const changed = Object.keys(axes).filter(axis => axes[axis] !== current?.axes?.[axis]);
    const unsupported = changed.find(axis => runtimeCapability.axes?.[axis] !== "supported");
    if (unsupported) return rejectReplacement(runtimeCapability.axes?.[unsupported] === "unsupported" ? "routing_unsupported" : "routing_unverified");
    const status = changed.length ? "proposed" : "preserved";
    diagnostics.push({ code: changed.length ? "configuration_proposed" : "configuration_already_current" });
    return { status, changes: Object.fromEntries(changed.map(axis => [axis, axes[axis]])), confidence: classification.confidence === "medium" || resolution.confidence === "medium" ? "medium" : "high", configuration: resolution.configuration, resolution, diagnostics };
  } catch { return decision("preserved", "invalid_routing_input"); }
}
