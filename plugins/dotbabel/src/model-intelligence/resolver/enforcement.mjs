/** Enforcement is separate from selection: an invocation recipe is not proof of a running configuration. */
/**
 * Assess an artifact's verified binding, or a supplied as-run session observation.
 * @param {object} input
 * @param {object} constraints
 * @param {object} selected
 * @param {object[]} available
 * @returns {{state: string, basis: string, reason: string, diagnostic?: string}}
 */
export function enforcement(input, constraints, selected, available) {
  const contract = input.runtimeContract.capabilities ?? input.runtimeContract;
  const artifact = contract.binding?.[input.target.artifactKind];
  const mayBind = constraints.binding === "self" || constraints.binding === "session" && constraints.pin !== undefined;
  const axes = Object.keys(selected.axes);
  if (mayBind && artifact?.support === "supported" && axes.every(axis => artifact.axes?.[axis] === "supported")) {
    return { state: "enforced", basis: "artifact-binding", reason: "artifact_binding_supported" };
  }
  const observed = input.observed;
  if (observed?.runtimeId === input.target.runtimeId && observed.configurationBasis === "as-run" && !["stale", "expired", "unknown"].includes(observed.freshness)) {
    const current = available.find(c => c.model === observed.axes?.model);
    if (current && (constraints.requirement === undefined || current.classStates[constraints.requirement] !== undefined)) {
      const satisfies = (constraints.requirement === undefined || current.classes.includes(constraints.requirement)) && (!constraints.pin || Object.entries(constraints.pin.config).every(([key, value]) => observed.axes[key] === value));
      return { state: satisfies ? "satisfied-not-enforced" : "unsatisfied", basis: "session-observation", reason: satisfies ? "observed_session_satisfies_requirement" : "observed_session_below_requirement" };
    }
  }
  const unverified = mayBind && (artifact?.support === "unverified" || axes.some(axis => artifact?.axes?.[axis] === "unverified"));
  return { state: "unknown", basis: "none", reason: "binding_unavailable", diagnostic: unverified ? "binding_unverified" : "observation_unavailable" };
}
