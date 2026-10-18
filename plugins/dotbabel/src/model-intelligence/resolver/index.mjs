/** The shared pure deterministic Model Intelligence resolver (P-10/P-11). */
import { WORKLOAD_CLASSES, makeResolvedRuntimeConfiguration, checkOpaqueValue } from "../domain/index.mjs";
import { compose } from "./compose.mjs";
import { enforcement } from "./enforcement.mjs";
import { explain } from "./explain.mjs";
import { candidates } from "./candidates.mjs";

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
    const allCandidates = candidates(input);
    let available = allCandidates;
    if (constraints.pin) {
      const axes = constraints.pin.config;
      available = available.filter(c => c.model === axes.model);
      if (!available.length) return failure("unresolved", "pin_unavailable", explanation);
      if (!available.some(c => constraints.requirement === undefined || c.classes.includes(constraints.requirement))) {
        return available.some(c => c.classStates[constraints.requirement] === false) ? failure("conflict", "pin_floor_conflict", explanation) : failure("unresolved", "insufficient_capability_evidence", explanation);
      }
      const supportedAxes = (input.runtimeContract.capabilities ?? input.runtimeContract).invocation?.axes ?? {};
      if (Object.entries(axes).some(([key, value]) => supportedAxes[key] !== "supported" || key === "reasoning" && !available.some(c => c.levels.some(e => e.effort === value)))) return failure("conflict", "unsupported_configuration_axis", explanation);
      available = available.map(c => ({ ...c, axes: { ...c.axes, ...axes } }));
    } else available = available.filter(c => c.classes.includes(constraints.requirement));
    if (!available.length) return failure("unresolved", "insufficient_capability_evidence", explanation);
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
