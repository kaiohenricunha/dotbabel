import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { createSnapshot, validateSnapshot, snapshotCatalog, releaseSnapshotStatus, updateSnapshot, readSnapshot, DEFAULT_SNAPSHOT_PATH, collectReleaseEvidence, checkReleaseRequirements, serializeSnapshot } from "../src/model-intelligence/snapshot/index.mjs";
import { acquireLock } from "../src/lib/process-lock.mjs";
import { canonicalJson, hashContent } from "../src/model-intelligence/materialize/manifest.mjs";
import * as anthropic from "../src/model-intelligence/sources/knowledge/anthropic.mjs";
import { resolve as resolveCompute } from "../src/model-intelligence/resolver/index.mjs";
import { mergePolicy, SHIPPED_POLICY } from "../src/model-intelligence/policy/index.mjs";
import { EFFORT_INTENTS } from "../src/model-intelligence/domain/index.mjs";
import { descriptor } from "../src/model-intelligence/sources/runtime/claude.mjs";

const at = "2026-10-18T08:00:00.000Z";
const provenance = { sourceId: "claude", sourceKind: "runtime", sourceVersion: "2.1.302" };
const accepted = value => ({ value, provenance, confidence: "high" });
const inputs = () => structuredClone({ toolVersion: "4.2.0", sources: [{ ...provenance, observedAt: at }], runtimes: { claude: { models: [{ model: "opaque-selector", fields: { id: [accepted("opaque-selector")], capabilities: [accepted({ reasoning: true, tool_call: true })], supportedReasoningLevels: [accepted(["small", "normal", "large", "largest"].map(effort => ({ effort })))], selectionVisibility: [accepted("listed")] } }], runtimeContract: descriptor, provenance } } });
const file = () => path.join(makeTempDir("mi-snapshot-"), "release-capabilities.json");

describe("release snapshot accepted evidence", () => {
  it("snapshotId is identical for two generations with the same facts and different observedAt", () => {
    const first = inputs(), second = inputs(); second.sources[0].observedAt = "2026-10-19T08:00:00.000Z";
    expect(createSnapshot(first).snapshotId).toBe(createSnapshot(second).snapshotId);
    second.runtimes.claude.models[0].fields.capabilities[0].value.reasoning = false;
    expect(createSnapshot(first).snapshotId).not.toBe(createSnapshot(second).snapshotId);
  });
  it("the snapshot rejects refresh_in_progress, TTL, and computed freshness fields", () => {
    for (const key of ["refresh_in_progress", "ttl", "freshness", "refresh", "expiresAt", "generatedAt", "availability"]) {
      const data = inputs(); data.runtimes.claude.models[0].fields.id[0][key] = "fresh";
      expect(() => createSnapshot(data)).toThrow(/snapshot/);
    }
  });
  it("a snapshot whose declared snapshotId differs from the computed one is rejected and never rewritten by the build", () => {
    const candidate = createSnapshot(inputs()); candidate.snapshotId = "sha256:" + "0".repeat(64);
    const target = file(); const bytes = JSON.stringify(candidate); fs.writeFileSync(target, bytes);
    expect(() => readSnapshot(target)).toThrow(/identity/); expect(fs.readFileSync(target, "utf8")).toBe(bytes);
  });
  it("snapshot --check reproduces the committed snapshotId with no network", () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("network forbidden"); });
    try { const saved = readSnapshot(DEFAULT_SNAPSHOT_PATH); expect(validateSnapshot(saved)).toEqual(saved); expect(snapshotCatalog(saved).scope).toBe("release"); expect(network).not.toHaveBeenCalled(); }
    finally { network.mockRestore(); }
  });
  it("retains every field source and never mutates the accepted input", () => {
    const data = inputs(); const before = structuredClone(data); const snapshot = createSnapshot(data); const catalog = snapshotCatalog(snapshot);
    expect(data).toEqual(before); expect(catalog.runtimes[0].models[0].fields.id[0]).toMatchObject({ provenance, availability: "available", freshness: "fresh", refresh: "idle" });
    expect(snapshot.runtimes.claude.models[0].fields.id[0]).not.toHaveProperty("availability");
    expect(snapshotCatalog(snapshot)).toEqual(catalog);
  });
  it("fails missing required Claude identity, runtime contract and unknown source provenance", () => {
    for (const mutate of [x => delete x.runtimes.claude, x => x.runtimes.claude.models = [], x => delete x.runtimes.claude.runtimeContract, x => x.runtimes.claude.models[0].fields.id[0].provenance = { sourceId: "invented", sourceKind: "runtime" }]) {
      const data = inputs(); mutate(data); expect(() => createSnapshot(data)).toThrow(/snapshot/);
    }
  });
  it("release age has the inclusive seven-day boundary and ignores unused optional sources", () => {
    const data = inputs(); data.sources.push({ sourceId: "unused", sourceKind: "knowledge-source", sourceVersion: "old", observedAt: "2000-01-01T00:00:00.000Z" });
    const snapshot = createSnapshot(data);
    expect(releaseSnapshotStatus(snapshot, { now: "2026-10-25T08:00:00.000Z" })).toMatchObject({ valid: true, releaseSnapshotAgeMs: 7 * 86400000 });
    expect(releaseSnapshotStatus(snapshot, { now: "2026-10-25T08:00:00.001Z" })).toMatchObject({ valid: false, reason: "release_evidence_stale" });
    expect(releaseSnapshotStatus(snapshot, { now: "2026-10-17T08:00:00.000Z" })).toMatchObject({ valid: false, reason: "release_evidence_time_invalid" });
  });
  it("snapshot --write fails when a required Claude fact is unavailable and leaves the committed file untouched", async () => {
    const target = file(); const original = JSON.stringify(createSnapshot(inputs())); fs.writeFileSync(target, original);
    await expect(updateSnapshot({ file: target, collect: async () => { throw new Error("source unavailable"); }, write: true })).rejects.toThrow(/source unavailable/);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    await expect(updateSnapshot({ file: target, collect: async () => ({ ...inputs(), runtimes: {} }), write: true })).rejects.toThrow(/snapshot/);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });
  it("default generation reports a diff without writing; explicit write atomically saves valid facts", async () => {
    const target = file(); const first = await updateSnapshot({ file: target, collect: async () => inputs() });
    expect(first.changed).toBe(true); expect(first.written).toBe(false); expect(fs.existsSync(target)).toBe(false);
    const written = await updateSnapshot({ file: target, collect: async () => inputs(), write: true });
    expect(written.written).toBe(true); expect(readSnapshot(target).snapshotId).toBe(first.snapshot.snapshotId);
    expect((await updateSnapshot({ file: target, collect: async () => inputs() })).changed).toBe(false);
  });
  it("does not replace symlinks or conflicting caller content and does not collect when locked", async () => {
    const root = makeTempDir("mi-snapshot-ownership-"); const outside = path.join(root, "outside.json"); const target = path.join(root, "snapshot.json");
    fs.writeFileSync(outside, "keep"); fs.symlinkSync(outside, target);
    const collect = vi.fn(async () => inputs());
    await expect(updateSnapshot({ file: target, collect, write: true })).rejects.toThrow(); expect(collect).not.toHaveBeenCalled(); expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  });
});


describe("required release sources and floors", () => {
  it("rechecks native selectors without refreshing the dates of retained knowledge facts", async () => {
    const seed = createSnapshot(inputs());
    const observe = vi.fn(async ({ model }) => ({ status: "ok", provenance, observedAt: "2026-10-18T09:00:00.000Z", evidence: { axes: { model }, turnExecuted: false, runtimeVersion: "2.1.302" } }));
    const next = await collectReleaseEvidence(seed, { observe });
    expect(observe).toHaveBeenCalledExactlyOnceWith({ model: "opaque-selector", timeoutMs: expect.any(Number) });
    expect(next.sources[0].observedAt).toBe("2026-10-18T09:00:00.000Z");
    expect(createSnapshot(next).snapshotId).toBe(seed.snapshotId);
  });
  it.each(["unavailable", "changed-selector", "changed-version", "executed-turn"])("refuses %s source evidence", async failure => {
    const seed = createSnapshot(inputs());
    const observe = async () => ({ status: failure === "unavailable" ? "unavailable" : "ok", provenance, observedAt: at, evidence: { axes: { model: failure === "changed-selector" ? "different" : "opaque-selector" }, turnExecuted: failure === "executed-turn", runtimeVersion: failure === "changed-version" ? "2.2.0" : "2.1.302" } });
    await expect(collectReleaseEvidence(seed, { observe })).rejects.toThrow(/release_source/);
  });
  it("checks mandatory floors with the existing resolver and does not mutate release data", () => {
    const seed = createSnapshot(inputs()); const before = structuredClone(seed);
    const request = { runtimeId: "claude", artifactKind: "agent", requirement: { requirement: "exceptional", binding: "self", mode: "floor" } };
    expect(checkReleaseRequirements(seed, [request]).valid).toBe(true);
    const changed = inputs(); changed.runtimes.claude.models[0].fields.supportedReasoningLevels[0].value = [];
    expect(checkReleaseRequirements(createSnapshot(changed), [request])).toMatchObject({ valid: false, diagnostics: [{ code: "release_requirement_unsatisfied" }] });
    expect(seed).toEqual(before);
  });
});


describe("snapshot failure boundaries", () => {
  it("uses the shared effort intent vocabulary and requires an order for semantic effort", () => {
    const schema = JSON.parse(fs.readFileSync(new URL("../../../schemas/dotbabel.release-capabilities.schema.json", import.meta.url), "utf8"));
    const effort = schema.properties.runtimes.additionalProperties.properties.models.items.properties.fields.properties.supportedReasoningLevels.items.properties.value.items;
    expect(effort.properties.intent.enum).toEqual(EFFORT_INTENTS);
    const data = inputs(); data.runtimes.claude.models[0].fields.supportedReasoningLevels[0].value = [{ effort: "small", intent: "low", order: 0 }];
    expect(createSnapshot(data).snapshotId).toMatch(/^sha256:/);
  });
  it("does not collect or write when another process holds the shared snapshot lock", async () => {
    const target = file(); const lock = acquireLock(path.join(path.dirname(target), ".dotbabel-projection.lock"), { resource: "release-snapshot" });
    expect(lock.acquired).toBe(true); const collect = vi.fn(async () => inputs());
    try { await expect(updateSnapshot({ file: target, collect, write: true })).rejects.toThrow(/snapshot_locked/); expect(collect).not.toHaveBeenCalled(); expect(fs.existsSync(target)).toBe(false); }
    finally { lock.release(); }
  });
  it("retains another writer's changed bytes instead of overwriting a displaced file", async () => {
    const target = file(); fs.writeFileSync(target, "original");
    await expect(updateSnapshot({ file: target, collect: async () => { fs.writeFileSync(target, "other writer"); return inputs(); }, write: true })).rejects.toThrow(/drift/);
    expect(fs.readFileSync(target, "utf8")).toBe("other writer");
  });
  it("keeps required source dates in the age gate even when a field claims a later observation", () => {
    const data = inputs(); data.sources[0].observedAt = "2026-10-01T08:00:00.000Z"; data.runtimes.claude.models[0].fields.id[0].observedAt = at;
    expect(releaseSnapshotStatus(createSnapshot(data), { now: at })).toMatchObject({ valid: false, releaseSnapshotAgeMs: 17 * 86400000 });
  });
  it.each(["https://user:secret@example.test/doc", "https://example.test/doc?token=private", "https://example.test/doc#private"])("refuses private URL components without echoing them (%s)", url => {
    const data = inputs(); data.sources[0].url = url;
    expect(() => createSnapshot(data)).toThrow("snapshot_source_url_invalid");
  });
  it.each(["duplicate-source", "duplicate-model", "wrong-runtime", "wrong-identity", "wrong-contract"])("refuses %s normalized inputs", failure => {
    const data = inputs();
    if (failure === "duplicate-source") data.sources.push(structuredClone(data.sources[0]));
    if (failure === "duplicate-model") data.runtimes.claude.models.push(structuredClone(data.runtimes.claude.models[0]));
    if (failure === "wrong-runtime") data.runtimes.claude.provenance.sourceId = "codex";
    if (failure === "wrong-identity") data.runtimes.claude.models[0].fields.id[0].value = "other";
    if (failure === "wrong-contract") data.runtimes.claude.runtimeContract = { id: "claude", kind: "runtime", capabilities: {} };
    expect(() => createSnapshot(data)).toThrow(/snapshot/);
  });
  it("normalizes source and model input order without changing semantic identity", () => {
    const data = inputs(); data.sources.push({ sourceId: "extra", sourceKind: "knowledge-source", sourceVersion: "one", observedAt: at });
    const extra = structuredClone(data.runtimes.claude.models[0]); extra.model = "another"; extra.fields.id[0].value = "another"; data.runtimes.claude.models.push(extra);
    const other = structuredClone(data); other.sources.reverse(); other.runtimes.claude.models.reverse();
    expect(createSnapshot(data).snapshotId).toBe(createSnapshot(other).snapshotId);
  });
  it("refuses insufficient required floors before writing any candidate", async () => {
    const target = file(); fs.writeFileSync(target, "previous");
    const data = inputs(); data.runtimes.claude.models[0].fields.capabilities[0].value.reasoning = false;
    await expect(updateSnapshot({ file: target, collect: async () => data, write: true, requirements: [{ runtimeId: "claude", artifactKind: "agent", requirement: { mode: "floor", binding: "self", requirement: "frontier" } }] })).rejects.toThrow("release_requirement_unsatisfied");
    expect(fs.readFileSync(target, "utf8")).toBe("previous");
  });
  it("does not renew documentation or provider source age while rechecking native selectors", async () => {
    const data = inputs(); const docs = { sourceId: "official-docs", sourceKind: "knowledge-source", sourceVersion: "accepted" };
    data.sources.push({ ...docs, observedAt: "2026-10-17T08:00:00.000Z" }); data.runtimes.claude.models[0].fields.capabilities[0].provenance = docs;
    const next = await collectReleaseEvidence(createSnapshot(data), { observe: async () => ({ status: "ok", provenance, observedAt: at, evidence: { axes: { model: "opaque-selector" }, turnExecuted: false, runtimeVersion: "2.1.302" } }) });
    expect(next.sources.find(source => source.sourceId === "official-docs").observedAt).toBe("2026-10-17T08:00:00.000Z");
    expect(releaseSnapshotStatus(createSnapshot(next), { now: at }).releaseSnapshotAgeMs).toBe(86400000);
  });
  it("stops source collection when the shared subprocess budget is spent", async () => {
    const observe = vi.fn(); const monotonic = vi.fn().mockReturnValueOnce(0).mockReturnValue(10000);
    await expect(collectReleaseEvidence(createSnapshot(inputs()), { observe, monotonic })).rejects.toThrow("release_source_timeout");
    expect(observe).not.toHaveBeenCalled();
  });
  it("fails closed for an additional release runtime without a verified collector", async () => {
    const data = inputs(); const codex = structuredClone(data.runtimes.claude); codex.provenance = { ...provenance, sourceId: "codex" }; codex.runtimeContract.id = "codex";
    for (const entries of Object.values(codex.models[0].fields)) for (const entry of entries) entry.provenance = codex.provenance;
    data.runtimes.codex = codex; data.sources.push({ ...codex.provenance, observedAt: at });
    await expect(collectReleaseEvidence(createSnapshot(data))).rejects.toThrow("release_source_unsupported");
  });
});


describe("committed release evidence", () => {
  it("matches the sanitized native selector recording and explicit accepted documentation facts", async () => {
    const proof = JSON.parse(fs.readFileSync(new URL("./fixtures/model-intelligence/release-source-proof.json", import.meta.url), "utf8"));
    const saved = readSnapshot(); const runtime = saved.runtimes.claude;
    expect(runtime.provenance.sourceVersion).toBe(proof.nativeVersion); expect(proof.inferenceCalls).toBe(0);
    expect(saved.sources.find(source => source.sourceId === "claude-release-docs").sourceVersion).toBe(hashContent(canonicalJson(proof.acceptedDocumentationFacts)));
    for (const mapping of proof.selectors) {
      expect(mapping.turnExecuted).toBe(false);
      for (const id of [mapping.selector, mapping.canonicalModel]) {
        const model = runtime.models.find(model => model.model === id);
        expect(model.fields.canonicalModel[0].value).toBe(mapping.canonicalModel);
        expect(model.fields.capabilities[0].value).toEqual({ reasoning: proof.acceptedDocumentationFacts.reasoning, tool_call: proof.acceptedDocumentationFacts.tool_call });
        expect(model.fields.supportedReasoningLevels[0].value).toEqual(proof.acceptedDocumentationFacts.supportedReasoningLevels.map(effort => ({ effort })));
        expect(model.fields.defaultReasoningLevel[0].value).toBe(proof.acceptedDocumentationFacts.defaultReasoningLevel);
        expect(model.fields).not.toHaveProperty("selectionVisibility");
      }
    }
    const recording = fs.readFileSync(new URL("./fixtures/model-intelligence/anthropic-models-api/models.json", import.meta.url), "utf8");
    const normalized = await anthropic.discover({ providers: ["anthropic"], fetch: async () => new Response(recording) });
    expect(saved.sources.find(source => source.sourceId === "anthropic-models-api").sourceVersion).toBe(normalized.provenance.sourceVersion);
  });
  it("uses the same accepted release configurations regardless of the later wall clock", () => {
    const saved = readSnapshot(); const before = snapshotCatalog(saved);
    expect(releaseSnapshotStatus(saved, { now: "2030-01-01T00:00:00.000Z" }).valid).toBe(false);
    expect(snapshotCatalog(saved)).toEqual(before); expect(validateSnapshot(saved).snapshotId).toBe(saved.snapshotId);
  });
  it("rejects invalid JSON, missing snapshots and non-JSON generator inputs without creating evidence", () => {
    const target = file(); expect(() => readSnapshot(target)).toThrow("snapshot_unavailable"); fs.writeFileSync(target, "invalid JSON"); expect(() => readSnapshot(target)).toThrow("snapshot_invalid");
    const data = inputs(); data.toolVersion = undefined; expect(() => createSnapshot(data)).toThrow();
  });
  it("does not accept missing clocks as current release evidence", () => {
    expect(releaseSnapshotStatus(createSnapshot(inputs()), { now: "invalid" })).toMatchObject({ valid: false, reason: "release_evidence_time_invalid", releaseSnapshotAgeMs: null });
  });
  it("bounds accepted content before it can become a release input", () => {
    const data = inputs(); data.runtimes.claude.models = Array.from({ length: 1024 }, (_, i) => ({ model: "large-" + i, fields: { id: Array.from({ length: 64 }, () => accepted("large-" + i)) } }));
    expect(() => createSnapshot(data)).toThrow("snapshot_invalid");
  });
});


it("matches the committed serialization golden and ignores input object key order", () => {
  const saved = readSnapshot();
  expect(serializeSnapshot(saved)).toBe(fs.readFileSync(DEFAULT_SNAPSHOT_PATH, "utf8"));
  const reordered = Object.fromEntries(Object.entries(saved).reverse());
  expect(serializeSnapshot(reordered)).toBe(serializeSnapshot(saved));
});


it("checks release freshness after collection finishes instead of before its observations exist", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(at)); const target = file();
    const result = await updateSnapshot({ file: target, collect: async () => {
      vi.setSystemTime(new Date(Date.parse(at) + 1000)); const data = inputs(); data.sources[0].observedAt = new Date().toISOString(); return data;
    } });
    expect(result.changed).toBe(true); expect(result.written).toBe(false);
  } finally { vi.useRealTimers(); }
});


it("refuses a required release configuration supported only by low-confidence evidence", () => {
  const data = inputs(); for (const entries of Object.values(data.runtimes.claude.models[0].fields)) for (const entry of entries) entry.confidence = "low";
  const result = checkReleaseRequirements(createSnapshot(data), [{ runtimeId: "claude", artifactKind: "agent", requirement: { requirement: "deep", mode: "floor", binding: "self" } }]);
  expect(result.valid).toBe(false); expect(result.diagnostics).toEqual([{ code: "release_requirement_unsatisfied" }]);
});


describe("protected review regressions", () => {
  it.each(["adapterVersion", "sourceVersion"])("does not renew accepted provenance from a changed %s", async axis => {
    const seed = readSnapshot(); const target = file(); const previous = serializeSnapshot(seed); fs.writeFileSync(target, previous);
    const observe = async ({ model }) => ({ status: "ok", provenance: { ...seed.runtimes.claude.provenance, [axis]: "UNREVIEWED-NEXT" }, observedAt: "2026-10-18T12:00:00.000Z", evidence: { axes: { model: seed.runtimes.claude.models.find(row => row.model === model).fields.canonicalModel[0].value }, turnExecuted: false, runtimeVersion: seed.runtimes.claude.provenance.sourceVersion } });
    await expect(updateSnapshot({ file: target, collect: () => collectReleaseEvidence(seed, { observe }), write: true, now: "2026-10-18T12:00:01.000Z" })).rejects.toThrow("release_source_unavailable");
    expect(fs.readFileSync(target, "utf8")).toBe(previous);
  });
  it("resolves an unpinned floor from the committed accepted release selectors", () => {
    const saved = readSnapshot(); const request = { runtimeId: "claude", artifactKind: "agent", requirement: { requirement: "deep", mode: "floor", binding: "self" } };
    const result = checkReleaseRequirements(saved, [request]); expect(result.valid).toBe(true);
    expect(result.results[0].configuration.axes.model).toEqual(expect.any(String));
    const catalog = snapshotCatalog(saved);
    expect(catalog.runtimes[0].models.every(model => model.fields.releaseEligibility[0].value === "eligible")).toBe(true);
    expect(catalog.runtimes[0].models.every(model => model.fields.selectionVisibility === undefined)).toBe(true);
    const live = resolveCompute({ requirement: request.requirement, target: { runtimeId: "claude", artifactKind: "agent" }, policy: mergePolicy({ shipped: SHIPPED_POLICY }), runtimeContract: descriptor, catalog: { ...catalog, scope: "live" } });
    expect(live.status).toBe("unresolved"); expect(live.diagnostics[0].code).toBe("ordinary_selection_unverified");
  });
  it.each([".dotbabel-projection.lock", ".dotbabel-projection.json", ".dotbabel-projection.pending.json", ".dotbabel-claude-companions.json"])("refuses coordination destination %s before collecting or acquiring a lock", async name => {
    const root = makeTempDir("mi-snapshot-reserved-"); const target = path.join(root, name); const isLock = name.endsWith(".lock");
    if (!isLock) fs.writeFileSync(target, "coordination metadata");
    const collect = vi.fn(async () => inputs());
    await expect(updateSnapshot({ file: target, collect, write: true })).rejects.toThrow("snapshot_destination_reserved");
    expect(collect).not.toHaveBeenCalled();
    if (!isLock) expect(fs.readFileSync(target, "utf8")).toBe("coordination metadata");
    expect(fs.existsSync(path.join(root, ".dotbabel-projection.lock"))).toBe(false);
    expect((await updateSnapshot({ file: path.join(root, "normal.json"), collect, write: true })).written).toBe(true);
  });
});
