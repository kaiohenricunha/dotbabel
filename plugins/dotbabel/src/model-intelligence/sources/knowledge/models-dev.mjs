/**
 * model-intelligence/sources/knowledge/models-dev — the Models.dev knowledge-source adapter
 * (docs/specs/model-intelligence, §5 `Knowledge-source adapters` and `External APIs`, P-8a).
 *
 * Models.dev publishes one JSON document of model metadata, keyed by provider. This adapter fetches
 * it once, reduces it to the providers the caller names, and reports each provider's models as
 * `ModelFact`s. It holds no credential and sends none (§2, SEC-3), and it persists nothing: the
 * capability cache and the conditional GET that needs a stored `etag` belong to `catalog/` (P-9).
 *
 * What the evidence never claims: that a model is available. Presence in a public catalog is not
 * proof that this user or runtime can invoke a model (ARCH-14), so no field states availability.
 *
 * The data is MIT-licensed (DOC-3). A caller that stores or commits it keeps `MODELS_DEV_NOTICE`
 * with the copy.
 */

import { createHash } from "node:crypto";
import { assertDescriptor, deepFreeze, isPlainObject, makeAdapterResult, runBounded } from "../contract.mjs";
import { isProviderId, makeDiscoveryEvidence, makeModelFact, makeProviderCatalogEvidence, optionalCount, optionalIdentifier } from "../evidence.mjs";

/** The source's id, as the descriptor and every provenance name it. */
export const SOURCE_ID = "models-dev";

/** Stamped into provenance as `adapterVersion`. Bump it when the adapter's behavior or evidence shape changes. */
export const ADAPTER_VERSION = "1";

/** The one endpoint Models.dev serves (DOC-3). */
export const SOURCE_URL = "https://models.dev/api.json";

/**
 * The most bytes read from a response. The full document was 4.69 MiB on 2026-09-27 and grows, so
 * this bounds memory without breaking on growth; the stored entry has its own, smaller limit.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** The OPS-2 per-entry limit. Evidence above it is rejected before anything could persist it. */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

/** The notice the MIT license requires on every stored or committed copy of the data. */
export const MODELS_DEV_NOTICE = `Model metadata from Models.dev (https://models.dev, https://github.com/anomalyco/models.dev).

MIT License

Copyright (c) 2025 models.dev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** The adapter's declared capabilities: discovery only, over the network, with no credential. */
export const descriptor = deepFreeze(
  assertDescriptor({
    id: SOURCE_ID,
    kind: "knowledge-source",
    capabilities: {
      discovery: { support: "supported", network: "required", auth: "none", cacheable: true, execution: "read-only" },
      observation: { support: "unsupported" },
      binding: {},
      invocation: { support: "unsupported", axes: {} },
      validation: { support: "unsupported" },
    },
  }),
);

/** The provenance every result from this adapter starts from. A fresh object on each call. */
const baseProvenance = () => ({ sourceId: SOURCE_ID, sourceKind: /** @type {const} */ ("knowledge-source"), adapterVersion: ADAPTER_VERSION });

/** Hosts where plain HTTP is allowed, because only a local test fixture is served there (SEC-3). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Check the source URL. A URL that could send data in clear text or carry a credential is a safety
 * fault, so it throws like the SEC-1 root check rather than returning a result (failure channels,
 * `contract.mjs`). The message never echoes the URL, which could hold the credential it refuses.
 * @param {unknown} value
 * @returns {URL}
 */
function sourceUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError("models-dev discover: the source URL is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") throw new TypeError("models-dev discover: the source URL must not carry a credential (SEC-3)");
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new TypeError("models-dev discover: the source URL must use HTTPS; plain HTTP is allowed only on loopback, for a local test fixture (SEC-3)");
}

/**
 * The providers the caller asks for, in the caller's order. A missing or malformed list is a caller
 * breach, so it throws.
 * @param {unknown} value
 * @returns {string[]}
 */
function requestedProviders(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("models-dev discover: providers must be a non-empty array of provider ids");
  const seen = new Set();
  for (const id of value) {
    if (!isProviderId(id)) throw new TypeError("models-dev discover: each provider must be a provider id: lower-case letters, digits, dot, underscore or hyphen, at most 64");
    if (seen.has(id)) throw new TypeError(`models-dev discover: provider "${id}" is named twice`);
    seen.add(id);
  }
  return [...seen];
}

/**
 * Read a response body, stopping once it exceeds `MAX_RESPONSE_BYTES`. The declared length is checked
 * first, but the stream is counted too, because a declared length can be absent or wrong. An abort of
 * the operation cancels the read, so a stalled body cannot hold the connection open.
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<{tooLarge: true} | {tooLarge: false, bytes: Buffer}>}
 */
async function readBounded(response, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  if (response.body === null) return { tooLarge: false, bytes: Buffer.alloc(0) };
  const reader = response.body.getReader();
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        cancel();
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  return { tooLarge: false, bytes: Buffer.concat(chunks) };
}

/**
 * The effort values one record accepts. Only an `effort` option is an effort vocabulary: `toggle` and
 * `budget_tokens` are other mechanisms, and treating them as levels would invent values (ARCH-1).
 * @param {unknown} options
 * @returns {string[]}
 */
function effortValues(options) {
  if (!Array.isArray(options)) return [];
  const values = options.flatMap((option) => (isPlainObject(option) && /** @type {any} */ (option).type === "effort" && Array.isArray(/** @type {any} */ (option).values) ? /** @type {any} */ (option).values : []));
  return [...new Set(values.map(optionalIdentifier).filter((v) => v !== undefined))];
}

/**
 * Build a model fact from one Models.dev record, or `undefined` when the record cannot be used.
 * Only fields a `ModelFact` has are read, so nothing else in the record, such as a stated
 * availability, can reach the evidence.
 * @param {unknown} record
 * @returns {ReturnType<typeof makeModelFact> | undefined}
 */
function factFromRecord(record) {
  if (!isPlainObject(record)) return undefined;
  const r = /** @type {Record<string, unknown>} */ (record);
  const id = optionalIdentifier(r.id);
  if (id === undefined) return undefined;
  /** @type {Record<string, unknown>} */
  const fields = { id, supportedReasoningLevels: effortValues(r.reasoning_options).map((effort) => ({ effort })) };
  const displayName = optionalIdentifier(r.name);
  if (displayName !== undefined) fields.displayName = displayName;
  const contextWindow = isPlainObject(r.limit) ? optionalCount(/** @type {any} */ (r.limit).context) : undefined;
  if (contextWindow !== undefined) fields.contextWindow = contextWindow;
  return makeModelFact(fields);
}

/**
 * One provider's models, sorted by id so the evidence does not depend on the document's key order. A
 * record that cannot be used, or a second record with an id already seen, is counted in `skipped`.
 * @param {Record<string, unknown>} models
 * @returns {ReturnType<typeof makeDiscoveryEvidence>}
 */
function providerDiscovery(models) {
  /** @type {Map<string, ReturnType<typeof makeModelFact>>} */
  const facts = new Map();
  let skipped = 0;
  for (const record of Object.values(models)) {
    const fact = factFromRecord(record);
    if (fact === undefined || facts.has(fact.id)) {
      skipped += 1;
      continue;
    }
    facts.set(fact.id, fact);
  }
  const sorted = [...facts.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return makeDiscoveryEvidence({ models: sorted, skipped });
}

/**
 * Reduce the parsed document to the requested providers. Provider keys come from the network, so each
 * is looked up by own key only, and the output is built as arrays, never as an object keyed by them.
 * @param {Record<string, unknown>} doc
 * @param {string[]} requested
 * @returns {ReturnType<typeof makeProviderCatalogEvidence>}
 */
function reduceDocument(doc, requested) {
  /** @type {Array<{id: string, displayName?: string, discovery: ReturnType<typeof makeDiscoveryEvidence>}>} */
  const providers = [];
  /** @type {string[]} */
  const missingProviders = [];
  let skipped = 0;
  for (const id of requested) {
    if (!Object.hasOwn(doc, id)) {
      missingProviders.push(id);
      continue;
    }
    const provider = doc[id];
    if (!isPlainObject(provider) || !isPlainObject(/** @type {any} */ (provider).models)) {
      skipped += 1;
      continue;
    }
    const displayName = optionalIdentifier(/** @type {any} */ (provider).name);
    providers.push({ id, ...(displayName === undefined ? {} : { displayName }), discovery: providerDiscovery(/** @type {any} */ (provider).models) });
  }
  return makeProviderCatalogEvidence({ providers, missingProviders, skipped });
}

/**
 * Discover the models Models.dev describes for the named providers (§5 `Knowledge-source adapters`).
 *
 * The request and the body read share one REL-1 network timeout. A refused connection, a timeout, or
 * an HTTP error is `unavailable`; a body that is too large, not the expected JSON, or holds none of the
 * requested providers is `unknown`. Neither case throws. Only a caller breach (no providers) or a
 * safety fault (a source URL that is not HTTPS) throws.
 * @param {object} context
 * @param {string[]} context.providers Provider ids to keep, such as `anthropic` or `github-copilot`.
 * @param {string} [context.url] The source URL. HTTPS only, except plain HTTP on loopback for a local fixture.
 * @param {typeof fetch} [context.fetch] Injectable for tests. Defaults to the global `fetch`.
 * @param {() => string} [context.now]
 * @param {number} [context.timeoutMs] Defaults to the REL-1 network timeout.
 * @returns {Promise<object>}
 */
export async function discover(context) {
  const ctx = /** @type {any} */ (isPlainObject(context) ? context : {});
  const requested = requestedProviders(ctx.providers);
  const url = sourceUrl(ctx.url ?? SOURCE_URL);
  const fetchImpl = ctx.fetch ?? globalThis.fetch;
  const now = ctx.now ?? (() => new Date().toISOString());
  const provenance = baseProvenance();
  const result = (status, code, message, retryable) =>
    makeAdapterResult({ status, provenance, observedAt: now(), diagnostic: { code, message, ...(retryable === undefined ? {} : { retryable }) } });

  const ran = /** @type {any} */ (
    await runBounded(
      async ({ signal }) => {
        // No header, cookie or URL credential is ever sent, and a redirect is refused, so the request
        // cannot be steered to a clear-text host after the checks above (SEC-3).
        const response = await fetchImpl(url.href, { method: "GET", headers: { accept: "application/json" }, redirect: "error", credentials: "omit", signal });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return { httpStatus: response.status };
        }
        return { httpStatus: response.status, read: await readBounded(response, signal) };
      },
      { channel: "network", timeoutMs: ctx.timeoutMs, provenance, now },
    )
  );
  if (ran.status !== "ok") return ran;
  const { httpStatus, read } = ran.evidence;

  if (read === undefined) {
    return result("unavailable", "http_error", `the source answered HTTP ${httpStatus}`, httpStatus >= 500 || httpStatus === 429);
  }
  if (read.tooLarge) return result("unknown", "response_too_large", `the response exceeded the ${MAX_RESPONSE_BYTES}-byte read limit`);

  let doc;
  try {
    doc = JSON.parse(read.bytes.toString("utf8"));
  } catch {
    return result("unknown", "malformed_output", "the response was not JSON");
  }
  if (!isPlainObject(doc)) return result("unknown", "malformed_output", "the response was not the JSON object keyed by provider that was expected");

  const evidence = reduceDocument(doc, requested);
  if (evidence.providers.length === 0) {
    return result("unknown", "insufficient_evidence", `none of the ${requested.length} requested providers had usable data (${evidence.missingProviders.length} absent, ${evidence.skipped} unusable)`);
  }
  // OPS-2: the reduced evidence is the candidate cache entry, so it must fit one entry.
  if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_ENTRY_BYTES) {
    return result("unknown", "entry_too_large", `the requested providers exceed the ${MAX_ENTRY_BYTES}-byte cache entry limit (OPS-2)`);
  }
  // The document states no version, so the version is derived here from the bytes received: equal
  // bytes give an equal version, and any change to the data gives a new one.
  const sourceVersion = `sha256:${createHash("sha256").update(read.bytes).digest("hex").slice(0, 32)}`;
  return makeAdapterResult({ status: "ok", evidence, provenance: { ...provenance, sourceVersion }, observedAt: now() });
}
