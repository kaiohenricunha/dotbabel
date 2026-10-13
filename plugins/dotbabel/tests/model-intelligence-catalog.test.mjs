import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as modelsDev from "../src/model-intelligence/sources/knowledge/models-dev.mjs";
import { cacheDir } from "../src/lib/paths.mjs";
import { PROVIDERS } from "../src/model-intelligence/domain/index.mjs";
import { MAX_CACHE_ENTRY_BYTES, makeAdapterResult } from "../src/model-intelligence/sources/contract.mjs";
import { makeDiscoveryEvidence, makeModelFact, makeProviderCatalogEvidence } from "../src/model-intelligence/sources/evidence.mjs";
import {
  CACHE_SUBDIR,
  MAX_CACHE_TREE_BYTES,
  cacheRoot,
  entryPath,
  lockPathFor,
  maintainCache,
  makeCacheEntry,
  parseEntry,
  readEntry,
  serializeEntry,
  writeEntry,
  writeFileAtomic,
} from "../src/model-intelligence/catalog/cache.mjs";
import { STALE_LOCK_MIN_AGE_MS, acquireLock, judgeLock, readLockOwner } from "../src/model-intelligence/catalog/lock.mjs";
import {
  EVIDENCE_CLASSES,
  buildCatalog,
  catalogStatus,
  checkAdapterResult,
  deriveFreshness,
  freshnessPolicyFor,
  loadCatalog,
  refreshSource,
  refreshSources,
} from "../src/model-intelligence/catalog/index.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const REPO_ROOT = join(PLUGIN_ROOT, "..", "..");
const FIXTURE_DIR = join(HERE, "fixtures", "model-intelligence");
const RECORDED = readFileSync(join(FIXTURE_DIR, "models-dev", "api.json"));

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const T0 = "2026-10-13T12:00:00.000Z";
/** The ISO time `ms` after T0. */
const at = (ms) => new Date(Date.parse(T0) + ms).toISOString();
/** A clock that always answers `iso`. */
const clockAt = (iso) => () => iso;

const roots = [];
/** A fresh capability-cache root in the system temp directory, removed after the test. */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), "mi-catalog-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One model fact. Every fact needs a `supportedReasoningLevels` list, so it defaults to none. */
const fact = (fields) => makeModelFact({ supportedReasoningLevels: [], ...fields });

/** Knowledge-source evidence: `[{id, sourceKey?, models: [fields]}]`, plus an optional etag. */
function catalogEvidence(providers, { etag, missingProviders = [] } = {}) {
  return makeProviderCatalogEvidence({
    providers: providers.map(({ id, sourceKey, models }) => ({ id, ...(sourceKey ? { sourceKey } : {}), discovery: makeDiscoveryEvidence({ models: models.map(fact) }) })),
    missingProviders,
    ...(etag === undefined ? {} : { etag }),
  });
}

/** An `ok` result of a knowledge source. */
const knowledgeOk = (sourceId, evidence, observedAt, adapterVersion = "1") =>
  makeAdapterResult({ status: "ok", evidence, provenance: { sourceId, sourceKind: "knowledge-source", adapterVersion }, observedAt });

/** An `ok` result of a runtime's discovery. */
const runtimeOk = (sourceId, models, observedAt) =>
  makeAdapterResult({ status: "ok", evidence: makeDiscoveryEvidence({ models: models.map(fact) }), provenance: { sourceId, sourceKind: "runtime", adapterVersion: "1" }, observedAt });

/** A failed result of `kind`, with a diagnostic `code`. */
const failed = (sourceId, sourceKind, status, code, observedAt) =>
  makeAdapterResult({ status, provenance: { sourceId, sourceKind, adapterVersion: "1" }, observedAt, diagnostic: { code, message: code } });

/** A knowledge-source module double whose `discover` answers `script(ctx)`. */
function knowledgeModule(id, script, options = {}) {
  const { adapterVersion = "1" } = options;
  return {
    descriptor: { id, kind: "knowledge-source", capabilities: { discovery: { support: "supported", network: "required", auth: "none", cacheable: true, execution: "read-only" } } },
    ADAPTER_VERSION: adapterVersion,
    // `in`, not a default: a test passes `notice: undefined` to model an adapter that exports none.
    notice: "notice" in options ? options.notice : "Data from the fake catalog. MIT License.",
    discover: vi.fn(async (ctx) => script(ctx)),
  };
}

/** A runtime module double whose `discover` answers `script(ctx)`. */
function runtimeModule(id, script) {
  return {
    descriptor: { id, kind: "runtime", capabilities: { discovery: { support: "supported", network: "never", auth: "none", cacheable: true, execution: "read-only" } } },
    ADAPTER_VERSION: "1",
    discover: vi.fn(async (ctx) => script(ctx)),
  };
}

const ANTHROPIC_ONLY = [{ id: "anthropic", models: [{ id: "claude-x", displayName: "Claude X", contextWindow: 200000 }] }];

/** Refresh one knowledge source once, so the cache holds a valid entry observed at `observedAt`. */
async function seed(root, id = "fake-catalog", observedAt = T0, providers = ANTHROPIC_ONLY, options = {}) {
  const module = knowledgeModule(id, () => knowledgeOk(id, catalogEvidence(providers, options), observedAt));
  const outcome = await refreshSource({ module, context: { providers: ["anthropic"] } }, { root, now: clockAt(observedAt) });
  expect(outcome.outcome).toBe("refreshed");
  return module;
}

/** The deterministic PRNG the payload-compression test uses, so a property run is reproducible. */
function mulberry32(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("model-intelligence catalog normalization (P-9)", () => {
  it("merges two sources for one model and keeps a separate provenance for each field", () => {
    const fromCatalog = knowledgeOk("models-dev", catalogEvidence([{ id: "anthropic", models: [{ id: "claude-x", displayName: "Claude X", contextWindow: 200000 }] }]), T0);
    const fromOfficial = knowledgeOk("anthropic-api", catalogEvidence([{ id: "anthropic", models: [{ id: "claude-x", contextWindow: 1000000 }] }]), at(HOUR));
    const catalog = buildCatalog([
      { result: fromCatalog, freshness: "fresh", refresh: "idle" },
      { result: fromOfficial, freshness: "stale", refresh: "in_progress" },
    ]);

    expect(catalog.models).toHaveLength(1);
    const [record] = catalog.models;
    expect(record).toMatchObject({ provider: "anthropic", model: "claude-x", joined: true });
    // Two sources disagree on the context window. Both facts stay, each with its own source (ARCH-28).
    expect(record.fields.contextWindow.map((e) => [e.value, e.provenance.sourceId])).toEqual([
      [200000, "models-dev"],
      [1000000, "anthropic-api"],
    ]);
    // Only one source stated a display name, so only one fact exists for that field.
    expect(record.fields.displayName.map((e) => e.provenance.sourceId)).toEqual(["models-dev"]);
    // Every fact is a full catalog envelope that carries its own source's state.
    expect(record.fields.contextWindow[0]).toEqual({
      value: 200000,
      provenance: { sourceId: "models-dev", sourceKind: "knowledge-source", adapterVersion: "1" },
      observedAt: T0,
      freshness: "fresh",
      confidence: "high",
      availability: "unknown",
      refresh: "idle",
    });
    expect(record.fields.contextWindow[1]).toMatchObject({ observedAt: at(HOUR), freshness: "stale", confidence: "medium", refresh: "in_progress" });
    // Presence in a knowledge source is never proof that a model can be invoked (ARCH-14).
    expect(record.fields.contextWindow.every((e) => e.availability === "unknown")).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(record.fields.contextWindow[0])).toBe(true);

    // A runtime's discovery is about that runtime, so it lands under the runtime, not under a provider.
    const runtime = buildCatalog([{ result: runtimeOk("codex", [{ id: "gpt-x", contextWindow: 400000 }], T0), freshness: "fresh", refresh: "idle" }]);
    expect(runtime.models).toEqual([]);
    expect(runtime.runtimes).toHaveLength(1);
    expect(runtime.runtimes[0].runtimeId).toBe("codex");
    expect(runtime.runtimes[0].models[0].model).toBe("gpt-x");
    expect(runtime.runtimes[0].models[0].fields.contextWindow[0]).toMatchObject({ value: 400000, availability: "available" });
  });

  it("joins facts from two sources only under a PROVIDERS id, and never joins a source-scoped id such as models-dev.xai", () => {
    expect(PROVIDERS).toContain("anthropic");
    const a = knowledgeOk(
      "models-dev",
      catalogEvidence([
        { id: "anthropic", models: [{ id: "shared", contextWindow: 1 }] },
        { id: "models-dev.xai", sourceKey: "xai", models: [{ id: "grok", contextWindow: 2 }] },
      ]),
      T0,
    );
    // A second source that emits the SAME scoped string still never joins it: only a PROVIDERS id is a join key.
    const b = knowledgeOk(
      "other-catalog",
      catalogEvidence([
        { id: "anthropic", models: [{ id: "shared", contextWindow: 3 }] },
        { id: "models-dev.xai", models: [{ id: "grok", contextWindow: 4 }] },
      ]),
      T0,
    );
    const catalog = buildCatalog([
      { result: a, freshness: "fresh", refresh: "idle" },
      { result: b, freshness: "fresh", refresh: "idle" },
    ]);
    const joined = catalog.models.filter((r) => r.provider === "anthropic");
    expect(joined).toHaveLength(1);
    expect(joined[0].joined).toBe(true);
    expect(joined[0].fields.contextWindow.map((e) => e.value)).toEqual([1, 3]);

    const scoped = catalog.models.filter((r) => r.provider === "models-dev.xai");
    expect(scoped).toHaveLength(2);
    expect(scoped.map((r) => [r.joined, r.sourceId, r.fields.contextWindow.length])).toEqual([
      [false, "models-dev", 1],
      [false, "other-catalog", 1],
    ]);
    // The source key stays with the scoped record, so a person can trace it back (ARCH-28).
    expect(scoped[0].sourceKey).toBe("xai");
  });
});

describe("model-intelligence catalog loading (P-9)", () => {
  it("loadCatalog builds the catalog from every valid entry, with its freshness at now, and skips a source without one", async () => {
    const root = tempRoot();
    const catalogSource = knowledgeModule("fake-catalog", () => knowledgeOk("fake-catalog", catalogEvidence(ANTHROPIC_ONLY), T0));
    const runtime = runtimeModule("codex", () => runtimeOk("codex", [{ id: "gpt-x" }], T0));
    const broken = runtimeModule("broken", () => failed("broken", "runtime", "unavailable", "binary_missing", T0));
    const outcomes = await refreshSources(
      [{ module: catalogSource, context: { providers: ["anthropic"] } }, { module: runtime }, { module: broken }],
      { root, now: clockAt(T0) },
    );
    // One source's failure never stops the others.
    expect(outcomes.map((o) => o.outcome)).toEqual(["refreshed", "refreshed", "failed"]);
    const sources = [{ module: catalogSource }, { module: runtime }, { module: broken }];
    // Eight hours later the runtime evidence is stale (6 h window) and the catalog evidence fresh (24 h).
    const catalog = loadCatalog({ root, sources, now: at(8 * HOUR) });
    expect(catalog.sources.map((s) => [s.sourceId, s.freshness, s.refresh])).toEqual([
      ["fake-catalog", "fresh", "idle"],
      ["codex", "stale", "idle"],
    ]);
    expect(catalog.models[0].fields.contextWindow[0]).toMatchObject({ value: 200000, freshness: "fresh", confidence: "high" });
    expect(catalog.runtimes[0].models[0].fields.supportedReasoningLevels[0]).toMatchObject({ value: [], freshness: "stale", confidence: "medium" });
    // Reading takes no lock (ARCH-60), so a refresh held elsewhere shows as in_progress without blocking.
    const held = acquireLock(lockPathFor(root, "codex"), { resource: "codex", now: () => Date.parse(at(8 * HOUR)) });
    try {
      expect(loadCatalog({ root, sources, now: at(8 * HOUR) }).sources[1].refresh).toBe("in_progress");
    } finally {
      held.release();
    }
  });
});

describe("model-intelligence catalog freshness (P-9)", () => {
  it("derives freshness from observedAt, source policy, and an injected now", () => {
    const policy = freshnessPolicyFor({ descriptor: { id: "s", kind: "knowledge-source" }, freshnessPolicy: { staleAfterMs: HOUR, expireAfterMs: 2 * HOUR, reason: "the source republishes every hour" } });
    // The override and its reason are exposed, never applied silently (REL-4 override rule).
    expect(policy).toEqual({ evidenceClass: "broad-catalog", staleAfterMs: HOUR, expireAfterMs: 2 * HOUR, override: { reason: "the source republishes every hour" } });
    expect(deriveFreshness({ observedAt: T0, policy, now: at(HOUR) })).toBe("fresh");
    expect(deriveFreshness({ observedAt: T0, policy, now: at(HOUR + 1) })).toBe("stale");
    expect(deriveFreshness({ observedAt: T0, policy, now: at(2 * HOUR + 1) })).toBe("expired");
    // The same evidence under the default broad-catalog policy is still fresh: the policy decides.
    const defaults = freshnessPolicyFor({ descriptor: { id: "s", kind: "knowledge-source" } });
    expect(deriveFreshness({ observedAt: T0, policy: defaults, now: at(2 * HOUR + 1) })).toBe("fresh");
    // No valid observation time, or one in the future, gives `unknown`, never `fresh`.
    expect(deriveFreshness({ observedAt: undefined, policy, now: at(0) })).toBe("unknown");
    expect(deriveFreshness({ observedAt: "yesterday", policy, now: at(0) })).toBe("unknown");
    expect(deriveFreshness({ observedAt: at(MINUTE), policy, now: at(0) })).toBe("unknown");
    // An override without a documented reason, or with a window that cannot hold, is refused.
    expect(() => freshnessPolicyFor({ descriptor: { id: "s", kind: "runtime" }, freshnessPolicy: { staleAfterMs: HOUR, expireAfterMs: 2 * HOUR } })).toThrow(TypeError);
    expect(() => freshnessPolicyFor({ descriptor: { id: "s", kind: "runtime" }, freshnessPolicy: { staleAfterMs: 2 * HOUR, expireAfterMs: HOUR, reason: "r" } })).toThrow(TypeError);
  });

  it("applies the REL-4 default windows per evidence class when a source declares none, and never reports expired evidence as fresh after a failed refresh", async () => {
    expect(EVIDENCE_CLASSES).toEqual({
      "runtime-discovery": { staleAfterMs: 6 * HOUR, expireAfterMs: 24 * HOUR },
      "runtime-observation": { staleAfterMs: 15 * MINUTE, expireAfterMs: HOUR },
      "provider-api": { staleAfterMs: 6 * HOUR, expireAfterMs: 24 * HOUR },
      "broad-catalog": { staleAfterMs: 24 * HOUR, expireAfterMs: 7 * 24 * HOUR },
    });
    const cases = [
      [{ descriptor: { id: "codex", kind: "runtime" } }, "runtime-discovery"],
      [{ descriptor: { id: "codex", kind: "runtime" }, evidenceClass: "runtime-observation" }, "runtime-observation"],
      [{ descriptor: { id: "anthropic-api", kind: "knowledge-source" }, evidenceClass: "provider-api" }, "provider-api"],
      [{ descriptor: { id: "models-dev", kind: "knowledge-source" } }, "broad-catalog"],
    ];
    for (const [module, evidenceClass] of cases) {
      const policy = freshnessPolicyFor(module);
      const { staleAfterMs, expireAfterMs } = EVIDENCE_CLASSES[evidenceClass];
      expect(policy).toEqual({ evidenceClass, staleAfterMs, expireAfterMs });
      // Boundaries: age equal to a threshold is still the earlier state (REL-4 uses <=).
      expect(deriveFreshness({ observedAt: T0, policy, now: at(0) })).toBe("fresh");
      expect(deriveFreshness({ observedAt: T0, policy, now: at(staleAfterMs) })).toBe("fresh");
      expect(deriveFreshness({ observedAt: T0, policy, now: at(staleAfterMs + 1) })).toBe("stale");
      expect(deriveFreshness({ observedAt: T0, policy, now: at(expireAfterMs) })).toBe("stale");
      expect(deriveFreshness({ observedAt: T0, policy, now: at(expireAfterMs + 1) })).toBe("expired");
    }
    expect(() => freshnessPolicyFor({ descriptor: { id: "x", kind: "runtime" }, evidenceClass: "gossip" })).toThrow(TypeError);

    // A failed refresh after the observation demotes fresh to stale, and leaves expired as expired.
    const policy = freshnessPolicyFor({ descriptor: { id: "models-dev", kind: "knowledge-source" } });
    expect(deriveFreshness({ observedAt: T0, policy, now: at(HOUR), failedAttemptAt: at(HOUR) })).toBe("stale");
    expect(deriveFreshness({ observedAt: T0, policy, now: at(8 * 24 * HOUR), failedAttemptAt: at(8 * 24 * HOUR) })).toBe("expired");
    // A failure from before the observation says nothing about the newer evidence.
    expect(deriveFreshness({ observedAt: at(HOUR), policy, now: at(2 * HOUR), failedAttemptAt: T0 })).toBe("fresh");

    // End to end: expired evidence plus a failed refresh is reported expired, never fresh.
    const root = tempRoot();
    await seed(root);
    const later = at(8 * 24 * HOUR);
    const module = knowledgeModule("fake-catalog", () => failed("fake-catalog", "knowledge-source", "unavailable", "network_unavailable", later));
    const outcome = await refreshSource({ module, context: { providers: ["anthropic"] } }, { root, now: clockAt(later) });
    expect(outcome.outcome).toBe("failed");
    expect(outcome.cached.freshness).toBe("expired");
    const status = catalogStatus({ root, sources: [{ module }], now: later });
    expect(status.sources[0].cache.freshness).toBe("expired");
  });
});

describe("model-intelligence capability cache (P-9)", () => {
  it("writes the cache with temp file plus atomic rename under cacheDir()/model-intelligence", async () => {
    const home = tempRoot();
    const env = { XDG_CACHE_HOME: join(home, "xdg-cache") };
    expect(CACHE_SUBDIR).toBe("model-intelligence");
    expect(cacheRoot(env)).toBe(join(cacheDir(env), "model-intelligence"));

    // The primitive: write the whole candidate to <target>.<pid>.<nonce>.tmp, flush, close, then rename (ARCH-59).
    const target = join(home, "entry.json");
    const calls = [];
    const record = (name, fn) => (...args) => {
      calls.push([name, ...args.filter((a) => typeof a === "string")]);
      return fn(...args);
    };
    writeFileAtomic(target, '{"a":1}\n', {
      openSync: record("open", fs.openSync),
      writeSync: record("write", fs.writeSync),
      fsyncSync: record("fsync", fs.fsyncSync),
      closeSync: record("close", fs.closeSync),
      renameSync: record("rename", fs.renameSync),
      unlinkSync: record("unlink", fs.unlinkSync),
    });
    const tmp = calls[0][1];
    expect(tmp).toMatch(new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.${process.pid}\\.[0-9a-f]{16}\\.tmp$`));
    expect(calls.map((c) => c[0])).toEqual(["open", "write", "fsync", "close", "rename"]);
    expect(calls.at(-1)).toEqual(["rename", tmp, target]);
    expect(readFileSync(target, "utf8")).toBe('{"a":1}\n');
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // A write that fails leaves the target untouched and removes its temp file.
    expect(() => writeFileAtomic(target, "{}\n", { ...fs, renameSync: () => { throw new Error("disk full"); } })).toThrow("disk full");
    expect(readFileSync(target, "utf8")).toBe('{"a":1}\n');
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // A refresh lands its entry under the root that cacheDir() names, and leaves no temp file.
    const root = cacheRoot(env);
    await seed(root);
    expect(existsSync(entryPath(root, "fake-catalog"))).toBe(true);
    expect(entryPath(root, "fake-catalog")).toBe(join(cacheDir(env), "model-intelligence", "entries", "fake-catalog.json"));
    const leftovers = readdirSync(join(root, "entries")).filter((f) => f !== "fake-catalog.json");
    expect(leftovers).toEqual([]);
  });

  it("a knowledge-source cache entry is stored with its adapter's notice export", async () => {
    const root = tempRoot();
    const fetch = async () => new Response(RECORDED, { status: 200, headers: { "content-type": "application/json" } });
    const outcome = await refreshSource({ module: modelsDev, context: { providers: ["anthropic", "openai"], fetch, now: clockAt(T0) } }, { root, now: clockAt(T0) });
    expect(outcome.outcome).toBe("refreshed");
    const stored = JSON.parse(readFileSync(entryPath(root, "models-dev"), "utf8"));
    expect(stored.notice).toBe(modelsDev.notice);
    expect(stored.notice).toContain("MIT License");

    // A runtime entry has no license to honor, so it carries no notice.
    await refreshSource({ module: runtimeModule("codex", () => runtimeOk("codex", [{ id: "gpt-x" }], T0)) }, { root, now: clockAt(T0) });
    expect(JSON.parse(readFileSync(entryPath(root, "codex"), "utf8"))).not.toHaveProperty("notice");

    // A knowledge adapter that exports no notice breaks the contract, so nothing is stored.
    const silent = knowledgeModule("silent", () => knowledgeOk("silent", catalogEvidence(ANTHROPIC_ONLY), T0), { notice: undefined });
    const refused = await refreshSource({ module: silent, context: { providers: ["anthropic"] } }, { root, now: clockAt(T0) });
    expect(refused).toMatchObject({ outcome: "failed", diagnostic: { code: "adapter_contract_breach" } });
    expect(existsSync(entryPath(root, "silent"))).toBe(false);
  });

  it("refuses a serialized cache entry above MAX_CACHE_ENTRY_BYTES, envelope and notice included", async () => {
    expect(MAX_CACHE_ENTRY_BYTES).toBe(8 * 1024 * 1024);
    const evidence = catalogEvidence(ANTHROPIC_ONLY);
    const evidenceBytes = Buffer.byteLength(JSON.stringify(evidence));
    const result = knowledgeOk("fake-catalog", evidence, T0);
    const notice = "N".repeat(2000);
    const entry = makeCacheEntry({ result, request: { providers: ["anthropic"] }, notice });
    const text = serializeEntry(entry);
    // The evidence alone fits; the envelope and the notice push the entry over the limit.
    const limit = evidenceBytes + 100;
    expect(Buffer.byteLength(text)).toBeGreaterThan(limit);
    const root = tempRoot();
    expect(writeEntry(root, entry, { maxEntryBytes: limit })).toMatchObject({ written: false, code: "entry_too_large" });
    expect(existsSync(entryPath(root, "fake-catalog"))).toBe(false);
    expect(writeEntry(root, entry, { maxEntryBytes: Buffer.byteLength(text) })).toMatchObject({ written: true });

    // Through a refresh, an oversized candidate is not committed and the previous entry stays.
    const other = tempRoot();
    await seed(other);
    const before = readFileSync(entryPath(other, "fake-catalog"));
    const big = knowledgeModule("fake-catalog", () => knowledgeOk("fake-catalog", catalogEvidence([{ id: "anthropic", models: [{ id: "claude-y" }] }]), at(HOUR)), { notice });
    const outcome = await refreshSource({ module: big, context: { providers: ["anthropic"] } }, { root: other, now: clockAt(at(HOUR)), maxEntryBytes: limit });
    expect(outcome).toMatchObject({ outcome: "failed", diagnostic: { code: "entry_too_large" } });
    expect(readFileSync(entryPath(other, "fake-catalog")).equals(before)).toBe(true);
  });

  it("rebuilds cached knowledge-source evidence from JSON through the evidence builders, so the cache read path runs the same validation", async () => {
    const root = tempRoot();
    await seed(root, "fake-catalog", T0, [{ id: "anthropic", models: [{ id: "claude-x", contextWindow: 200000 }] }], { etag: '"v1"' });
    const read = readEntry(root, "fake-catalog");
    expect(read.state).toBe("valid");
    expect(read.result.status).toBe("ok");
    expect(read.result.evidence.providers[0].discovery.models[0]).toMatchObject({ id: "claude-x", contextWindow: 200000 });
    expect(read.result.evidence.etag).toBe('"v1"');
    // Only discovery evidence that makeDiscoveryEvidence built is accepted by the provider builder, so
    // this call proves the read path rebuilt it rather than passing parsed JSON through.
    expect(() => makeProviderCatalogEvidence({ providers: [{ id: "anthropic", discovery: read.result.evidence.providers[0].discovery }], missingProviders: [] })).not.toThrow();

    // A field no builder accepts, such as a stated availability, makes the entry invalid on read.
    const path = entryPath(root, "fake-catalog");
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.evidence.providers[0].discovery.models[0].available = true;
    writeFileSync(path, JSON.stringify(tampered));
    expect(readEntry(root, "fake-catalog")).toMatchObject({ state: "invalid" });
    // So do a provider id outside the charset, a bad observedAt, and an entry filed under another key.
    for (const mutate of [
      (e) => (e.evidence.providers[0].id = "Anthropic"),
      (e) => (e.observedAt = "not a time"),
      (e) => (e.sourceId = "someone-else"),
      (e) => (e.format = "something-else"),
    ]) {
      const copy = JSON.parse(serializeEntry(parseEntry(serializeEntry(makeCacheEntry({ result: read.result, request: { providers: ["anthropic"] }, notice: "n" }))).entry));
      mutate(copy);
      writeFileSync(path, JSON.stringify(copy));
      expect(readEntry(root, "fake-catalog").state).toBe("invalid");
    }
    writeFileSync(path, "{ not json");
    expect(readEntry(root, "fake-catalog")).toMatchObject({ state: "invalid", code: "malformed_entry" });
    expect(readEntry(root, "absent-source")).toEqual({ state: "absent" });
  });

  it("keeps the cache tree at or under 64 MiB after maintenance without evicting the last valid evidence, and refuses an entry above 8 MiB", async () => {
    expect(MAX_CACHE_TREE_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_CACHE_ENTRY_BYTES).toBe(8 * 1024 * 1024);
    // The limits are injected small here, so the test does not write 64 MiB to the disk.
    const root = tempRoot();
    await seed(root, "fake-catalog");
    const valid = readFileSync(entryPath(root, "fake-catalog"));
    const entries = join(root, "entries");
    writeFileSync(join(entries, "broken.json"), "x".repeat(4000));
    writeFileSync(join(entries, "retired-source.json"), serializeEntry(makeCacheEntry({ result: knowledgeOk("retired-source", catalogEvidence(ANTHROPIC_ONLY), T0), request: { providers: ["anthropic"] }, notice: "n" })));
    const oldTmp = join(entries, `fake-catalog.json.4242.${"a".repeat(16)}.tmp`);
    writeFileSync(oldTmp, "y".repeat(4000));
    const old = (Date.parse(T0) - 11 * MINUTE) / 1000;
    utimesSync(oldTmp, old, old);
    const youngTmp = join(entries, `fake-catalog.json.4243.${"b".repeat(16)}.tmp`);
    writeFileSync(youngTmp, "z".repeat(10));
    const recent = (Date.parse(T0) - MINUTE) / 1000;
    utimesSync(youngTmp, recent, recent);
    writeFileSync(join(root, "stray.bin"), "s".repeat(4000));

    // Room for the valid entry and the write in progress only, so every removable file must go.
    const limit = valid.length + 20;
    const report = maintainCache(root, { knownSourceIds: ["fake-catalog"], maxTreeBytes: limit, now: T0 });
    expect(report.withinLimit).toBe(true);
    expect(report.totalBytes).toBeLessThanOrEqual(limit);
    // The last valid evidence of a known source is never evicted, and neither is a write in progress.
    expect(readFileSync(entryPath(root, "fake-catalog")).equals(valid)).toBe(true);
    expect(existsSync(youngTmp)).toBe(true);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(join(entries, "broken.json"))).toBe(false);
    expect(existsSync(join(entries, "retired-source.json"))).toBe(false);
    expect(existsSync(join(root, "stray.bin"))).toBe(false);

    // When only valid evidence remains above the limit, it stays, and the report says the limit is breached.
    const tight = maintainCache(root, { knownSourceIds: ["fake-catalog"], maxTreeBytes: 10, now: T0 });
    expect(tight.withinLimit).toBe(false);
    expect(readFileSync(entryPath(root, "fake-catalog")).equals(valid)).toBe(true);
    // Under the limit, maintenance removes nothing, not even an entry it does not know.
    writeFileSync(join(entries, "unknown.json"), "{}");
    expect(maintainCache(root, { knownSourceIds: ["fake-catalog"], maxTreeBytes: 10 * 1024 * 1024, now: T0 }).evicted).toEqual([]);
    expect(existsSync(join(entries, "unknown.json"))).toBe(true);

    // An entry above the per-entry limit is refused before it is written.
    const entry = makeCacheEntry({ result: knowledgeOk("big", catalogEvidence(ANTHROPIC_ONLY), T0), request: { providers: ["anthropic"] }, notice: "n" });
    expect(writeEntry(root, entry, { maxEntryBytes: 64 })).toMatchObject({ written: false, code: "entry_too_large" });
    expect(existsSync(entryPath(root, "big"))).toBe(false);
  });
});

describe("model-intelligence refresh coordination (P-9)", () => {
  it("a failed or empty refresh preserves the previous valid cache and marks it stale", async () => {
    const root = tempRoot();
    await seed(root);
    const path = entryPath(root, "fake-catalog");
    const before = readFileSync(path);
    const later = at(HOUR);
    const failures = [
      () => failed("fake-catalog", "knowledge-source", "unavailable", "network_unavailable", later),
      () => failed("fake-catalog", "knowledge-source", "unknown", "empty_output", later),
      // An `ok` with nothing in it is still empty, never an empty catalog (ARCH-30).
      () => knowledgeOk("fake-catalog", makeProviderCatalogEvidence({ providers: [], missingProviders: ["anthropic"] }), later),
      () => {
        throw new Error("adapter crashed");
      },
    ];
    for (const script of failures) {
      const module = knowledgeModule("fake-catalog", script);
      const outcome = await refreshSource({ module, context: { providers: ["anthropic"] } }, { root, now: clockAt(later) });
      expect(outcome.outcome).toBe("failed");
      expect(outcome.diagnostic.code).toMatch(/^[a-z_]+$/);
      // The entry is byte-for-byte what it was, and the caller gets the retained evidence separately (REL-2).
      expect(readFileSync(path).equals(before)).toBe(true);
      // One hour into a 24-hour window would be fresh; the failed refresh marks it stale (ARCH-30).
      expect(outcome.cached).toMatchObject({ observedAt: T0, freshness: "stale" });
      expect(catalogStatus({ root, sources: [{ module }], now: later }).sources[0].cache.freshness).toBe("stale");
    }
    // A later successful refresh clears the mark.
    const recovered = knowledgeModule("fake-catalog", () => knowledgeOk("fake-catalog", catalogEvidence(ANTHROPIC_ONLY), at(2 * HOUR)));
    expect((await refreshSource({ module: recovered, context: { providers: ["anthropic"] } }, { root, now: clockAt(at(2 * HOUR)) })).outcome).toBe("refreshed");
    expect(catalogStatus({ root, sources: [{ module: recovered }], now: at(2 * HOUR) }).sources[0].cache.freshness).toBe("fresh");
  });

  it("the second concurrent refresh of one key does not start and reports refresh in_progress", async () => {
    const root = tempRoot();
    const module = knowledgeModule("fake-catalog", () => knowledgeOk("fake-catalog", catalogEvidence(ANTHROPIC_ONLY), T0));
    // Another process holds the refresh lock of this key.
    const held = acquireLock(lockPathFor(root, "fake-catalog"), { resource: "fake-catalog", now: () => Date.parse(T0) });
    expect(held.acquired).toBe(true);
    try {
      const outcome = await refreshSource({ module, context: { providers: ["anthropic"] } }, { root, now: clockAt(T0) });
      expect(module.discover).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ outcome: "in_progress", refresh: "in_progress", cached: null });
      expect(catalogStatus({ root, sources: [{ module }], now: T0 }).sources[0].refresh).toBe("in_progress");
    } finally {
      held.release();
    }
    // With a usable cache, the losing caller gets that cache and its real freshness instead.
    await seed(root);
    const again = acquireLock(lockPathFor(root, "fake-catalog"), { resource: "fake-catalog", now: () => Date.parse(T0) });
    try {
      const outcome = await refreshSource({ module, context: { providers: ["anthropic"] } }, { root, now: clockAt(at(30 * HOUR)) });
      expect(outcome).toMatchObject({ outcome: "in_progress", refresh: "in_progress", cached: { observedAt: T0, freshness: "stale" } });
    } finally {
      again.release();
    }
    expect(existsSync(lockPathFor(root, "fake-catalog"))).toBe(false);
  });

  it("many simultaneous refreshes of one key run exactly one discovery", async () => {
    const root = tempRoot();
    const work = tempRoot();
    const counter = join(work, "discoveries");
    const go = join(work, "go");
    const child = join(FIXTURE_DIR, "catalog", "refresh-child.mjs");
    const n = 6;
    const runs = Array.from({ length: n }, (_, i) =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [child, root, counter, go, join(work, `ready-${i}`)], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        proc.stdout.on("data", (d) => (out += d));
        proc.stderr.on("data", (d) => (err += d));
        proc.on("error", reject);
        proc.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}: ${err}`))));
      }),
    );
    // A barrier: every child is started and waiting before any of them tries the lock.
    const deadline = Date.now() + 20_000;
    while (readdirSync(work).filter((f) => f.startsWith("ready-")).length < n) {
      if (Date.now() > deadline) throw new Error("children did not start");
      await new Promise((r) => setTimeout(r, 10));
    }
    writeFileSync(go, "");
    const outcomes = (await Promise.all(runs)).map((o) => o.outcome).sort();
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
    expect(outcomes).toEqual(["in_progress", "in_progress", "in_progress", "in_progress", "in_progress", "refreshed"]);
    expect(readEntry(root, "torture").state).toBe("valid");
    expect(existsSync(lockPathFor(root, "torture"))).toBe(false);
  }, 60_000);

  it("for any order of refresh outcomes, a failed, malformed, empty, or older candidate never replaces a structurally valid newer entry", async () => {
    const rand = mulberry32(2610);
    const kinds = ["ok", "older", "unavailable", "unknown", "empty", "malformed", "throws"];
    for (let run = 0; run < 60; run += 1) {
      const root = tempRoot();
      // Candidate observation times sit in 2026; the refresh clock runs in 2027, so no candidate looks concurrent.
      let clock = Date.parse("2027-01-01T00:00:00.000Z");
      /** @type {{observedAt: number, contextWindow: number} | null} */
      let newest = null;
      const length = 1 + Math.floor(rand() * 8);
      for (let step = 0; step < length; step += 1) {
        const kind = kinds[Math.floor(rand() * kinds.length)];
        let observed = Date.parse(T0) + Math.floor(rand() * 1000) * MINUTE;
        if (kind === "older" && newest !== null) observed = newest.observedAt - (1 + Math.floor(rand() * 100)) * MINUTE;
        const observedAt = new Date(observed).toISOString();
        const contextWindow = 1 + Math.floor(rand() * 1_000_000);
        const script = {
          ok: () => knowledgeOk("prop", catalogEvidence([{ id: "anthropic", models: [{ id: "m", contextWindow }] }]), observedAt),
          older: () => knowledgeOk("prop", catalogEvidence([{ id: "anthropic", models: [{ id: "m", contextWindow }] }]), observedAt),
          unavailable: () => failed("prop", "knowledge-source", "unavailable", "timeout", observedAt),
          unknown: () => failed("prop", "knowledge-source", "unknown", "malformed_output", observedAt),
          empty: () => knowledgeOk("prop", makeProviderCatalogEvidence({ providers: [], missingProviders: ["anthropic"] }), observedAt),
          // Evidence no builder made: the adapter result accepts it, the cache does not.
          malformed: () => makeAdapterResult({ status: "ok", evidence: { providers: "everything" }, provenance: { sourceId: "prop", sourceKind: "knowledge-source", adapterVersion: "1" }, observedAt }),
          throws: () => {
            throw new Error("boom");
          },
        }[kind];
        clock += MINUTE;
        const now = new Date(clock).toISOString();
        const module = knowledgeModule("prop", script);
        await refreshSource({ module, context: { providers: ["anthropic"] } }, { root, now: () => now });
        const accepted = (kind === "ok" || kind === "older") && (newest === null || observed >= newest.observedAt);
        if (accepted) newest = { observedAt: observed, contextWindow };
        const read = readEntry(root, "prop");
        if (newest === null) {
          expect(read.state).toBe("absent");
        } else {
          expect(read.state).toBe("valid");
          expect(Date.parse(read.result.observedAt)).toBe(newest.observedAt);
          expect(read.result.evidence.providers[0].discovery.models[0].contextWindow).toBe(newest.contextWindow);
        }
      }
    }
  });

  it("with the network down and no cache, a Dotbabel command outside Model Intelligence behaves as before", () => {
    // Statically: no bin but dotbabel-models, and no module outside model-intelligence/, reaches the catalog.
    const bins = readdirSync(join(PLUGIN_ROOT, "bin")).filter((f) => f.endsWith(".mjs") && f !== "dotbabel-models.mjs");
    for (const bin of bins) expect(readFileSync(join(PLUGIN_ROOT, "bin", bin), "utf8")).not.toMatch(/model-intelligence\/catalog/);
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === "model-intelligence" ? [] : walk(join(dir, d.name))) : d.name.endsWith(".mjs") ? [join(dir, d.name)] : []));
    for (const file of walk(join(PLUGIN_ROOT, "src"))) expect(readFileSync(file, "utf8")).not.toMatch(/model-intelligence\/catalog/);

    // Dynamically: a non-MI command with an empty cache and no route to the network does its job and
    // never creates the capability cache, so neither the network nor the cache can change what it does.
    const home = tempRoot();
    const env = { ...process.env, XDG_CACHE_HOME: join(home, "cache"), XDG_CONFIG_HOME: join(home, "config"), HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_COLOR: "1" };
    const run = spawnSync(process.execPath, [join(PLUGIN_ROOT, "bin", "dotbabel-list.mjs"), "--type", "skill", "--json"], { cwd: REPO_ROOT, env, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).length).toBeGreaterThan(0);
    expect(existsSync(join(home, "cache", "dotbabel", "model-intelligence"))).toBe(false);
  });
});

describe("model-intelligence refresh locks (P-9)", () => {
  const HOST = hostname();
  const owner = (overrides = {}) => ({ token: "t".repeat(32), pid: 4242, host: HOST, acquiredAt: T0, resource: "fake-catalog", ...overrides });

  it("a lock younger than 10 minutes is never removed; an older lock is removed only when the owner pid is dead or the pid was reused; a lock from another host needs manual recovery", () => {
    expect(STALE_LOCK_MIN_AGE_MS).toBe(10 * MINUTE);
    const judge = (lock, ageMs, { alive, start } = {}) => judgeLock(lock, { now: Date.parse(T0) + ageMs, host: HOST, isAlive: () => alive, processStartOf: () => start });
    // Under 10 minutes: never, whatever the pid says.
    expect(judge(owner(), STALE_LOCK_MIN_AGE_MS - 1, { alive: false })).toMatchObject({ state: "held" });
    // 10 minutes or more: a dead owner is proof enough.
    expect(judge(owner(), STALE_LOCK_MIN_AGE_MS, { alive: false })).toMatchObject({ state: "recoverable", reason: "owner_dead" });
    // A live pid with the recorded start identity is the owner, still running.
    expect(judge(owner({ processStart: "111" }), HOUR, { alive: true, start: "111" })).toMatchObject({ state: "held" });
    // A live pid with a different start identity is another process that reused the pid.
    expect(judge(owner({ processStart: "111" }), HOUR, { alive: true, start: "222" })).toMatchObject({ state: "recoverable", reason: "pid_reused" });
    // A live pid with no start identity to compare: age alone is never proof.
    expect(judge(owner(), 24 * HOUR, { alive: true })).toMatchObject({ state: "held" });
    // Liveness that cannot be established: do not remove.
    expect(judge(owner(), 24 * HOUR, { alive: undefined })).toMatchObject({ state: "held", reason: "liveness_unknown" });
    // Another host, or metadata that is not enough: manual recovery, never automatic deletion.
    expect(judge(owner({ host: "another-host" }), 24 * HOUR, { alive: false })).toMatchObject({ state: "manual_recovery", reason: "other_host" });
    expect(judge({ pid: 4242 }, 24 * HOUR, { alive: false })).toMatchObject({ state: "manual_recovery", reason: "insufficient_metadata" });
    expect(judge(null, 24 * HOUR, { alive: false })).toMatchObject({ state: "manual_recovery", reason: "insufficient_metadata" });
    // A lock stamped in the future is young, never old.
    expect(judge(owner({ acquiredAt: at(HOUR) }), 0, { alive: false })).toMatchObject({ state: "held" });

    // acquireLock applies the same judgement and never touches a lock it may not remove.
    const root = tempRoot();
    const path = lockPathFor(root, "fake-catalog");
    mkdirSync(join(root, "locks"), { recursive: true });
    writeFileSync(path, JSON.stringify(owner({ host: "another-host" })));
    const before = readFileSync(path);
    const tryIt = (alive) => acquireLock(path, { resource: "fake-catalog", now: () => Date.parse(T0) + HOUR, isAlive: () => alive, processStartOf: () => undefined });
    expect(tryIt(false)).toMatchObject({ acquired: false, state: "manual_recovery" });
    expect(readFileSync(path).equals(before)).toBe(true);
    writeFileSync(path, JSON.stringify(owner({ acquiredAt: at(HOUR - 9 * MINUTE) })));
    expect(tryIt(false)).toMatchObject({ acquired: false, state: "held" });
    writeFileSync(path, JSON.stringify(owner()));
    const recovered = tryIt(false);
    expect(recovered.acquired).toBe(true);
    expect(readLockOwner(path).pid).toBe(process.pid);
    recovered.release();
    expect(existsSync(path)).toBe(false);
  });

  it("a stale lock whose owner pid is dead is recovered only by the conservative rule", async () => {
    // A real pid that is dead: a child that has already exited.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const deadPid = Number(dead.stdout);
    expect(deadPid).toBeGreaterThan(0);
    const root = tempRoot();
    const path = lockPathFor(root, "fake-catalog");
    mkdirSync(join(root, "locks"), { recursive: true });
    const stale = (acquiredAt, host = HOST) => writeFileSync(path, JSON.stringify(owner({ pid: deadPid, acquiredAt, host })));
    const module = knowledgeModule("fake-catalog", () => knowledgeOk("fake-catalog", catalogEvidence(ANTHROPIC_ONLY), at(HOUR)));
    const refresh = () => refreshSource({ module, context: { providers: ["anthropic"] } }, { root, now: clockAt(at(HOUR)) });

    // Dead owner, but the lock is only 5 minutes old: it is not recovered, and no discovery starts.
    stale(at(HOUR - 5 * MINUTE));
    expect(await refresh()).toMatchObject({ outcome: "in_progress" });
    expect(module.discover).not.toHaveBeenCalled();
    // Dead owner on another host: manual recovery, and the lock stays.
    stale(T0, "another-host");
    expect(await refresh()).toMatchObject({ outcome: "in_progress", lock: { state: "manual_recovery", reason: "other_host" } });
    expect(existsSync(path)).toBe(true);
    // Dead owner on this host, 1 hour old: recovered, the refresh runs, and the lock is released after.
    stale(T0);
    expect(await refresh()).toMatchObject({ outcome: "refreshed" });
    expect(module.discover).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(join(root, "locks"))).toEqual([]);
  });
});

describe("model-intelligence conditional GET (P-9)", () => {
  it("a conditional GET sends the stored etag, and a not_modified result keeps the previous entry, renews its observedAt, and never replaces it", async () => {
    const root = tempRoot();
    const requests = [];
    let answer = () => new Response(RECORDED, { status: 200, headers: { "content-type": "application/json", etag: '"v1"' } });
    const fetch = async (url, init) => {
      requests.push(init.headers);
      return answer();
    };
    const run = (now) => refreshSource({ module: modelsDev, context: { providers: ["anthropic", "openai"], fetch, now: clockAt(now) } }, { root, now: clockAt(now) });

    expect((await run(T0)).outcome).toBe("refreshed");
    expect(requests[0]).not.toHaveProperty("if-none-match");
    const first = readEntry(root, "models-dev");
    expect(first.result.evidence.etag).toBe('"v1"');

    answer = () => new Response(null, { status: 304, headers: { etag: '"v1"' } });
    const outcome = await run(at(30 * HOUR));
    expect(requests[1]["if-none-match"]).toBe('"v1"');
    expect(outcome).toMatchObject({ outcome: "not_modified", cached: { observedAt: at(30 * HOUR), freshness: "fresh" } });
    const second = readEntry(root, "models-dev");
    // The evidence and its provenance are the stored ones; only the confirmation time moved.
    expect(second.result.evidence).toEqual(first.result.evidence);
    expect(second.result.provenance).toEqual(first.result.provenance);
    expect(second.result.observedAt).toBe(at(30 * HOUR));
    expect(second.entry.notice).toBe(first.entry.notice);
  });

  it("sends a stored etag only for a cache entry whose provider set and adapterVersion equal those of the request", async () => {
    const root = tempRoot();
    const seen = [];
    const evidence = (etag) => catalogEvidence([{ id: "anthropic", models: [{ id: "a" }] }, { id: "openai", models: [{ id: "o" }] }], { etag });
    const module = (adapterVersion) =>
      knowledgeModule(
        "fake-catalog",
        (ctx) => {
          seen.push(ctx.etag);
          return knowledgeOk("fake-catalog", evidence('"v1"'), at(seen.length * MINUTE), adapterVersion);
        },
        { adapterVersion },
      );
    const run = (providers, adapterVersion = "2") => refreshSource({ module: module(adapterVersion), context: { providers } }, { root, now: clockAt(at(HOUR + seen.length * MINUTE)) });

    await run(["anthropic", "openai"]);
    // The same set in another order is the same set.
    await run(["openai", "anthropic"]);
    // A different provider set: the stored etag covers a different reduction.
    await run(["anthropic"]);
    // The entry now holds ["anthropic"]; a matching set sends the etag again.
    await run(["anthropic"]);
    // A new adapter version can change the reduction or the mapping: no etag.
    await run(["anthropic"], "3");
    expect(seen).toEqual([undefined, '"v1"', undefined, '"v1"', undefined]);
  });

  it("rejects a not_modified result from any operation other than a discover that sent an etag", async () => {
    const notModified = makeAdapterResult({ status: "not_modified", provenance: { sourceId: "fake-catalog", sourceKind: "knowledge-source", adapterVersion: "1" }, observedAt: T0 });
    expect(() => checkAdapterResult(notModified, { operation: "observe", sentEtag: true })).toThrow(TypeError);
    expect(() => checkAdapterResult(notModified, { operation: "validate", sentEtag: true })).toThrow(TypeError);
    expect(() => checkAdapterResult(notModified, { operation: "discover", sentEtag: false })).toThrow(/not_modified/);
    expect(() => checkAdapterResult(notModified, { operation: "discover", sentEtag: true })).not.toThrow();
    expect(() => checkAdapterResult(knowledgeOk("fake-catalog", catalogEvidence(ANTHROPIC_ONLY), T0), { operation: "discover", sentEtag: false })).not.toThrow();

    // In a refresh, the breach is reported for that source, and the cache it would have kept stays as it was.
    const root = tempRoot();
    await seed(root, "fake-catalog", T0, ANTHROPIC_ONLY);
    const before = readFileSync(entryPath(root, "fake-catalog"));
    // The stored entry has no etag, so the refresh sends none, and a not_modified answer is a breach.
    const liar = knowledgeModule("fake-catalog", () => notModified);
    const outcome = await refreshSource({ module: liar, context: { providers: ["anthropic"] } }, { root, now: clockAt(at(HOUR)) });
    expect(outcome).toMatchObject({ outcome: "failed", diagnostic: { code: "adapter_contract_breach" } });
    expect(readFileSync(entryPath(root, "fake-catalog")).equals(before)).toBe(true);
  });
});
