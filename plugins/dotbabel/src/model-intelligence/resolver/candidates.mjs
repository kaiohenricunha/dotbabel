/** Pure evidence evaluation. Opaque model names never determine capability. */
import { WORKLOAD_CLASSES } from "../domain/index.mjs";

const freshnessOrder = { fresh: 0, stale: 1, unknown: 2, expired: 3 };
/** @param {unknown} a @param {unknown} b @returns {boolean} */
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Choose a field without erasing contradictory evidence of the same authority.
 * @param {object[]} [entries]
 * @param {object} [preferences]
 * @returns {object|undefined}
 */
export function field(entries = [], preferences = {}) {
  const usable = entries.filter(e => e && (e.freshness === "fresh" || e.freshness === "stale" && preferences.allow_stale_evidence !== false || e.freshness === "expired" && preferences.allow_expired_evidence === true));
  if (!usable.length) return undefined;
  if (usable.length === 1) return usable[0].availability === "available" ? usable[0] : undefined;
  const ranked = [...usable].sort((a, b) => (a.provenance?.sourceKind === "runtime" ? 0 : 1) - (b.provenance?.sourceKind === "runtime" ? 0 : 1) || freshnessOrder[a.freshness] - freshnessOrder[b.freshness]);
  const best = ranked[0];
  const peers = ranked.filter(e => e.provenance?.sourceKind === best.provenance?.sourceKind && e.freshness === best.freshness);
  return best.availability === "available" && peers.every(e => e.availability === best.availability && equal(e.value, best.value)) ? best : undefined;
}
/**
 * Check a semantic class against factual capabilities, never today's model spelling.
 * @param {string} level
 * @param {object} policy
 * @param {object} capabilities
 * @param {object[]} levels
 * @param {boolean} levelsKnown
 * @returns {boolean|undefined}
 */
function satisfies(level, policy, capabilities, levels, levelsKnown) {
  const rule = policy.classes[level]?.satisfied_by;
  if (!rule || typeof rule !== "object") return undefined;
  const checks = Object.entries(rule).map(([key, expected]) => {
    if (key === "reasoning" && expected === "optional") return true;
    if (key === "reasoning" && expected === "required") return capabilities.reasoning === undefined ? undefined : capabilities.reasoning === true;
    if (key === "reasoning_effort_tiers") return !levelsKnown ? undefined : typeof expected === "number" && new Set(levels.map(e => e.effort)).size >= expected;
    return !Object.hasOwn(capabilities, key) ? undefined : capabilities[key] === expected;
  });
  return checks.includes(false) ? false : checks.includes(undefined) ? undefined : true;
}
/**
 * Recompute metadata from the fields actually used by the chosen axes and constraints.
 * @param {object} candidate
 * @param {object} axes
 * @param {object[]} [extraEvidence]
 * @returns {object}
 */
export function configureCandidate(candidate, axes, extraEvidence = []) {
  const used = [...new Set([...candidate.baseEvidence, ...extraEvidence, ...(axes.reasoning !== undefined && axes.reasoning === candidate.defaultEvidence?.value ? [candidate.defaultEvidence] : [])])];
  return { ...candidate, axes, used, freshness: Math.max(...used.map(e => freshnessOrder[e.freshness])), confidence: used.some(e => e.confidence === "low") ? "low" : used.some(e => e.confidence === "medium") ? "medium" : "high" };
}
/**
 * Build eligible native configurations from runtime-local evidence. Global presence alone never qualifies.
 * Missing capability facts remain unknown; caller-owned adapters/catalogs must supply them explicitly.
 * @param {object} input
 * @param {Set<string>|undefined} [relevantModels] Exact pin and independent observation, when applicable.
 * @returns {object[]}
 */
export function candidates(input, relevantModels) {
  const preferences = input.policy.preferences ?? {};
  const models = input.catalog.runtimes.find(r => r.runtimeId === input.target.runtimeId)?.models ?? [];
  return models.filter(record => relevantModels === undefined || relevantModels.has(record.model)).flatMap(record => {
    const fields = record.fields ?? {};
    const identity = field(fields.id, preferences);
    if (!identity || identity.availability !== "available" || identity.value !== record.model || identity.provenance?.sourceKind !== "runtime" || identity.provenance?.sourceId !== input.target.runtimeId) return [];
    const capability = field(fields.capabilities, preferences);
    const supported = field(fields.supportedReasoningLevels, preferences);
    const levels = Array.isArray(supported?.value) ? supported.value : [];
    const caps = capability?.value ?? {};
    const classStates = Object.fromEntries(WORKLOAD_CLASSES.map(level => [level, satisfies(level, input.policy, caps, levels, supported !== undefined)]));
    const classes = WORKLOAD_CLASSES.filter(level => classStates[level] === true);
    const defaultLevel = field(fields.defaultReasoningLevel, preferences);
    const reasoning = levels.some(e => e.effort === defaultLevel?.value) ? defaultLevel.value : undefined;
    const axes = { model: record.model, ...(reasoning === undefined ? {} : { reasoning }) };
    const selectionEvidence = field(fields.selectionVisibility, preferences);
    const modalityEvidence = field(fields.inputModalities, preferences);
    return [configureCandidate({ model: record.model, classes, classStates, capabilities: caps, levels, baseEvidence: [identity, capability, supported].filter(Boolean), defaultEvidence: defaultLevel, selectionEvidence, modalityEvidence, provenance: identity.provenance, representation: "native-id" }, axes)];
  });
}
