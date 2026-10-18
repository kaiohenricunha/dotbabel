/**
 * model-intelligence/catalog — normalize source evidence into field-level facts, derive freshness, and
 * coordinate refresh of the capability cache (docs/specs/model-intelligence, §4 `Component Boundaries`
 * and `Shared State`, §5 `Freshness is separate`, `Refresh state is separate`, `Catalog evidence
 * envelope`, `Knowledge-source adapters`; ARCH-28, ARCH-30, ARCH-61; §7 REL-2, REL-4).
 *
 * Three rules hold throughout:
 *
 * - **No global winner.** A merged record keeps every source's value of a field, each with its own
 *   provenance (ARCH-28). Facts join only under a `PROVIDERS` id: a source-scoped id such as
 *   `models-dev.xai` stays a record of its own source (§5 `Provider namespace`). This module holds no
 *   alias table and knows no source's naming.
 * - **A bad candidate never replaces good evidence.** A failed, empty, malformed, oversized or older
 *   result leaves the stored entry byte-for-byte as it was; the failure is recorded beside it, and the
 *   retained evidence is reported stale (ARCH-30, REL-2).
 * - **One refresh per key.** A refresh takes the key's lock, re-reads the cache, discovers, validates
 *   the complete candidate, replaces the entry atomically, and releases the lock. A caller that finds the
 *   lock held does not start a second discovery (ARCH-61).
 *
 * Adapters arrive as module handles, `{module, context}`, so this module imports no adapter.
 */

import { hostname } from "node:os";
import { PROVIDERS } from "../domain/index.mjs";
import { DESCRIPTOR_KINDS, deepFreeze, isPlainObject } from "../sources/contract.mjs";
import {
  MAX_CACHE_ENTRY_BYTES,
  MAX_CACHE_TREE_BYTES,
  canonicalProviders,
  cacheRoot,
  cacheTreeBytes,
  clearAttempt,
  lockPathFor,
  maintainCache,
  makeCacheEntry,
  parseEntry,
  readAttempt,
  readEntry,
  serializeEntry,
  writeAttempt,
  writeEntry,
} from "./cache.mjs";
import { acquireLock, isPidAlive, judgeLock, processStartIdentity, readLockOwner } from "./lock.mjs";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * REL-4: the default freshness windows of each evidence class, for a source that declares none.
 * Evidence is fresh up to `staleAfterMs` old, stale up to `expireAfterMs`, and expired after that.
 */
export const EVIDENCE_CLASSES = deepFreeze({
  "runtime-discovery": { staleAfterMs: 6 * HOUR, expireAfterMs: 24 * HOUR },
  "runtime-observation": { staleAfterMs: 15 * MINUTE, expireAfterMs: HOUR },
  "provider-api": { staleAfterMs: 6 * HOUR, expireAfterMs: 24 * HOUR },
  "broad-catalog": { staleAfterMs: 24 * HOUR, expireAfterMs: 7 * 24 * HOUR },
});

/**
 * @typedef {object} FreshnessPolicy
 * @property {string} evidenceClass
 * @property {number} staleAfterMs
 * @property {number} expireAfterMs
 * @property {{reason: string}} [override] Present when the adapter replaced the REL-4 default, with its documented reason.
 */

/**
 * @typedef {object} SourceHandle
 * @property {any} module An adapter module: its `descriptor`, `discover`, and, where it has them, `ADAPTER_VERSION`, `notice`, `evidenceClass` and `freshnessPolicy`.
 * @property {Record<string, unknown>} [context] Passed to `discover`. A knowledge source needs `providers`.
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isWindow = (value) => Number.isSafeInteger(value) && /** @type {number} */ (value) > 0;

/**
 * The freshness policy of an adapter module (REL-4). A runtime's discovery defaults to
 * `runtime-discovery` and a knowledge source to `broad-catalog`; a module may name another class in
 * `evidenceClass`. A module may also replace the windows with `freshnessPolicy`, but only with a
 * documented `reason`, which the policy then exposes.
 * @param {any} module
 * @returns {Readonly<FreshnessPolicy>}
 */
export function freshnessPolicyFor(module) {
  const kind = module?.descriptor?.kind;
  if (!DESCRIPTOR_KINDS.includes(kind)) throw new TypeError(`catalog: a source module's descriptor.kind must be one of ${DESCRIPTOR_KINDS.join(", ")}`);
  const evidenceClass = module.evidenceClass ?? (kind === "runtime" ? "runtime-discovery" : "broad-catalog");
  if (typeof evidenceClass !== "string" || !Object.hasOwn(EVIDENCE_CLASSES, evidenceClass)) {
    throw new TypeError(`catalog: evidenceClass must be one of ${Object.keys(EVIDENCE_CLASSES).join(", ")}`);
  }
  if (module.freshnessPolicy === undefined) return Object.freeze({ evidenceClass, ...EVIDENCE_CLASSES[evidenceClass] });
  const { staleAfterMs, expireAfterMs, reason } = module.freshnessPolicy ?? {};
  if (!isWindow(staleAfterMs) || !isWindow(expireAfterMs) || staleAfterMs > expireAfterMs) {
    throw new TypeError("catalog: a freshnessPolicy needs positive whole staleAfterMs and expireAfterMs, with staleAfterMs <= expireAfterMs");
  }
  // REL-4: an override is allowed only when the adapter documents why.
  if (typeof reason !== "string" || reason.trim() === "") throw new TypeError("catalog: a freshnessPolicy must document its reason");
  return Object.freeze({ evidenceClass, staleAfterMs, expireAfterMs, override: Object.freeze({ reason }) });
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function timeOf(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Derive the freshness of evidence observed at `observedAt`, at the injected time `now` (§5 `Freshness
 * is separate`; the clock is an input, so the result is deterministic).
 *
 * A missing or future observation time gives `unknown`, never `fresh`. A refresh that failed after the
 * observation turns `fresh` into `stale` (ARCH-30); it never makes `expired` evidence look better.
 * @param {object} input
 * @param {unknown} input.observedAt
 * @param {FreshnessPolicy} input.policy
 * @param {string} input.now ISO 8601.
 * @param {string} [input.failedAttemptAt] When the last failed refresh of this source happened.
 * @returns {"fresh" | "stale" | "expired" | "unknown"}
 */
export function deriveFreshness({ observedAt, policy, now, failedAttemptAt }) {
  const observed = timeOf(observedAt);
  const current = timeOf(now);
  if (observed === undefined || current === undefined) return "unknown";
  const age = current - observed;
  if (age < 0) return "unknown";
  const state = age <= policy.staleAfterMs ? "fresh" : age <= policy.expireAfterMs ? "stale" : "expired";
  const failed = timeOf(failedAttemptAt);
  return state === "fresh" && failed !== undefined && failed > observed ? "stale" : state;
}

/**
 * The confidence of a fact with the given freshness, one of the domain's `CONFIDENCE_LEVELS`. P-9
 * derives it from freshness alone; the resolver's own confidence (P-11) also weighs which facts it used.
 * @param {string} freshness
 * @returns {"high" | "medium" | "low"}
 */
export function confidenceFor(freshness) {
  return freshness === "fresh" ? "high" : freshness === "stale" ? "medium" : "low";
}

/**
 * Check an adapter result against what this caller asked for.
 *
 * `not_modified` is valid only from a `discover` that sent an `etag`. The result builder cannot see the
 * request, so this check is the one that rejects it anywhere else (§5 `Adapter result`). A breach is
 * the adapter's fault, not data, so it throws.
 * @param {any} result
 * @param {object} request
 * @param {string} request.operation `discover`, `observe` or `validate`.
 * @param {boolean} request.sentEtag
 * @returns {any} The result, unchanged.
 */
export function checkAdapterResult(result, { operation, sentEtag }) {
  if (!isPlainObject(result) || typeof result.status !== "string" || !isPlainObject(result.provenance)) throw new TypeError("catalog: an adapter returned something that is not an adapter result");
  if (result.status === "not_modified") {
    if (operation !== "discover") throw new TypeError(`catalog: a not_modified result is valid only from discover, never from ${operation}`);
    if (sentEtag !== true) throw new TypeError("catalog: a not_modified result is valid only for a discover that sent an etag");
  }
  return result;
}

const FACT_FIELDS = Object.freeze(["id", "capabilities", "displayName", "visibility", "defaultReasoningLevel", "supportedReasoningLevels", "contextWindow", "maxContextWindow", "supportVerbosity", "defaultVerbosity"]);

/**
 * Append one source's value of each field a model fact states.
 * @param {Record<string, object[]>} fields
 * @param {Record<string, unknown>} fact
 * @param {(value: unknown) => object} envelope
 * @returns {void}
 */
function addFacts(fields, fact, envelope) {
  for (const name of FACT_FIELDS) {
    if (fact[name] === undefined) continue;
    (fields[name] ??= []).push(envelope(fact[name]));
  }
}

/**
 * @typedef {object} CatalogItem
 * @property {any} result An `ok` discovery result, live or rebuilt from the cache.
 * @property {"fresh" | "stale" | "expired" | "unknown"} freshness
 * @property {"idle" | "in_progress"} refresh
 */

/**
 * Normalize discovery results into one catalog of field-level facts (§5 `Catalog evidence envelope`).
 *
 * Knowledge-source facts are keyed by provider and model id (ARCH-3). Two sources join only when the
 * provider is a `PROVIDERS` id; any other id keeps a record per source. Each field holds every source's
 * value as a `CatalogEvidence` envelope, in input order: conflicts stay visible, with provenance
 * (ARCH-28). A knowledge source never proves availability, so its facts say `unknown` (ARCH-14).
 *
 * A runtime's discovery is evidence about that runtime, so its facts sit under the runtime id, and a
 * model the runtime lists is `available` to it.
 *
 * Pure: no I/O and no clock. The caller supplies freshness and refresh state.
 * @param {CatalogItem[]} items
 * @returns {Readonly<{sources: object[], models: object[], runtimes: object[]}>}
 */
export function buildCatalog(items) {
  if (!Array.isArray(items)) throw new TypeError("buildCatalog: items must be an array");
  /** @type {Map<string, any>} */
  const models = new Map();
  /** @type {Map<string, {runtimeId: string, models: Map<string, any>}>} */
  const runtimes = new Map();
  const sources = [];
  for (const { result, freshness, refresh } of items) {
    if (!isPlainObject(result) || result.status !== "ok") throw new TypeError("buildCatalog: every item needs an ok result");
    const { provenance, observedAt, evidence } = result;
    const confidence = confidenceFor(freshness);
    const envelope = (availability) => (value) => ({ value, provenance, ...(observedAt === undefined ? {} : { observedAt }), freshness, confidence, availability, refresh });
    const { sourceId, sourceKind } = provenance;
    sources.push({ sourceId, sourceKind, ...(observedAt === undefined ? {} : { observedAt }), freshness, confidence, refresh });

    if (sourceKind === "knowledge-source") {
      for (const provider of evidence.providers) {
        const joined = PROVIDERS.includes(provider.id);
        // A scoped id carries its source in the key, so even an identical string from a second source
        // can never land in the same record.
        const base = joined ? `p\u0000${provider.id}` : `s\u0000${sourceId}\u0000${provider.id}`;
        for (const fact of provider.discovery.models) {
          const recordKey = `${base}\u0000${fact.id}`;
          let record = models.get(recordKey);
          if (record === undefined) {
            record = { provider: provider.id, model: fact.id, joined, ...(joined ? {} : { sourceId, ...(provider.sourceKey === undefined ? {} : { sourceKey: provider.sourceKey }) }), fields: {} };
            models.set(recordKey, record);
          }
          if (joined && provider.sourceKey !== undefined) (record.sourceKeys ??= []).push({ sourceId, sourceKey: provider.sourceKey });
          addFacts(record.fields, fact, envelope("unknown"));
        }
      }
      continue;
    }
    let runtime = runtimes.get(sourceId);
    if (runtime === undefined) {
      runtime = { runtimeId: sourceId, models: new Map() };
      runtimes.set(sourceId, runtime);
    }
    for (const fact of evidence.models) {
      let record = runtime.models.get(fact.id);
      if (record === undefined) {
        record = { model: fact.id, fields: {} };
        runtime.models.set(fact.id, record);
      }
      addFacts(record.fields, fact, envelope("available"));
    }
  }
  return deepFreeze({
    sources,
    models: [...models.values()],
    runtimes: [...runtimes.values()].map((r) => ({ runtimeId: r.runtimeId, models: [...r.models.values()] })),
  });
}

/**
 * The refresh state of one key, read from its lock without taking it (§5 `Refresh state is separate`).
 * A lock that REL-3 judges stale or orphaned is not a refresh in progress, and is reported as such.
 * @param {string} root
 * @param {string} sourceId
 * @param {number} nowMs
 * @returns {{refresh: "idle" | "in_progress", lock?: {state: string, reason: string}}}
 */
function refreshStateOf(root, sourceId, nowMs) {
  const owner = readLockOwner(lockPathFor(root, sourceId));
  if (owner === undefined) return { refresh: "idle" };
  const verdict = judgeLock(owner, { now: nowMs, host: hostname(), isAlive: isPidAlive, processStartOf: processStartIdentity });
  return verdict.state === "held" ? { refresh: "in_progress" } : { refresh: "idle", lock: verdict };
}

/**
 * What a caller is told about the evidence it can use: the stored entry, its freshness and provenance.
 * @param {any} read A `readEntry` result.
 * @param {FreshnessPolicy} policy
 * @param {string} now
 * @param {string | undefined} failedAttemptAt
 * @returns {object | null}
 */
function cachedSummary(read, policy, now, failedAttemptAt) {
  if (read?.state !== "valid") return null;
  const { result } = read;
  const freshness = deriveFreshness({ observedAt: result.observedAt, policy, now, failedAttemptAt });
  return { observedAt: result.observedAt, freshness, confidence: confidenceFor(freshness), provenance: result.provenance };
}

/**
 * @param {any} evidence
 * @param {string} kind
 * @returns {boolean}
 */
function isEmpty(evidence, kind) {
  return kind === "knowledge-source" ? evidence.providers.length === 0 : evidence.models.length === 0;
}

/**
 * @typedef {object} RefreshOutcome
 * @property {string} sourceId
 * @property {"refreshed" | "not_modified" | "concurrent" | "retained" | "failed" | "in_progress"} outcome `concurrent`: another process refreshed this key after this call began. `retained`: the candidate was older than the stored entry.
 * @property {"idle" | "in_progress"} refresh
 * @property {object | null} cached The usable evidence after the call, with its freshness, or `null` when there is none.
 * @property {{code: string, message: string}} [diagnostic]
 * @property {{state: string, reason: string}} [lock] Why the lock could not be taken.
 */

/**
 * Refresh the cache entry of one source (ARCH-61).
 *
 * With the key's lock held: re-read the entry; skip when another process refreshed it after this call
 * began; send the stored `etag` when the entry's provider set and adapter version equal the request's;
 * discover; validate the complete candidate through the cache read path; replace the entry atomically;
 * release the lock. A failed, empty, malformed, oversized or older candidate leaves the entry unchanged.
 * A caller that cannot take the lock gets `in_progress`, with the cached evidence if any, and starts
 * no discovery.
 * @param {SourceHandle} source
 * @param {object} [options]
 * @param {string} [options.root] Defaults to `cacheRoot()`.
 * @param {() => string} [options.now] ISO 8601 clock.
 * @param {number} [options.maxEntryBytes] Defaults to the OPS-2 per-entry limit.
 * @param {number} [options.maxTreeBytes] Defaults to the OPS-2 tree limit.
 * @param {string[]} [options.knownSourceIds] Lets maintenance evict entries of sources this build no longer ships.
 * @returns {Promise<RefreshOutcome>}
 */
export async function refreshSource(source, options = {}) {
  const { module, context = {} } = source ?? {};
  const policy = freshnessPolicyFor(module);
  const id = module.descriptor.id;
  const kind = module.descriptor.kind;
  const root = options.root ?? cacheRoot();
  const now = options.now ?? (() => new Date().toISOString());
  const requestedAt = now();
  const request = kind === "knowledge-source" ? { providers: canonicalProviders(context.providers) } : undefined;

  let lock;
  try {
    lock = acquireLock(lockPathFor(root, id), { resource: id, now: () => Date.parse(now()) });
  } catch (err) {
    // A cache directory that cannot be written is an environment problem of this source, reported like
    // any other failure, so the other sources still run. Nothing was written, so no attempt is recorded.
    const summary = cachedSummary(readEntry(root, id), policy, now(), readAttempt(root, id)?.attemptedAt);
    const code = String(/** @type {any} */ (err)?.code ?? "unknown_error");
    return { sourceId: id, outcome: "failed", refresh: "idle", cached: summary, diagnostic: { code: "cache_unavailable", message: `the refresh lock could not be created (${code})` } };
  }
  if (!lock.acquired) {
    const summary = cachedSummary(readEntry(root, id), policy, now(), readAttempt(root, id)?.attemptedAt);
    return { sourceId: id, outcome: "in_progress", refresh: "in_progress", cached: summary, lock: { state: lock.state, reason: lock.reason } };
  }
  try {
    const read = readEntry(root, id);
    const stored = read.state === "valid" ? read : undefined;
    const done = (outcome, extra = {}) => ({ sourceId: id, outcome, refresh: "idle", cached: cachedSummary(readEntry(root, id), policy, now(), readAttempt(root, id)?.attemptedAt), ...extra });
    const fail = (code, message) => {
      writeAttempt(root, id, { attemptedAt: now(), code, message });
      return done("failed", { diagnostic: { code, message } });
    };

    if (stored !== undefined && Date.parse(stored.result.observedAt) >= Date.parse(requestedAt)) return done("concurrent");
    // DOC-3: a knowledge adapter exports `notice`, a string or null; without it nothing may be stored.
    if (kind === "knowledge-source" && module.notice !== null && typeof module.notice !== "string") {
      return fail("adapter_contract_breach", `the ${id} adapter exports no notice, so its data cannot be stored`);
    }
    const etag =
      stored !== undefined &&
      kind === "knowledge-source" &&
      typeof stored.result.evidence.etag === "string" &&
      JSON.stringify(stored.entry.request.providers) === JSON.stringify(request?.providers) &&
      stored.result.provenance.adapterVersion !== undefined &&
      stored.result.provenance.adapterVersion === module.ADAPTER_VERSION
        ? stored.result.evidence.etag
        : undefined;

    let result;
    try {
      result = await module.discover({ ...context, ...(etag === undefined ? {} : { etag }) });
      checkAdapterResult(result, { operation: "discover", sentEtag: etag !== undefined });
      if (result.provenance.sourceId !== id || result.provenance.sourceKind !== kind) {
        throw new TypeError(`catalog: the ${id} adapter returned a result attributed to another source`);
      }
    } catch (err) {
      return fail(err instanceof TypeError ? "adapter_contract_breach" : "adapter_threw", String(/** @type {any} */ (err)?.message ?? err));
    }

    if (result.status === "not_modified") {
      // The source vouched for the stored evidence again: keep it, and renew only the time (§5).
      const confirmedAt = Date.parse(result.observedAt) > Date.parse(stored.result.observedAt) ? result.observedAt : stored.result.observedAt;
      const renewed = makeCacheEntry({ result: { ...stored.result, observedAt: confirmedAt }, request: stored.entry.request, notice: stored.entry.notice });
      const written = writeEntry(root, renewed, { maxEntryBytes: options.maxEntryBytes ?? MAX_CACHE_ENTRY_BYTES });
      if (!written.written) return fail(written.code, "the renewed entry exceeds the per-entry limit (OPS-2)");
      clearAttempt(root, id);
      return done("not_modified");
    }
    if (result.status !== "ok") {
      const diagnostic = result.diagnostic ?? { code: result.status, message: `discovery returned ${result.status}` };
      return fail(diagnostic.code, diagnostic.message);
    }

    // Validate the complete candidate through the read path, so nothing is written that a reader would refuse.
    let entry;
    try {
      entry = makeCacheEntry({ result, request, notice: module.notice });
      parseEntry(serializeEntry(entry));
    } catch (err) {
      return fail("candidate_invalid", /** @type {Error} */ (err).message);
    }
    if (isEmpty(result.evidence, kind)) return fail("empty_candidate", "discovery returned no usable evidence, which never replaces a cache entry (ARCH-30)");
    if (stored !== undefined && Date.parse(result.observedAt) < Date.parse(stored.result.observedAt)) {
      return done("retained", { diagnostic: { code: "older_candidate", message: "the candidate was observed before the stored entry, so the stored entry stays (REL-2)" } });
    }
    const written = writeEntry(root, entry, { maxEntryBytes: options.maxEntryBytes ?? MAX_CACHE_ENTRY_BYTES });
    if (!written.written) return fail(written.code, `the candidate entry is ${written.bytes} bytes, above the per-entry limit (OPS-2)`);
    clearAttempt(root, id);
    maintainCache(root, { knownSourceIds: options.knownSourceIds, maxTreeBytes: options.maxTreeBytes ?? MAX_CACHE_TREE_BYTES, now: now() });
    return done("refreshed");
  } finally {
    lock.release();
  }
}

/**
 * Refresh several sources, one after another, each under its own lock. One source's failure never stops
 * the others.
 * @param {SourceHandle[]} sources
 * @param {Parameters<typeof refreshSource>[1]} [options]
 * @returns {Promise<RefreshOutcome[]>}
 */
export async function refreshSources(sources, options = {}) {
  const outcomes = [];
  for (const source of sources) outcomes.push(await refreshSource(source, options));
  return outcomes;
}

/**
 * Read the cache and build the catalog from every source's valid entry, with its freshness at `now`
 * and its refresh state. Lock-free: reading takes no lock (ARCH-60).
 * @param {object} input
 * @param {SourceHandle[]} input.sources
 * @param {string} [input.root]
 * @param {string} input.now ISO 8601.
 * @returns {ReturnType<typeof buildCatalog>}
 */
export function loadCatalog({ sources, root = cacheRoot(), now }) {
  const items = [];
  for (const { module } of sources) {
    const id = module.descriptor.id;
    const read = readEntry(root, id);
    if (read.state !== "valid") continue;
    const freshness = deriveFreshness({ observedAt: read.result.observedAt, policy: freshnessPolicyFor(module), now, failedAttemptAt: readAttempt(root, id)?.attemptedAt });
    items.push({ result: read.result, freshness, refresh: refreshStateOf(root, id, Date.parse(now)).refresh });
  }
  return buildCatalog(items);
}

/**
 * The status of every source and of the cache, for `dotbabel models status` (§5 `status`). It reads
 * and never writes, and it never refreshes (ARCH-33).
 * @param {object} input
 * @param {SourceHandle[]} input.sources
 * @param {string} [input.root]
 * @param {string} input.now ISO 8601.
 * @param {number} [input.maxTreeBytes]
 * @returns {object}
 */
export function catalogStatus({ sources, root = cacheRoot(), now, maxTreeBytes = MAX_CACHE_TREE_BYTES }) {
  const totalBytes = cacheTreeBytes(root);
  return {
    envelope: "ModelsStatus",
    version: 1,
    now,
    cache: { totalBytes, maxBytes: maxTreeBytes, withinLimit: totalBytes <= maxTreeBytes },
    sources: sources.map(({ module }) => {
      const { id, kind, capabilities } = module.descriptor;
      const policy = freshnessPolicyFor(module);
      const read = readEntry(root, id);
      const attempt = readAttempt(root, id);
      const state = refreshStateOf(root, id, Date.parse(now));
      const cached = cachedSummary(read, policy, now, attempt?.attemptedAt);
      const evidence = read.state === "valid" ? read.result.evidence : undefined;
      return {
        id,
        kind,
        discovery: capabilities?.discovery?.support ?? "unverified",
        evidenceClass: policy.evidenceClass,
        ...(policy.override === undefined ? {} : { freshnessOverride: policy.override }),
        refresh: state.refresh,
        ...(state.lock === undefined ? {} : { lock: state.lock }),
        cache: cached === null ? null : { ...cached, ...(kind === "knowledge-source" ? { providers: evidence.providers.length, models: evidence.providers.reduce((n, p) => n + p.discovery.models.length, 0) } : { models: evidence.models.length }) },
        ...(read.state === "invalid" ? { invalidEntry: { code: read.code } } : {}),
        ...(attempt === undefined ? {} : { lastFailure: { attemptedAt: attempt.attemptedAt, code: attempt.code } }),
      };
    }),
  };
}
