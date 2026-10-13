/**
 * model-intelligence/catalog/cache — capability-cache persistence (docs/specs/model-intelligence,
 * §4 `Shared State`, ARCH-59, ARCH-61; §5 `Knowledge-source adapters`; §7 REL-2, OPS-2; DOC-3).
 *
 * The cache lives under `cacheDir()/model-intelligence` and holds one entry for each source id:
 *
 *   entries/<sourceId>.json    the last valid evidence of the source, in a versioned envelope
 *   attempts/<sourceId>.json   the last failed refresh, kept apart so the entry stays byte-for-byte (REL-2)
 *   locks/<sourceId>.lock      the refresh lock of that key (`lock.mjs`)
 *
 * The key is the source id, never `sourceVersion`: Models.dev derives that from the full document, not
 * from the reduced evidence an entry holds. A knowledge-source entry records the provider set it was
 * reduced to, so a conditional GET can tell whether the stored `etag` still covers the request.
 *
 * Every file is replaced whole, through a temporary file and an atomic rename (ARCH-59). The read path
 * rebuilds evidence through the same builders an adapter uses, so a cached copy passes the same
 * validation as a fresh one: an edited or corrupt entry is invalid, never trusted. A knowledge-source
 * entry carries its adapter's `notice`, so a stored copy keeps the license of its data (DOC-3).
 *
 * This module owns filesystem I/O of the cache and nothing else (ARCH-56).
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { cacheDir } from "../../lib/paths.mjs";
import { MAX_CACHE_ENTRY_BYTES, isPlainObject, makeAdapterResult } from "../sources/contract.mjs";
import { isProviderId, makeDiscoveryEvidence, makeModelFact, makeProviderCatalogEvidence } from "../sources/evidence.mjs";
import { STALE_LOCK_MIN_AGE_MS } from "./lock.mjs";

export { MAX_CACHE_ENTRY_BYTES };

/** The directory under `cacheDir()` that Model Intelligence owns. */
export const CACHE_SUBDIR = "model-intelligence";

/** OPS-2: the most the whole cache tree may hold after maintenance. */
export const MAX_CACHE_TREE_BYTES = 64 * 1024 * 1024;

/** The `format` of a cache entry. A reader refuses any other. */
export const CACHE_ENTRY_FORMAT = "dotbabel.model-intelligence.cache-entry";

/** The envelope version this build writes and reads. */
export const CACHE_ENTRY_FORMAT_VERSION = 1;

const ENTRIES = "entries";
const ATTEMPTS = "attempts";
const LOCKS = "locks";

/** A source id that is safe as a file name: no separator, no `.` or `..`. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A temporary or set-aside file of an interrupted write or lock recovery: `<target>.<pid>.<nonce>.<suffix>`. */
const INTERRUPTED_RE = /\.\d+\.[0-9a-f]{16}\.(tmp|stale)$/;

const ENVELOPE_FIELDS = Object.freeze(["format", "formatVersion", "sourceId", "provenance", "observedAt", "request", "notice", "evidence"]);

/**
 * @param {string} sourceId
 * @returns {string}
 */
function key(sourceId) {
  if (typeof sourceId !== "string" || !KEY_RE.test(sourceId)) throw new TypeError("capability cache: a source id must be an identifier of at most 64 characters");
  return sourceId;
}

/**
 * The capability-cache root: `cacheDir()/model-intelligence`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function cacheRoot(env = process.env) {
  return join(cacheDir(env), CACHE_SUBDIR);
}

/**
 * The entry file of one source.
 * @param {string} root
 * @param {string} sourceId
 * @returns {string}
 */
export function entryPath(root, sourceId) {
  return join(root, ENTRIES, `${key(sourceId)}.json`);
}

/**
 * The refresh-lock file of one source.
 * @param {string} root
 * @param {string} sourceId
 * @returns {string}
 */
export function lockPathFor(root, sourceId) {
  return join(root, LOCKS, `${key(sourceId)}.lock`);
}

/**
 * The failed-attempt record of one source.
 * @param {string} root
 * @param {string} sourceId
 * @returns {string}
 */
export function attemptPath(root, sourceId) {
  return join(root, ATTEMPTS, `${key(sourceId)}.json`);
}

/**
 * Replace `target` with `text` atomically (ARCH-59): write the whole text to
 * `<target>.<pid>.<nonce>.tmp`, flush and close it, then rename it over the target. A reader sees the
 * old file or the new one, never a part. On failure the temporary file is removed and the target is
 * unchanged.
 * @param {string} target
 * @param {string} text
 * @param {Pick<typeof nodeFs, "openSync" | "writeSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync">} [io] Injectable for tests.
 * @returns {void}
 */
export function writeFileAtomic(target, text, io = nodeFs) {
  const tmp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const bytes = Buffer.from(text, "utf8");
  /** @type {number | undefined} */
  let fd;
  try {
    fd = io.openSync(tmp, "wx");
    for (let offset = 0; offset < bytes.length; ) offset += io.writeSync(fd, bytes, offset, bytes.length - offset);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {
        // The descriptor is already unusable; the unlink below is what matters.
      }
    }
    try {
      io.unlinkSync(tmp);
    } catch {
      // Never created, or already gone.
    }
    throw err;
  }
}

/**
 * A provider set in the one order the cache stores: unique and sorted.
 * @param {unknown} providers
 * @returns {string[]}
 */
export function canonicalProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0 || !providers.every(isProviderId)) {
    throw new TypeError("capability cache: providers must be a non-empty array of provider ids");
  }
  return [...new Set(providers)].sort();
}

/**
 * @typedef {object} CacheEntry
 * @property {string} format
 * @property {number} formatVersion
 * @property {string} sourceId
 * @property {object} provenance
 * @property {string} observedAt When the source last produced or confirmed this evidence.
 * @property {{providers: string[]}} [request] Knowledge sources only: the provider set the evidence was reduced to.
 * @property {string | null} [notice] Knowledge sources only: the adapter's `notice`, kept with every copy (DOC-3).
 * @property {object} evidence
 */

/**
 * Build the envelope of one entry from an `ok` result.
 * @param {object} input
 * @param {any} input.result An `ok` adapter result with `observedAt`.
 * @param {{providers: string[]}} [input.request] Required for a knowledge source.
 * @param {string | null} [input.notice] Required for a knowledge source: a string, or `null` when the source needs none.
 * @returns {CacheEntry}
 */
export function makeCacheEntry({ result, request, notice }) {
  if (!isPlainObject(result) || result.status !== "ok" || result.evidence === undefined) throw new TypeError("capability cache: only an ok result with evidence can become an entry");
  if (typeof result.observedAt !== "string") throw new TypeError("capability cache: an entry needs the observedAt its freshness counts from");
  const { provenance } = result;
  /** @type {CacheEntry} */
  const entry = { format: CACHE_ENTRY_FORMAT, formatVersion: CACHE_ENTRY_FORMAT_VERSION, sourceId: key(provenance.sourceId), provenance: { ...provenance }, observedAt: result.observedAt, evidence: result.evidence };
  if (provenance.sourceKind === "knowledge-source") {
    if (!isPlainObject(request)) throw new TypeError("capability cache: a knowledge-source entry records the provider set it was reduced to");
    if (notice !== null && typeof notice !== "string") throw new TypeError("capability cache: a knowledge-source entry carries its adapter's notice, a string or null (DOC-3)");
    entry.request = { providers: canonicalProviders(request.providers) };
    entry.notice = notice;
  }
  return entry;
}

/**
 * Serialize an entry exactly as it is stored. The OPS-2 limit applies to these bytes, envelope and
 * notice included.
 * @param {CacheEntry} entry
 * @returns {string}
 */
export function serializeEntry(entry) {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * @param {unknown} json
 * @returns {ReturnType<typeof makeDiscoveryEvidence>}
 */
function rebuildDiscovery(json) {
  if (!isPlainObject(json)) throw new TypeError("cached discovery evidence must be an object");
  const { models, effortSupport, skipped, ...rest } = /** @type {any} */ (json);
  if (Object.keys(rest).length > 0) throw new TypeError(`cached discovery evidence: unknown field "${Object.keys(rest)[0]}"`);
  // effortSupport is derived from the models, so it is recomputed by the builder rather than trusted.
  if (effortSupport !== undefined && !isPlainObject(effortSupport)) throw new TypeError("cached discovery evidence: effortSupport must be an object");
  if (!Array.isArray(models)) throw new TypeError("cached discovery evidence: models must be an array");
  return makeDiscoveryEvidence({ models: models.map((m) => makeModelFact(m)), ...(skipped === undefined ? {} : { skipped }) });
}

/**
 * @param {unknown} json
 * @returns {ReturnType<typeof makeProviderCatalogEvidence>}
 */
function rebuildProviderCatalog(json) {
  if (!isPlainObject(json)) throw new TypeError("cached provider catalog evidence must be an object");
  const { providers, missingProviders, skipped, etag, ...rest } = /** @type {any} */ (json);
  if (Object.keys(rest).length > 0) throw new TypeError(`cached provider catalog evidence: unknown field "${Object.keys(rest)[0]}"`);
  if (!Array.isArray(providers)) throw new TypeError("cached provider catalog evidence: providers must be an array");
  return makeProviderCatalogEvidence({
    providers: providers.map((p) => {
      if (!isPlainObject(p)) throw new TypeError("cached provider entry must be an object");
      return { ...p, discovery: rebuildDiscovery(/** @type {any} */ (p).discovery) };
    }),
    missingProviders,
    ...(skipped === undefined ? {} : { skipped }),
    ...(etag === undefined ? {} : { etag }),
  });
}

/**
 * Validate a parsed envelope and rebuild its evidence through the evidence builders.
 * @param {unknown} json
 * @returns {{entry: CacheEntry, result: any}}
 */
function entryFromJson(json) {
  if (!isPlainObject(json)) throw new TypeError("a cache entry must be a JSON object");
  const raw = /** @type {Record<string, any>} */ (json);
  for (const field of Object.keys(raw)) if (!ENVELOPE_FIELDS.includes(field)) throw new TypeError(`cache entry: unknown field "${field}"`);
  if (raw.format !== CACHE_ENTRY_FORMAT) throw new TypeError(`cache entry: format must be ${CACHE_ENTRY_FORMAT}`);
  if (raw.formatVersion !== CACHE_ENTRY_FORMAT_VERSION) throw new TypeError(`cache entry: formatVersion must be ${CACHE_ENTRY_FORMAT_VERSION}`);
  if (!isPlainObject(raw.provenance)) throw new TypeError("cache entry: provenance must be an object");
  const kind = raw.provenance.sourceKind;
  const evidence = kind === "knowledge-source" ? rebuildProviderCatalog(raw.evidence) : rebuildDiscovery(raw.evidence);
  // The result builder checks provenance and observedAt exactly as it does for a live result.
  const result = makeAdapterResult({ status: "ok", evidence, provenance: raw.provenance, observedAt: raw.observedAt });
  if (raw.observedAt === undefined) throw new TypeError("cache entry: observedAt is required");
  if (raw.sourceId !== result.provenance.sourceId) throw new TypeError("cache entry: sourceId must equal provenance.sourceId");
  const entry = makeCacheEntry({ result, request: raw.request, notice: raw.notice });
  if (kind !== "knowledge-source" && (raw.request !== undefined || raw.notice !== undefined)) throw new TypeError("cache entry: only a knowledge-source entry has a request and a notice");
  if (kind === "knowledge-source" && JSON.stringify(entry.request.providers) !== JSON.stringify(raw.request.providers)) {
    throw new TypeError("cache entry: request.providers must be unique and sorted");
  }
  return { entry, result };
}

/**
 * Parse stored entry text and rebuild it, so the read path runs the same validation as a fresh result.
 * Throws on any entry that would not pass.
 * @param {string} text
 * @returns {{entry: CacheEntry, result: any}}
 */
export function parseEntry(text) {
  return entryFromJson(JSON.parse(text));
}

/**
 * Read the entry of one source.
 * @param {string} root
 * @param {string} sourceId
 * @returns {{state: "absent"} | {state: "invalid", code: string, message: string} | {state: "valid", entry: CacheEntry, result: any, bytes: number}}
 */
export function readEntry(root, sourceId) {
  let text;
  try {
    text = nodeFs.readFileSync(entryPath(root, sourceId), "utf8");
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return { state: "absent" };
    return { state: "invalid", code: "unreadable_entry", message: String(/** @type {any} */ (err)?.code ?? err) };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { state: "invalid", code: "malformed_entry", message: "the entry is not JSON" };
  }
  try {
    const { entry, result } = entryFromJson(json);
    if (entry.sourceId !== sourceId) return { state: "invalid", code: "invalid_entry", message: "the entry is filed under another source id" };
    return { state: "valid", entry, result, bytes: Buffer.byteLength(text) };
  } catch (err) {
    return { state: "invalid", code: "invalid_entry", message: /** @type {Error} */ (err).message };
  }
}

/**
 * Write one entry, unless its serialized bytes exceed the OPS-2 per-entry limit.
 * @param {string} root
 * @param {CacheEntry} entry
 * @param {object} [options]
 * @param {number} [options.maxEntryBytes] Defaults to `MAX_CACHE_ENTRY_BYTES`.
 * @returns {{written: true, bytes: number} | {written: false, code: "entry_too_large", bytes: number}}
 */
export function writeEntry(root, entry, { maxEntryBytes = MAX_CACHE_ENTRY_BYTES } = {}) {
  const text = serializeEntry(entry);
  const bytes = Buffer.byteLength(text);
  if (bytes > maxEntryBytes) return { written: false, code: "entry_too_large", bytes };
  const target = entryPath(root, entry.sourceId);
  nodeFs.mkdirSync(join(root, ENTRIES), { recursive: true });
  writeFileAtomic(target, text);
  return { written: true, bytes };
}

/**
 * @typedef {object} Attempt
 * @property {string} attemptedAt
 * @property {string} code
 * @property {string} message
 */

/**
 * Record a failed refresh of one source, beside its entry and never in it (REL-2).
 * @param {string} root
 * @param {string} sourceId
 * @param {Attempt} attempt
 * @returns {void}
 */
export function writeAttempt(root, sourceId, { attemptedAt, code, message }) {
  nodeFs.mkdirSync(join(root, ATTEMPTS), { recursive: true });
  writeFileAtomic(attemptPath(root, sourceId), `${JSON.stringify({ attemptedAt, code, message })}\n`);
}

/**
 * The last failed refresh of one source, or `undefined` when there is none or it cannot be read.
 * @param {string} root
 * @param {string} sourceId
 * @returns {Attempt | undefined}
 */
export function readAttempt(root, sourceId) {
  try {
    const json = JSON.parse(nodeFs.readFileSync(attemptPath(root, sourceId), "utf8"));
    if (!isPlainObject(json) || typeof json.attemptedAt !== "string" || typeof json.code !== "string") return undefined;
    return { attemptedAt: json.attemptedAt, code: json.code, message: typeof json.message === "string" ? json.message : json.code };
  } catch {
    return undefined;
  }
}

/**
 * Remove the failed-attempt record of one source, after a refresh that succeeded.
 * @param {string} root
 * @param {string} sourceId
 * @returns {void}
 */
export function clearAttempt(root, sourceId) {
  nodeFs.rmSync(attemptPath(root, sourceId), { force: true });
}

/**
 * Every regular file under `dir`, with its size and modification time.
 * @param {string} dir
 * @returns {Array<{path: string, bytes: number, mtimeMs: number}>}
 */
function filesUnder(dir) {
  let names;
  try {
    names = nodeFs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.flatMap((d) => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return filesUnder(path);
    if (!d.isFile()) return [];
    try {
      const stat = nodeFs.statSync(path);
      return [{ path, bytes: stat.size, mtimeMs: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
}

/**
 * The bytes the whole cache tree holds. A missing root holds none.
 * @param {string} root
 * @returns {number}
 */
export function cacheTreeBytes(root) {
  return filesUnder(root).reduce((sum, f) => sum + f.bytes, 0);
}

/**
 * Bring the cache tree within the OPS-2 limit, without evicting the last valid evidence of a source.
 *
 * Nothing is removed while the tree is within the limit. Above it, removable files go in this order
 * until the tree fits: the leftovers of an interrupted write or lock recovery that are at least 10
 * minutes old (a younger one may be a write in progress); files outside the cache layout; entries that
 * fail validation; entries and attempt records of a source that `knownSourceIds` does not list. A valid
 * entry of a known source is never removed, so the tree can stay above the limit, and the report says so.
 * @param {string} root
 * @param {object} [options]
 * @param {string[]} [options.knownSourceIds] The sources this build ships. Without it, every valid entry is kept.
 * @param {number} [options.maxTreeBytes] Defaults to `MAX_CACHE_TREE_BYTES`.
 * @param {string} [options.now] ISO 8601; the age of a leftover counts from it.
 * @returns {{totalBytes: number, maxBytes: number, withinLimit: boolean, evicted: string[]}}
 */
export function maintainCache(root, { knownSourceIds, maxTreeBytes = MAX_CACHE_TREE_BYTES, now = new Date().toISOString() } = {}) {
  const files = filesUnder(root);
  let total = files.reduce((sum, f) => sum + f.bytes, 0);
  /** @type {string[]} */
  const evicted = [];
  if (total <= maxTreeBytes) return { totalBytes: total, maxBytes: maxTreeBytes, withinLimit: true, evicted };

  const nowMs = Date.parse(now);
  const known = knownSourceIds === undefined ? undefined : new Set(knownSourceIds);
  const relative = (path) => path.slice(root.length + 1);
  const inDir = (path, dir) => relative(path).startsWith(`${dir}/`) || relative(path).startsWith(`${dir}\\`);
  const sourceOf = (path) => relative(path).slice(relative(path).search(/[/\\]/) + 1).replace(/\.(json|lock)$/, "");
  const interrupted = files.filter((f) => INTERRUPTED_RE.test(f.path));
  const outsideLayout = files.filter(
    (f) =>
      !INTERRUPTED_RE.test(f.path) &&
      !((inDir(f.path, ENTRIES) || inDir(f.path, ATTEMPTS)) && f.path.endsWith(".json") && KEY_RE.test(sourceOf(f.path))) &&
      !(inDir(f.path, LOCKS) && f.path.endsWith(".lock")),
  );
  const entries = files.filter((f) => inDir(f.path, ENTRIES) && f.path.endsWith(".json") && KEY_RE.test(sourceOf(f.path)));
  const candidates = [
    ...interrupted.filter((f) => nowMs - f.mtimeMs >= STALE_LOCK_MIN_AGE_MS),
    ...outsideLayout,
    ...entries.filter((f) => readEntry(root, sourceOf(f.path)).state !== "valid"),
    ...(known === undefined ? [] : files.filter((f) => (inDir(f.path, ENTRIES) || inDir(f.path, ATTEMPTS)) && f.path.endsWith(".json") && !known.has(sourceOf(f.path)))),
  ];
  for (const file of candidates) {
    if (total <= maxTreeBytes) break;
    if (evicted.includes(relative(file.path))) continue;
    try {
      nodeFs.unlinkSync(file.path);
    } catch {
      continue;
    }
    total -= file.bytes;
    evicted.push(relative(file.path));
  }
  return { totalBytes: total, maxBytes: maxTreeBytes, withinLimit: total <= maxTreeBytes, evicted };
}
