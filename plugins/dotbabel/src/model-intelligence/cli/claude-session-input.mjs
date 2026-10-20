/** Session-local Claude evidence joining. Release eligibility never becomes live availability. */
import { loadPolicyLayers, mergePolicy } from "../policy/index.mjs";
import { deriveFreshness, freshnessPolicyFor } from "../catalog/index.mjs";
import { checkOpaqueValue } from "../domain/index.mjs";
import { readSnapshot } from "../snapshot/index.mjs";
import { releaseSourceFor } from "../snapshot/core.mjs";
import * as anthropic from "../sources/knowledge/anthropic.mjs";
import * as claude from "../sources/runtime/claude.mjs";

/** Exact native Claude releases whose MAIN routing contract is measured; re-exported for the launcher and bridge. */
export const VERIFIED_CLAUDE_MAIN_VERSIONS = claude.VERIFIED_MAIN_VERSIONS;

const fail = code => Object.assign(new Error(code), { code });
const providerWindow = freshnessPolicyFor(anthropic);
// Only this reviewed source is release-scoped under REL-4; another knowledge source never substitutes.
const RELEASE_DOCS_SOURCE_ID = "claude-release-docs";
const safeSelector = value => typeof value === "string" && checkOpaqueValue("model", value);

/**
 * Load current native selectors through the existing isolated zero-inference adapter. Join only
 * exact provider IDs and reviewed documentation facts from the one existing release registry.
 * The release's availability, accepted dates, identity facts and eligibility are never copied.
 * Native/provider observations expire in six hours; documentation keeps its original date.
 * Each project has independent native membership and policy. No cache or configuration is written.
 * @param {{observe?:Function,loadPolicy?:Function,snapshot?:object,now?:Function,monotonic?:Function}} [options] Trusted source handles and clocks.
 * @returns {{load:Function}} Resolver-input loader; missing live evidence requests a native catalog.
 */
export function createClaudeSessionInputLoader(options = {}) {
  const cache = new Map();
  const now = options.now ?? (() => new Date().toISOString());
  const monotonic = options.monotonic ?? (() => performance.now());
  const snapshot = options.snapshot ?? readSnapshot();
  const observe = options.observe ?? claude.observe;
  const fresh = observedAt => deriveFreshness({ observedAt, now: now(), policy: providerWindow }) === "fresh";

  async function collect(native) {
    if (!claude.VERIFIED_MAIN_VERSIONS.includes(native?.version)) throw fail("routing_unverified");
    if (!Array.isArray(native.selectors) || native.selectors.length < 1 || native.selectors.length > 32 || !native.selectors.every(safeSelector) || !fresh(native.observedAt) || !Array.isArray(native.providerPages) || native.providerPages.length < 1 || native.providerPages.length > 10 || Buffer.byteLength(JSON.stringify(native.providerPages)) > 1048576) throw fail("native_catalog_invalid");
    let page = 0;
    const provider = await anthropic.discover({ providers: ["anthropic"], now: () => native.observedAt,
      fetch: async () => new Response(JSON.stringify(native.providerPages[page++] ?? null)) });
    if (provider.status !== "ok" || page !== native.providerPages.length) throw fail("native_catalog_invalid");
    const facts = new Map(provider.evidence.providers[0].discovery.models.map(model => [model.id, model]));
    const models = new Map();
    const started = monotonic();
    for (const selector of [...new Set(native.selectors)]) {
      const remaining = Math.floor(10000 - (monotonic() - started));
      if (remaining <= 0) break;
      const observation = await observe({ model: selector, timeoutMs: remaining });
      const id = observation.evidence?.axes?.model;
      if (observation.status !== "ok" || observation.evidence?.turnExecuted !== false || observation.evidence.runtimeVersion !== native.version || !fresh(observation.observedAt) || observation.provenance?.sourceId !== "claude" || observation.provenance?.sourceKind !== "runtime" || observation.provenance?.sourceVersion !== native.version || !facts.has(id) || models.has(id)) continue;
      const fact = facts.get(id);
      // load() sets freshness on every read, after its age guard.
      const envelope = (value, provenance, observedAt) => ({ value, provenance, observedAt, confidence: "high", availability: "available", refresh: "idle" });
      const runtimeFact = value => [envelope(value, observation.provenance, observation.observedAt)];
      const providerFact = value => [envelope(value, provider.provenance, provider.observedAt)];
      const fields = { id: runtimeFact(id), selectionVisibility: runtimeFact("listed") };
      if (fact.capabilities) fields.capabilities = providerFact(fact.capabilities);
      if (fact.inputModalities) fields.inputModalities = providerFact(fact.inputModalities);
      // Reviewed exact-model documentation supplies native effort vocabulary and tool support.
      // A new model or contradiction retains only API facts; no family-name inference occurs.
      const documented = snapshot.runtimes.claude.models.find(model => model.model === id);
      const caps = documented?.fields.capabilities?.find(entry => entry.provenance.sourceKind === "knowledge-source" && entry.provenance.sourceId === RELEASE_DOCS_SOURCE_ID && entry.value.reasoning === fact.capabilities?.reasoning);
      if (caps) {
        const source = releaseSourceFor(snapshot, caps.provenance);
        fields.capabilities = [envelope(caps.value, caps.provenance, source.observedAt)];
      }
      const supported = documented?.fields.supportedReasoningLevels?.find(entry => entry.provenance.sourceKind === "knowledge-source" && entry.provenance.sourceId === RELEASE_DOCS_SOURCE_ID);
      if (supported) {
        const source = releaseSourceFor(snapshot, supported.provenance);
        const intersection = fact.supportedReasoningLevels.filter(level => supported.value.some(value => value.effort === level.effort));
        fields.supportedReasoningLevels = [envelope(claude.annotateReasoningLevels(intersection), supported.provenance, source.observedAt)];
      }
      models.set(id, { model: id, fields });
    }
    if (!models.size) throw fail("native_catalog_unavailable");
    const observedAt = [native.observedAt, ...[...models.values()].flatMap(model => model.fields.id.map(entry => entry.observedAt))].sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    return { observedAt, catalog: { sources: [], models: [], runtimes: [{ runtimeId: "claude", models: [...models.values()] }] } };
  }
  return {
    async load(repoRoot, native) {
      if (native !== undefined) {
        if (!cache.has(repoRoot) && cache.size >= 8) throw fail("session_project_limit");
        const candidate = await collect(native);
        cache.set(repoRoot, candidate);
      }
      const cached = cache.get(repoRoot);
      if (!cached || !fresh(cached.observedAt)) throw fail("native_catalog_required");
      const catalog = structuredClone(cached.catalog);
      // The guard above needs the oldest live observation (native probe and Models API page) to be fresh.
      // Reviewed release documentation is release-scoped under REL-4: valid for the shipped snapshot only.
      for (const model of catalog.runtimes[0].models) for (const entries of Object.values(model.fields)) for (const entry of entries) entry.freshness = "fresh";
      const { shipped, user, project } = (options.loadPolicy ?? loadPolicyLayers)({ repoRoot });
      return { policy: mergePolicy({ shipped, user, project }), catalog, target: { runtimeId: "claude", artifactKind: "workflow" }, runtimeContract: claude.descriptor, invocation: { requiredModalities: ["text", "image"] } };
    },
  };
}
