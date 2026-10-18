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
  const mayBind = input.requirement?.mode !== "inherit" && (constraints.binding === "self" || constraints.binding === "session" && input.requirement?.mode === "pin");
  const axes = Object.keys(selected.axes);
  if (mayBind && artifact?.support === "supported" && axes.every(axis => artifact.axes?.[axis] === "supported")) {
    return { state: "enforced", basis: "artifact-binding", reason: "artifact_binding_supported" };
  }
  const observed = input.observed;
  if (observed?.runtimeId === input.target.runtimeId && observed.configurationBasis === "as-run" && !["stale", "expired", "unknown"].includes(observed.freshness)) {
    const current = available.find(c => c.model === observed.axes?.model);
    const checks = [constraints.requirement === undefined ? true : current?.classStates[constraints.requirement]];
    for (const [key, value] of Object.entries(constraints.pin?.config ?? {})) checks.push(observed.axes?.[key] === undefined ? undefined : observed.axes[key] === value);
    for (const [key, expected] of Object.entries(constraints.requiredCapabilities)) checks.push(current && Object.hasOwn(current.capabilities, key) ? current.capabilities[key] === expected : undefined);
    if (constraints.requiredModalities.length) checks.push(Array.isArray(current?.modalityEvidence?.value) ? constraints.requiredModalities.every(modality => current.modalityEvidence.value.includes(modality)) : undefined);
    if (constraints.effortIntent !== undefined && constraints.pin?.config.reasoning === undefined) {
      const actual = current?.levels.find(level => level.effort === observed.axes?.reasoning);
      checks.push(actual?.intent === undefined ? undefined : actual.intent === constraints.effortIntent);
    }
    if (checks.includes(false)) return { state: "unsatisfied", basis: "session-observation", reason: checks[0] === false ? "observed_session_below_requirement" : "observed_configuration_mismatch" };
    if (!checks.includes(undefined)) return { state: "satisfied-not-enforced", basis: "session-observation", reason: "observed_session_satisfies_requirement" };

  }
  const unverified = mayBind && (artifact?.support === "unverified" || axes.some(axis => artifact?.axes?.[axis] === "unverified"));
  return { state: "unknown", basis: "none", reason: "binding_unavailable", diagnostic: unverified ? "binding_unverified" : "observation_unavailable" };
}
