/** Official Anthropic capability facts through a caller-owned native authorization boundary. */
import { createHash } from "node:crypto";
import { assertDescriptor, deepFreeze, isPlainObject, makeAdapterResult, MAX_CACHE_ENTRY_BYTES, runBounded } from "../contract.mjs";
import { isProviderId, makeDiscoveryEvidence, makeModelFact, makeProviderCatalogEvidence, optionalCount, optionalIdentifier } from "../evidence.mjs";
import { readBoundedResponse } from "../network.mjs";

/** Official source identity, separate from the Claude runtime adapter. */
export const SOURCE_ID = "anthropic-models-api";
/** Version of this adapter's normalization contract. */
export const ADAPTER_VERSION = "1";
/** Fixed HTTPS endpoint; neither redirects nor caller-selected hosts receive the native transport. */
export const SOURCE_URL = "https://api.anthropic.com/v1/models?limit=100";
/** Model capability facts carry no copied document/license notice. */
export const notice = null;
/** Discovery consumes existing native authorization but never receives or stores a credential. */
export const descriptor = deepFreeze(assertDescriptor({ id: SOURCE_ID, kind: "knowledge-source", capabilities: {
  discovery: { support: "supported", network: "required", auth: "required-existing", cacheable: true, execution: "read-only" },
  observation: { support: "unsupported" }, binding: {}, invocation: { support: "unsupported", axes: {} }, validation: { support: "unsupported" },
} }));

function modelFact(record) {
  if (!isPlainObject(record)) return undefined;
  const id = optionalIdentifier(record.id); if (id === undefined) return undefined;
  const effort = isPlainObject(record.capabilities?.effort) ? record.capabilities.effort : {};
  const levels = effort.supported === true ? Object.keys(effort).filter(key => /^[a-z][a-z0-9_-]{0,31}$/.test(key) && !["constructor", "prototype"].includes(key) && effort[key]?.supported === true).sort().map(effort => ({ effort })) : [];
  const thinking = record.capabilities?.thinking?.supported;
  const context = optionalCount(record.max_input_tokens); const name = optionalIdentifier(record.display_name);
  return makeModelFact({ id, supportedReasoningLevels: levels,
    ...(typeof thinking === "boolean" ? { capabilities: { reasoning: thinking } } : {}),
    ...(context === undefined ? {} : { contextWindow: context }), ...(name === undefined ? {} : { displayName: name }),
  });
}

/**
 * Normalize API-reported provider facts without asserting native availability or binding.
 * The injected fetch belongs to the runtime and retains its opaque authorization handle.
 * No default fetch, credential store, authorization header, model call or persistence is used.
 * @param {{providers:string[],fetch?:typeof fetch,url?:string,now?:Function,timeoutMs?:number}} context Explicit providers and native-owned HTTPS transport.
 * @returns {Promise<object>} Provider catalog evidence, or a bounded unavailable/unknown result.
 */
export async function discover(context) {
  const ctx = isPlainObject(context) ? context : {};
  if (!Array.isArray(ctx.providers) || ctx.providers.length === 0 || !ctx.providers.every(isProviderId)) throw new TypeError("anthropic discover: providers must be non-empty provider ids");
  if (ctx.url !== undefined && ctx.url !== SOURCE_URL) throw new TypeError("anthropic discover: source URL must be the fixed official HTTPS endpoint");
  const now = ctx.now ?? (() => new Date().toISOString());
  const provenance = { sourceId: SOURCE_ID, sourceKind: "knowledge-source", adapterVersion: ADAPTER_VERSION };
  const result = (status, code, retryable) => makeAdapterResult({ status, provenance, observedAt: now(), diagnostic: { code, message: code, ...(retryable === undefined ? {} : { retryable }) } });
  if (!ctx.providers.includes("anthropic")) return result("unknown", "provider_not_supported");
  if (typeof ctx.fetch !== "function") return result("unavailable", "native_transport_unavailable");
  const ran = await runBounded(async ({ signal }) => {
    const models = new Map(); const versions = createHash("sha256"); let total = 0; let skipped = 0;
    const cursors = new Set(); let cursor;
    for (let page = 0; page < 10; page++) {
      const url = new URL(SOURCE_URL); if (cursor !== undefined) url.searchParams.set("after_id", cursor);
      const response = await ctx.fetch(url.href, { method: "GET", redirect: "manual", credentials: "omit", headers: { accept: "application/json", "anthropic-version": "2023-06-01" }, signal });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return { failure: "http_error", unavailable: true }; }
      const read = await readBoundedResponse(response, signal, MAX_CACHE_ENTRY_BYTES - total);
      if (read.tooLarge) return { failure: "response_too_large" };
      total += read.bytes.length; versions.update(read.bytes);
      let doc; try { doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)); } catch { return { failure: "malformed_output" }; }
      if (!isPlainObject(doc) || !Array.isArray(doc.data) || typeof doc.has_more !== "boolean") return { failure: "malformed_output" };
      for (const record of doc.data) {
        const fact = modelFact(record); if (fact === undefined) { skipped++; continue; }
        if (models.has(fact.id)) return { failure: "duplicate_model" };
        models.set(fact.id, fact);
      }
      if (!doc.has_more) {
        if (models.size === 0) return { failure: "insufficient_evidence" };
        const discovery = makeDiscoveryEvidence({ models: [...models.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), skipped });
        const evidence = makeProviderCatalogEvidence({ providers: [{ id: "anthropic", discovery }], missingProviders: [...new Set(ctx.providers.filter(id => id !== "anthropic"))].sort(), skipped: 0 });
        if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_CACHE_ENTRY_BYTES) return { failure: "entry_too_large" };
        return { evidence, sourceVersion: "sha256:" + versions.digest("hex").slice(0, 32) };
      }
      const next = optionalIdentifier(doc.last_id);
      if (next === undefined || cursors.has(next)) return { failure: "pagination_invalid" };
      cursors.add(next); cursor = next;
    }
    return { failure: "pagination_limit" };
  }, { channel: "network", timeoutMs: ctx.timeoutMs, provenance, now });
  if (ran.status !== "ok") return result(ran.status, ran.diagnostic?.code ?? "operation_failed", ran.diagnostic?.retryable);
  const payload = ran.evidence;
  if (payload.failure !== undefined) return result(payload.unavailable ? "unavailable" : "unknown", payload.failure);
  return makeAdapterResult({ status: "ok", evidence: payload.evidence, provenance: { ...provenance, sourceVersion: payload.sourceVersion }, observedAt: now() });
}
