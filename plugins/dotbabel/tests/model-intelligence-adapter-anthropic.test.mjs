import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import * as source from "../src/model-intelligence/sources/knowledge/anthropic.mjs";
import { MAX_CACHE_ENTRY_BYTES, validateDescriptor } from "../src/model-intelligence/sources/contract.mjs";
import { refreshSource, buildCatalog, freshnessPolicyFor, deriveFreshness } from "../src/model-intelligence/catalog/index.mjs";
import { readEntry } from "../src/model-intelligence/catalog/cache.mjs";
import { makeTempDir } from "./fixtures/temp-dir.mjs";

const bytes = fs.readFileSync(new URL("./fixtures/model-intelligence/anthropic-models-api/models.json", import.meta.url), "utf8");
const recorded = () => JSON.parse(bytes);
const now = () => "2026-10-18T05:18:08.353Z";
const response = (body, init = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), init);
const discover = (fetch, extra = {}) => source.discover({ providers: ["anthropic"], fetch, now, ...extra });
afterEach(() => vi.restoreAllMocks());

describe("Anthropic Models API knowledge source", () => {
  it("uses the official provider API freshness class rather than broad catalog defaults", () => {
    expect(freshnessPolicyFor(source)).toEqual({ evidenceClass: "provider-api", staleAfterMs: 6 * 60 * 60 * 1000, expireAfterMs: 24 * 60 * 60 * 1000 });
  });
  it.each([[6 * 3600000, "fresh"], [6 * 3600000 + 1, "stale"], [12 * 3600000, "stale"], [24 * 3600000, "stale"], [24 * 3600000 + 1, "expired"], [48 * 3600000, "expired"]])("classifies official evidence aged %d ms as %s", (age, expected) => {
    expect(deriveFreshness({ observedAt: now(), policy: freshnessPolicyFor(source), now: new Date(Date.parse(now()) + age).toISOString() })).toBe(expected);
  });
  it("preserves valid cache state when later native authorization or source data fails", async () => {
    const root = makeTempDir("mi-anthropic-cache-");
    const handle = { module: source, context: { providers: ["anthropic"], fetch: () => response(bytes), now } };
    expect((await refreshSource(handle, { root, now })).outcome).toBe("refreshed");
    const first = readEntry(root, source.SOURCE_ID);
    for (const fetch of [() => response("", { status: 401 }), () => response("{")]) {
      const later = () => "2026-10-18T05:20:00.000Z";
      expect((await refreshSource({ ...handle, context: { ...handle.context, fetch, now: later } }, { root, now: later })).outcome).toBe("failed");
      expect(readEntry(root, source.SOURCE_ID).entry).toEqual(first.entry);
    }
    expect(first.state).toBe("valid");
    const catalog = buildCatalog([{ result: first.result, freshness: "fresh", refresh: "idle" }]);
    expect(catalog.runtimes).toEqual([]);
    for (const model of catalog.models) for (const facts of Object.values(model.fields)) for (const fact of facts) expect(fact.availability).not.toBe("available");
  });
  it("keeps unknown and false capability facts distinct and skips malformed model ids", async () => {
    const doc = { data: [null, { id: "bad\nid" }, { id: "unknown", capabilities: null }, { id: "disabled", capabilities: { thinking: { supported: false }, effort: { supported: false, high: { supported: true } } } }], has_more: false };
    const result = await discover(() => response(doc)); const discovery = result.evidence.providers[0].discovery;
    expect(discovery.skipped).toBe(2);
    expect(discovery.models.find(model => model.id === "unknown")).not.toHaveProperty("capabilities");
    expect(discovery.models.find(model => model.id === "disabled")).toEqual({ id: "disabled", capabilities: { reasoning: false }, supportedReasoningLevels: [] });
  });
  it("filters unsupported and malformed effort entries without interpreting their names", async () => {
    const doc = { data: [{ id: "opaque", display_name: "A display label", max_input_tokens: -1, capabilities: { thinking: { supported: "yes" }, effort: { supported: true, ultra: { supported: true }, high: { supported: false }, max: { supported: "true" }, constructor: { supported: true }, "bad:name": { supported: true } } } }], has_more: false };
    const result = await discover(() => response(doc));
    expect(result.evidence.providers[0].discovery.models).toEqual([{ id: "opaque", displayName: "A display label", supportedReasoningLevels: [{ effort: "ultra" }] }]);
  });
  it("reports other requested providers as missing without invoking this source for them alone", async () => {
    const fetch = vi.fn(() => response(bytes));
    const result = await discover(fetch, { providers: ["openai", "anthropic", "openai"] });
    expect(result.evidence.missingProviders).toEqual(["openai"]);
    fetch.mockClear();
    expect((await discover(fetch, { providers: ["openai"] })).status).toBe("unknown"); expect(fetch).not.toHaveBeenCalled();
    await expect(discover(fetch, { providers: [] })).rejects.toThrow(/providers/);
    await expect(discover(fetch, { providers: ["constructor"] })).rejects.toThrow(/providers/);
  });
  it("bounds streamed bytes and invalid UTF-8 instead of trusting content-length or replacement decoding", async () => {
    const streamed = await discover(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_CACHE_ENTRY_BYTES + 1)); controller.close(); } })));
    expect(streamed).toMatchObject({ status: "unknown", diagnostic: { code: "response_too_large" } });
    const invalid = await discover(() => new Response(new Uint8Array([255])));
    expect(invalid).toMatchObject({ status: "unknown", diagnostic: { code: "malformed_output" } });
  });
  it("cancels a stalled response body when the whole operation times out", async () => {
    let cancelled = false;
    const result = await discover(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })), { timeoutMs: 10 });
    expect(result).toMatchObject({ status: "unavailable", diagnostic: { code: "timeout" } });
    expect(cancelled).toBe(true);
  });
  it("descriptor: kind knowledge-source, discovery network required, observation unsupported, binding {}", () => {
    expect(validateDescriptor(source.descriptor).errors).toEqual([]);
    expect(source.descriptor.kind).toBe("knowledge-source");
    expect(source.descriptor.capabilities.discovery).toEqual({ support: "supported", network: "required", auth: "required-existing", cacheable: true, execution: "read-only" });
    expect(source.descriptor.capabilities.observation).toEqual({ support: "unsupported" });
    expect(source.descriptor.capabilities.binding).toEqual({});
    expect(source.notice).toBe(null);
  });
  it("discover() normalizes the recorded response fixture into field-level facts with sourceVersion", async () => {
    const fetch = vi.fn(() => response(bytes)); const result = await discover(fetch);
    expect(result.status).toBe("ok");
    expect(result.observedAt).toBe(now());
    expect(result.provenance).toMatchObject({ sourceId: "anthropic-models-api", sourceKind: "knowledge-source", adapterVersion: source.ADAPTER_VERSION });
    expect(result.provenance.sourceVersion).toBe("sha256:" + createHash("sha256").update(bytes).digest("hex").slice(0, 32));
    expect(result.evidence.providers[0].id).toBe("anthropic");
    const models = result.evidence.providers[0].discovery.models;
    expect(models.map(model => model.id)).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(models[0]).toEqual({ id: "claude-haiku-5-5", capabilities: { reasoning: true }, contextWindow: 1000000, supportedReasoningLevels: ["high", "low", "max", "medium", "xhigh"].map(effort => ({ effort })) });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(source.SOURCE_URL);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", headers: { accept: "application/json", "anthropic-version": "2023-06-01" } });
    expect(Object.keys(fetch.mock.calls[0][1].headers).sort()).toEqual(["accept", "anthropic-version"]);
  });
  it("a catalog fact from this source never carries availability available", async () => {
    const doc = recorded(); doc.data[0].availability = "available"; doc.data[0].provider = "openai"; doc.data[0].defaultReasoningLevel = "max";
    const result = await discover(() => response(doc));
    for (const model of result.evidence.providers[0].discovery.models) {
      expect(model).not.toHaveProperty("availability"); expect(model).not.toHaveProperty("provider");
      expect(model).not.toHaveProperty("defaultReasoningLevel"); expect(model.capabilities).not.toHaveProperty("tool_call");
    }
  });
  it("requires a caller-owned native transport and never reads or guesses credentials", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await source.discover({ providers: ["anthropic"], now });
    expect(result).toMatchObject({ status: "unavailable", diagnostic: { code: "native_transport_unavailable" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("discover() returns unavailable with network_unavailable when the fetch is refused, and never throws", async () => {
    const result = await discover(() => { throw Object.assign(new Error("not logged"), { code: "ECONNREFUSED" }); });
    expect(result).toMatchObject({ status: "unavailable", diagnostic: { code: "network_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("not logged");
  });
  it.each(["http://api.anthropic.com/v1/models", "https://evil.example/v1/models", "https://user:secret@api.anthropic.com/v1/models", "https://api.anthropic.com/other"])("refuses a non-HTTPS source URL outside an injected fixture and sends no Dotbabel credential to a public source (%s)", async url => {
    const fetch = vi.fn(); await expect(discover(fetch, { url })).rejects.toThrow(/source.*URL/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([302, 401, 429, 503])("handles HTTP %s without forwarding authorization or following a redirect", async status => {
    const fetch = vi.fn(() => response("", { status, headers: { location: "https://evil.example" } }));
    expect((await discover(fetch)).status).toBe("unavailable"); expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects or reduces a response that would exceed the 8 MiB per-entry limit", async () => {
    const result = await discover(() => response("{}", { headers: { "content-length": String(MAX_CACHE_ENTRY_BYTES + 1) } }));
    expect(result).toMatchObject({ status: "unknown", diagnostic: { code: "response_too_large" } });
  });
  it("reads all pages under one bound and does not infer model quality from response order", async () => {
    const doc = recorded(); const fetch = vi.fn(() => response(fetch.mock.calls.length === 1
      ? { data: [doc.data[2]], has_more: true, last_id: doc.data[2].id }
      : { data: [doc.data[0]], has_more: false }));
    const result = await discover(fetch);
    expect(result.status).toBe("ok");
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("after_id")).toBe(doc.data[2].id);
    expect(result.evidence.providers[0].discovery.models.map(model => model.id)).toEqual([doc.data[0].id, doc.data[2].id]);
    expect((await discover(() => response(bytes))).provenance.sourceVersion).not.toBe(result.provenance.sourceVersion);
  });
  it.each(["json", "shape", "empty", "cursor", "duplicate"])("rejects unusable %s evidence rather than replacing valid cache facts", async fault => {
    const doc = recorded();
    if (fault === "empty") doc.data = [];
    if (fault === "shape") delete doc.data;
    if (fault === "cursor") { doc.has_more = true; delete doc.last_id; }
    if (fault === "duplicate") doc.data.push(doc.data[0]);
    const result = await discover(() => response(fault === "json" ? "{" : doc));
    expect(result.status).toBe("unknown"); expect(result).not.toHaveProperty("evidence");
  });
  it("bounds endless pagination and a transport that never completes", async () => {
    let n = 0; const fetch = vi.fn(() => { const id = "model-" + n++; return response({ data: [{ id }], has_more: true, last_id: id }); });
    expect((await discover(fetch)).status).toBe("unknown"); expect(fetch.mock.calls.length).toBeLessThanOrEqual(10);
    const result = await discover(() => new Promise(() => {}), { timeoutMs: 5 });
    expect(result).toMatchObject({ status: "unavailable", diagnostic: { code: "timeout" } });
  });
});
