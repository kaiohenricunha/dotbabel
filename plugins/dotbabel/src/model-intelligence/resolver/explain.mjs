/** Ordered, structured resolver reasons. Human wording is not the API. */
/**
 * Explain only the evidence that participates in the selected configuration.
 * @param {object} candidate
 * @param {object} enforcement
 * @returns {object[]}
 */
export function explain(candidate, enforcement) {
  const reasons = [{ code: "configuration_selected", message: "The native configuration satisfies the effective semantic constraints.", provenance: candidate.provenance }];
  if (candidate.used.some(e => e.freshness === "stale")) reasons.push({ code: "stale_evidence_used", message: "The selected configuration uses permitted stale evidence.", provenance: candidate.provenance });
  if (candidate.used.some(e => e.freshness === "expired")) reasons.push({ code: "expired_evidence_used", message: "The selected configuration uses explicitly permitted expired evidence.", provenance: candidate.provenance });
  reasons.push({ code: enforcement.reason, message: enforcement.reason });
  return reasons;
}
