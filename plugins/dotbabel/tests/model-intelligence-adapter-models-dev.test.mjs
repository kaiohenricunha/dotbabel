import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import * as modelsDev from "../src/model-intelligence/sources/knowledge/models-dev.mjs";
import { validateDescriptor } from "../src/model-intelligence/sources/contract.mjs";
import { makeModelFact } from "../src/model-intelligence/sources/evidence.mjs";

const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/model-intelligence/", import.meta.url));
const RECORDED = readFileSync(`${FIXTURE_DIR}models-dev/api.json`);
const fixedNow = () => "2026-09-27T12:00:00.000Z";

/** A fetch double that records each request and answers with `respond`. */
function fakeFetch(respond) {
  const calls = [];
  async function fetch(url, init) {
    calls.push({ url: String(url), init });
    return respond(url, init);
  }
  return { fetch, calls };
}

/** A `Response` carrying `body`, which is JSON text, bytes, or a stream. */
const reply = (body, init = {}) => new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });

/** The recorded document, parsed, so a test can change one record without touching the file. */
const recorded = () => JSON.parse(RECORDED.toString("utf8"));

const discoverWith = (respond, extra = {}) => {
  const double = fakeFetch(respond);
  return { double, run: modelsDev.discover({ providers: ["anthropic", "github-copilot", "openai"], fetch: double.fetch, now: fixedNow, ...extra }) };
};

/** The shape Node's own fetch rejects with: the errno sits on `cause`, not on the error itself. */
function nodeFetchFailure(code) {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:443`), { code }) });
}

describe("models-dev knowledge-source adapter", () => {
  it("descriptor: kind knowledge-source, discovery network required, observation unsupported, binding {}", () => {
    const { descriptor } = modelsDev;
    expect(validateDescriptor(descriptor).errors).toEqual([]);
    expect(descriptor.id).toBe("models-dev");
    expect(descriptor.kind).toBe("knowledge-source");
    expect(descriptor.capabilities.discovery).toEqual({ support: "supported", network: "required", auth: "none", cacheable: true, execution: "read-only" });
    expect(descriptor.capabilities.observation).toEqual({ support: "unsupported" });
    expect(descriptor.capabilities.binding).toEqual({});
    expect(descriptor.capabilities.invocation).toEqual({ support: "unsupported", axes: {} });
    expect(descriptor.capabilities.validation).toEqual({ support: "unsupported" });
    // The shipped descriptor is the one the adapter-contract fixture already fixed for this source.
    const { $comment, ...contract } = JSON.parse(readFileSync(`${FIXTURE_DIR}adapter-contract/knowledge-source-descriptor.json`, "utf8"));
    expect($comment).toBeTypeOf("string");
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(contract);
    expect(Object.isFrozen(descriptor.capabilities.discovery)).toBe(true);
  });

  it("discover() normalizes the recorded response fixture into field-level facts with sourceVersion", async () => {
    const { double, run } = discoverWith(() => reply(RECORDED));
    const result = await run;
    expect(result.status).toBe("ok");
    expect(result.provenance).toEqual({
      sourceId: "models-dev",
      sourceKind: "knowledge-source",
      adapterVersion: modelsDev.ADAPTER_VERSION,
      sourceVersion: `sha256:${createHash("sha256").update(RECORDED).digest("hex").slice(0, 32)}`,
    });
    expect(result.observedAt).toBe(fixedNow());
    expect(double.calls.map((c) => c.url)).toEqual([modelsDev.SOURCE_URL]);

    const { providers, missingProviders, skipped } = result.evidence;
    expect(providers.map((p) => p.id)).toEqual(["anthropic", "github-copilot", "openai"]);
    expect(missingProviders).toEqual([]);
    expect(skipped).toBe(0);
    const anthropic = providers[0];
    expect(anthropic.displayName).toBe("Anthropic");
    expect(anthropic.discovery.models.map((m) => m.id)).toEqual(["claude-haiku-4-5", "claude-opus-4-5", "claude-opus-5"]);
    const opus45 = anthropic.discovery.models[1];
    expect(opus45).toEqual({
      id: "claude-opus-4-5",
      displayName: "Claude Opus 4.5 (latest)",
      contextWindow: 200000,
      supportedReasoningLevels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }],
    });
    // A budget_tokens option is not an effort vocabulary, so it yields no effort level (ARCH-1).
    expect(anthropic.discovery.models[0].supportedReasoningLevels).toEqual([]);
    // The same model id under two providers stays two facts: identity is provider plus id (ARCH-3).
    const copilot = providers[1];
    expect(copilot.discovery.models.map((m) => m.id)).toEqual(["claude-opus-5", "gpt-5.4"]);
    expect(anthropic.discovery.models.map((m) => m.id)).toContain("claude-opus-5");
    expect(copilot.discovery.effortSupport.xhigh.supportedBy).toEqual(["claude-opus-5", "gpt-5.4"]);
    expect(providers[2].discovery.effortSupport.none).toEqual({ supportedBy: ["gpt-5.4"], notSupportedBy: ["gpt-5.4-pro"] });
    expect(Object.isFrozen(result.evidence.providers[0])).toBe(true);
  });

  it("reduces the document to the requested providers, and lists a requested provider the source lacks", async () => {
    const { run } = discoverWith(() => reply(RECORDED), { providers: ["openai", "no-such-provider"] });
    const result = await run;
    expect(result.status).toBe("ok");
    expect(result.evidence.providers.map((p) => p.id)).toEqual(["openai"]);
    expect(result.evidence.missingProviders).toEqual(["no-such-provider"]);
    expect(JSON.stringify(result.evidence)).not.toContain("claude");
  });

  it("reports a document holding none of the requested providers as unknown, never as an empty success (ARCH-30)", async () => {
    const { run } = discoverWith(() => reply(RECORDED), { providers: ["no-such-provider"] });
    const result = await run;
    expect(result.status).toBe("unknown");
    expect(result.diagnostic.code).toBe("insufficient_evidence");
  });

  it("counts an unusable record or provider instead of hiding it or failing the whole document", async () => {
    const doc = recorded();
    delete doc.anthropic.models["claude-opus-5"].id;
    doc.openai.models = "not an object";
    doc.anthropic.models["claude-haiku-4-5"].reasoning_options = [{ type: "toggle" }, { type: "effort", values: ["low", 7, "", "high"] }];
    const { run } = discoverWith(() => reply(JSON.stringify(doc)));
    const result = await run;
    expect(result.status).toBe("ok");
    const [anthropic] = result.evidence.providers;
    expect(anthropic.discovery.skipped).toBe(1);
    expect(anthropic.discovery.models.map((m) => m.id)).toEqual(["claude-haiku-4-5", "claude-opus-4-5"]);
    expect(anthropic.discovery.models[0].supportedReasoningLevels).toEqual([{ effort: "low" }, { effort: "high" }]);
    expect(result.evidence.providers.map((p) => p.id)).toEqual(["anthropic", "github-copilot"]);
    expect(result.evidence.skipped).toBe(1);
  });

  it("returns unknown with malformed_output for a body that is not the expected JSON object", async () => {
    for (const body of ["<html>not json</html>", "[]", "null", '"text"']) {
      const { run } = discoverWith(() => reply(body));
      const result = await run;
      expect(result.status, body).toBe("unknown");
      expect(result.diagnostic.code, body).toBe("malformed_output");
    }
  });

  it("discover() returns unavailable with network_unavailable when the fetch is refused, and never throws", async () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH"]) {
      const { run } = discoverWith(() => Promise.reject(nodeFetchFailure(code)));
      const result = await run;
      expect(result.status, code).toBe("unavailable");
      expect(result.diagnostic, code).toMatchObject({ code: "network_unavailable", retryable: true });
    }
  });

  it("maps a real refused connection from Node's own fetch to network_unavailable", async () => {
    // A port that was just freed on loopback: a real fetch is refused there without any internet access.
    const server = createServer();
    await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    await new Promise((resolvePromise) => server.close(resolvePromise));
    const result = await modelsDev.discover({ providers: ["anthropic"], url: `http://127.0.0.1:${port}/api.json`, now: fixedNow });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic.code).toBe("network_unavailable");
  });

  it("reports an HTTP error status as unavailable, retryable only for a server-side or rate-limit status", async () => {
    for (const [status, retryable] of [[500, true], [503, true], [429, true], [404, false], [403, false]]) {
      const { run } = discoverWith(() => new Response("no", { status }));
      const result = await run;
      expect(result.status, String(status)).toBe("unavailable");
      expect(result.diagnostic, String(status)).toMatchObject({ code: "http_error", retryable });
    }
  });

  it("a catalog fact from this source never carries availability available", async () => {
    // The source could say it; the evidence must not repeat it (ARCH-14). The key is put into the
    // document so this test fails if the adapter ever copies it through.
    const doc = recorded();
    doc.anthropic.availability = "available";
    doc.anthropic.models["claude-opus-4-5"].availability = "available";
    doc.anthropic.models["claude-opus-4-5"].available = true;
    const { run } = discoverWith(() => reply(JSON.stringify(doc)));
    const result = await run;
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result.evidence)).not.toMatch(/availab/i);
    expect(() => makeModelFact({ id: "m", supportedReasoningLevels: [], availability: "available" })).toThrow(/unknown field "availability"/);
  });

  it("refuses a non-HTTPS source URL outside an injected fixture and sends no Dotbabel credential to a public source", async () => {
    const { double, run } = discoverWith(() => reply(RECORDED));
    await run;
    const [{ init }] = double.calls;
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    const headers = new Headers(init.headers);
    for (const name of ["authorization", "cookie", "x-api-key", "proxy-authorization", "api-key"]) {
      expect(headers.has(name), name).toBe(false);
    }
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // A safety fault throws, like the SEC-1 root check, and nothing is fetched (contract.mjs failure channels).
    for (const url of ["http://models.dev/api.json", "ftp://models.dev/api.json", "https://user:secret@models.dev/api.json", "file:///etc/passwd", "not a url"]) {
      const refused = fakeFetch(() => reply(RECORDED));
      await expect(modelsDev.discover({ providers: ["anthropic"], url, fetch: refused.fetch, now: fixedNow }), url).rejects.toThrow(TypeError);
      expect(refused.calls, url).toEqual([]);
    }
    // Plain HTTP is allowed only on loopback, where a local test fixture is served.
    for (const url of ["http://127.0.0.1:8080/api.json", "http://localhost:8080/api.json", "http://[::1]:8080/api.json"]) {
      const local = fakeFetch(() => reply(RECORDED));
      expect((await modelsDev.discover({ providers: ["anthropic"], url, fetch: local.fetch, now: fixedNow })).status, url).toBe("ok");
    }
  });

  it("rejects or reduces a response that would exceed the 8 MiB per-entry limit", async () => {
    // Reduced: the full document may exceed 8 MiB as long as the requested providers do not.
    const big = recorded();
    big.padding = { id: "padding", name: "Padding", models: { pad: { id: "pad", name: "x".repeat(9 * 1024 * 1024) } } };
    const reduced = await discoverWith(() => reply(JSON.stringify(big))).run;
    expect(reduced.status).toBe("ok");

    // Rejected: the requested providers alone would make an entry above 8 MiB (OPS-2).
    const heavy = recorded();
    heavy.anthropic.models = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`m${i}`, { id: `m${i}`, name: `${"n".repeat(180)}${i}`, limit: { context: 1 } }]));
    const rejected = await discoverWith(() => reply(JSON.stringify(heavy))).run;
    expect(rejected.status).toBe("unknown");
    expect(rejected.diagnostic.code).toBe("entry_too_large");
  });

  it("stops reading a body above the raw read limit, by its declared length or while it streams", async () => {
    const declared = await discoverWith(() => reply("{}", { headers: { "content-length": String(modelsDev.MAX_RESPONSE_BYTES + 1) } })).run;
    expect(declared.status).toBe("unknown");
    expect(declared.diagnostic.code).toBe("response_too_large");

    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const endless = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const streamed = await discoverWith(() => reply(endless)).run;
    expect(streamed.status).toBe("unknown");
    expect(streamed.diagnostic.code).toBe("response_too_large");
    expect(pulled).toBeLessThanOrEqual(modelsDev.MAX_RESPONSE_BYTES / chunk.length + 2);
  });

  it("bounds the body read by the same timeout as the request, so a stalled body cannot hang discovery (REL-1)", async () => {
    const stalled = new ReadableStream({ pull: () => new Promise(() => {}) });
    const { double, run } = discoverWith(() => reply(stalled), { timeoutMs: 50 });
    const result = await run;
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic).toMatchObject({ code: "timeout", retryable: true });
    expect(double.calls[0].init.signal.aborted).toBe(true);
  });

  it("throws for a caller breach: no providers, or a provider id that is not a plain identifier", async () => {
    const { fetch } = fakeFetch(() => reply(RECORDED));
    for (const providers of [undefined, [], "anthropic", ["__proto__"], ["Bad Id"], ["a/b"], [7]]) {
      await expect(modelsDev.discover({ providers, fetch, now: fixedNow }), JSON.stringify(providers)).rejects.toThrow(TypeError);
    }
  });

  it("exports the MIT notice that every stored copy must keep", () => {
    expect(modelsDev.MODELS_DEV_NOTICE).toContain("MIT");
    expect(modelsDev.MODELS_DEV_NOTICE).toContain("Copyright (c) 2025 models.dev");
    expect(readFileSync(`${FIXTURE_DIR}models-dev/NOTICE`, "utf8")).toContain("Copyright (c) 2025 models.dev");
  });
});
