/** The shared pure deterministic Model Intelligence resolver (P-10/P-11). */
import { WORKLOAD_CLASSES, makeResolvedRuntimeConfiguration, checkOpaqueValue } from "../domain/index.mjs";
import { compose } from "./compose.mjs";
import { enforcement } from "./enforcement.mjs";
import { explain } from "./explain.mjs";
import { candidates, configureCandidate } from "./candidates.mjs";

/** @param {string} status @param {string} code @param {object[]} [explanation] @returns {object} */
function failure(status, code, explanation = []) {
  return { status, enforcement: { state: status === "conflict" ? "unsatisfied" : "unknown", basis: "none" }, confidence: "low", explanation, diagnostics: [{ code, message: code }] };
}
/**
 * Resolve supplied requirements, effective policy, catalog and runtime contract.
 * No filesystem, process, network, clock or environment operation occurs here.
 * @param {object} input See docs/specs/model-intelligence/spec/5-interfaces-apis.md.
 * @returns {import("../domain/index.mjs").ResolverResult}
 */
export function resolve(input) {
  try {
    const constraints = compose(input);
    if (!constraints.valid) return failure("invalid", "invalid_resolver_input");
    const explanation = constraints.reasons;
    if (!constraints.requirement && !constraints.pin) return failure("unresolved", "runtime_inheritance_preserved", explanation);
    const pinnedModel = constraints.pin?.config.model;
    // An exact pin cannot select another identity. Still evaluate the independent observation.
    const allCandidates = candidates(input, pinnedModel === undefined ? undefined : new Set([pinnedModel, input.observed?.axes?.model]));
    const unresolved = code => {
      const result = failure("unresolved", code, explanation);
      const observed = enforcement(input, constraints, undefined, allCandidates);
      if (observed.basis === "session-observation") {
        result.enforcement = { state: observed.state, basis: observed.basis };
        result.explanation.push({ code: observed.reason, message: observed.reason });
      }
      return result;
    };
    if (!allCandidates.length) return unresolved(constraints.pin ? "pin_unavailable" : "insufficient_capability_evidence");
    const pinnedAxes = constraints.pin?.config ?? {};
    const modelPinned = pinnedAxes.model !== undefined;
    if (constraints.pin && !modelPinned && !constraints.manualOverrides) return unresolved("pin_unavailable");
    if (!constraints.requirement && !modelPinned) return unresolved("runtime_inheritance_preserved");
    let available = modelPinned ? allCandidates.filter(c => c.model === pinnedAxes.model) : allCandidates;
    if (!available.length) return unresolved("pin_unavailable");
    if (constraints.ordinarySelection) {
      available = available.filter(c => c.selectionEvidence?.value === "listed");
      if (!available.length) return unresolved("ordinary_selection_unverified");
    }
    if (modelPinned && !available.some(c => constraints.requirement === undefined || c.classes.includes(constraints.requirement))) {
      return available.some(c => c.classStates[constraints.requirement] === false) ? failure("conflict", "pin_floor_conflict", explanation) : unresolved("insufficient_capability_evidence");
    }
    available = available.filter(c => constraints.requirement === undefined || c.classes.includes(constraints.requirement));
    if (!available.length) return unresolved("insufficient_capability_evidence");
    const requiredCapabilities = Object.entries(constraints.requiredCapabilities);
    if (modelPinned && available.some(c => requiredCapabilities.some(([key, expected]) => Object.hasOwn(c.capabilities, key) && c.capabilities[key] !== expected))) return failure("conflict", "pin_capability_conflict", explanation);
    available = available.filter(c => requiredCapabilities.every(([key, expected]) => Object.hasOwn(c.capabilities, key) && c.capabilities[key] === expected));
    if (!available.length) return unresolved("required_capability_unavailable");
    if (constraints.requiredModalities.length) {
      available = available.filter(c => Array.isArray(c.modalityEvidence?.value) && constraints.requiredModalities.every(modality => c.modalityEvidence.value.includes(modality)));
      if (!available.length) return unresolved("input_modality_unavailable");
    }
    const supportedAxes = (input.runtimeContract.capabilities ?? input.runtimeContract).invocation?.axes ?? {};
    if (Object.keys(pinnedAxes).length) {
      available = available.filter(c => Object.entries(pinnedAxes).every(([key, value]) => supportedAxes[key] === "supported" && (key !== "reasoning" || c.levels.some(level => level.effort === value))));
      if (!available.length) return failure("conflict", "unsupported_configuration_axis", explanation);
    }
    available = available.flatMap(c => {
      const axes = { ...c.axes, ...pinnedAxes };
      if (constraints.effortIntent !== undefined && pinnedAxes.reasoning === undefined) {
        if (supportedAxes.reasoning !== "supported") return [];
        const efforts = c.levels.filter(level => level.intent === constraints.effortIntent && Number.isSafeInteger(level.order) && level.order >= 0 && level.order <= 100);
        efforts.sort((a, b) => a.order - b.order || (a.effort > b.effort ? 1 : a.effort < b.effort ? -1 : 0));
        if (!efforts.length) return [];
        axes.reasoning = efforts[0].effort;
      }
      const evidence = [...(constraints.ordinarySelection ? [c.selectionEvidence] : []), ...(constraints.requiredModalities.length ? [c.modalityEvidence] : [])];
      return [configureCandidate(c, axes, evidence)];
    });
    if (!available.length) return unresolved("effort_intent_unavailable");
    const rank = c => Math.max(...c.classes.map(level => WORKLOAD_CLASSES.indexOf(level)));
    available.sort((a, b) => (input.policy.preferences?.prefer_fresher_evidence === false ? 0 : a.freshness - b.freshness) || rank(a) - rank(b) || (a.model > b.model ? 1 : a.model < b.model ? -1 : 0));
    const selected = available[0];
    if (Object.entries(selected.axes).some(([key, value]) => !checkOpaqueValue(key, value))) return failure("invalid", "invalid_axis_value", explanation);
    const state = enforcement(input, constraints, selected, allCandidates);
    explanation.push(...explain(selected, state));
    const confidence = selected.used.some(e => e.freshness === "expired") ? "low" : selected.used.some(e => e.freshness === "stale") && selected.confidence === "high" ? "medium" : selected.confidence;
    return { status: "resolved", configuration: makeResolvedRuntimeConfiguration({ runtimeId: input.target.runtimeId, axes: selected.axes, representation: { kind: selected.representation, provenance: selected.provenance } }), enforcement: { state: state.state, basis: state.basis }, confidence, explanation, diagnostics: state.diagnostic ? [{ code: state.diagnostic, message: state.diagnostic }] : [] };
  } catch { return failure("invalid", "invalid_resolver_input"); }
}
