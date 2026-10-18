/** Pure user-facing advice over an existing resolution; no selection, discovery or execution. */
import { WORKLOAD_CLASSES, compareWorkloadClass } from "../domain/index.mjs";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sameAxes = (a, b) => object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);

/**
 * Build advisory output from public resolver output, optional validated as-run observation,
 * independently established capability-class comparison, and the runtime's native recipe.
 * A comparison is supplied evidence, never a model-name ranking. Missing comparison permits
 * change advice but cannot claim escalation or de-escalation. Reconstructed probes are not
 * the user's current session. The caller owns observation and native recipe validation.
 * @param {{resolverResult:object,observation?:object,assessment?:object,invocation?:object}} options Already-derived evidence; no runtime calls occur here.
 * @returns {object} Serializable recommendation envelope preserving the original resolver result.
 */
export function buildRecommendation({ resolverResult, observation, assessment, invocation } = {}) {
  if (!object(resolverResult) || !["resolved", "unresolved", "conflict", "invalid"].includes(resolverResult.status)) throw Object.assign(new TypeError("recommendation_input_invalid"), { code: "recommendation_input_invalid" });
  const usable = resolverResult.status === "resolved" && object(resolverResult.configuration?.axes);
  const current = usable && observation?.runtimeId === resolverResult.configuration.runtimeId && observation.configurationBasis === "as-run" && object(observation.axes) && !["stale", "expired", "unknown"].includes(observation.freshness);
  let advice = usable ? "unknown" : "unavailable";
  if (current) {
    advice = sameAxes(observation.axes, resolverResult.configuration.axes) ? "keep" : "change";
    if (advice === "change" && resolverResult.enforcement?.basis === "session-observation" && resolverResult.enforcement.state === "unsatisfied" && resolverResult.explanation?.some(entry => entry.code === "observed_session_below_requirement")) advice = "escalate";
    if (advice === "change" && WORKLOAD_CLASSES.includes(assessment?.observedClass) && WORKLOAD_CLASSES.includes(assessment?.recommendedClass)) {
      const comparison = compareWorkloadClass(assessment.observedClass, assessment.recommendedClass);
      if (comparison < 0) advice = "escalate";
      if (comparison > 0) advice = "de-escalate";
    }
  }
  const native = usable && invocation !== undefined ? invocation : undefined;
  const executable = native !== undefined && Array.isArray(native.args) && Array.isArray(native.unsupportedAxes) && native.unsupportedAxes.length === 0;
  return structuredClone({ envelope: "ModelRecommendation", version: 1, configurationBasis: "advice", resolverResult, ...(observation === undefined ? {} : { observation }), ...(assessment === undefined ? {} : { assessment }), advice, executable,
    ...(native === undefined ? {} : { invocation: native }), diagnostics: native?.unsupportedAxes?.length ? [{ code: "invocation_axes_unsupported" }] : [] });
}
