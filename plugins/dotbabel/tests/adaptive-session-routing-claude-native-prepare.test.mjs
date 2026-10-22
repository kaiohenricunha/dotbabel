import { expect, it, vi } from "vitest";
import { prepareClaudeRoute } from "../src/adaptive-session-routing/claude-mod-prepare.mjs";

const root = "/project";
const ordinary = () => ({ repoRoot: root, prompt: "Implement integration tests.", current: { axes: { model: "native", reasoning: "medium" } }, manual: { model: { source: "native-initial" }, reasoning: { source: "native-initial" } } });
const response = body => ({ status: 200, ok: true, text: JSON.stringify(body) });
function fixture() {
  const settings = {};
  const $ = { session: { version: vi.fn(async () => ({ version: "2.1.302" })), authorize: vi.fn(async () => ({ handle: "opaque-native-handle" })) },
    settings: { read: vi.fn(async () => settings) }, env: { get: vi.fn(async () => undefined) }, config: { list: vi.fn(async () => [{ key: "model", options: ["small", "large"] }]) }, http: { fetch: vi.fn() } };
  const options = { socketPath: "/private/bridge.sock", state: {}, manual: { model: { source: "native-initial" }, reasoning: { source: "native-initial" } } };
  return { $, options, settings };
}
it("keeps a disabled project free from discovery, native settings reads, authorization and provider requests", async () => {
  const f = fixture(); f.$.http.fetch.mockResolvedValueOnce(response({ decision: { status: "preserved", diagnostics: [{ code: "routing_disabled" }] } }));
  const result = await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(result.diagnostics[0].code).toBe("routing_disabled");
  expect(f.$.settings.read).not.toHaveBeenCalled(); expect(f.$.session.authorize).not.toHaveBeenCalled(); expect(f.$.config.list).not.toHaveBeenCalled();
  expect(f.$.http.fetch.mock.calls[0][1]).toMatchObject({ socketPath: f.options.socketPath });
});
it("keeps provider authorization inside the native HTTP call and sends the prompt only to private IPC", async () => {
  const f = fixture(); f.$.http.fetch.mockResolvedValueOnce(response({ ready: true })).mockResolvedValueOnce(response({ needsEvidence: true }))
    .mockResolvedValueOnce(response({ data: [{ id: "opaque-model" }], has_more: false }))
    .mockResolvedValueOnce(response({ decision: { status: "proposed", changes: { model: "selected", reasoning: "high" }, diagnostics: [] } }));
  const result = await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(result.status).toBe("proposed");
  const provider = f.$.http.fetch.mock.calls.filter(([url]) => url.startsWith("https:"));
  expect(provider).toHaveLength(1); expect(provider[0][0]).toBe("https://api.anthropic.com/v1/models?limit=100");
  expect(provider[0][1]).toMatchObject({ auth: "opaque-native-handle", method: "GET" });
  expect(provider[0][1]).not.toHaveProperty("body");
  for (const [url, init] of f.$.http.fetch.mock.calls.filter(([url]) => url.startsWith("http:"))) {
    expect(url).toBe("http://localhost/prepare"); expect(init.socketPath).toBe(f.options.socketPath);
    expect(init.body).not.toContain("opaque-native-handle"); expect(init).not.toHaveProperty("auth");
  }
});
it("reads native manual model and effort independently before the resolver receives them", async () => {
  const f = fixture(); f.settings.model = "chosen-alias"; f.settings.effortLevel = "low";
  f.$.http.fetch.mockResolvedValueOnce(response({ ready: true })).mockResolvedValueOnce(response({ decision: { status: "preserved", diagnostics: [] } }));
  const result = await prepareClaudeRoute(f.$, ordinary(), f.options);
  const request = JSON.parse(f.$.http.fetch.mock.calls[1][1].body).request;
  expect(request.manual.model).toEqual({ source: "manual", value: "native" });
  expect(request.manual.reasoning).toEqual({ source: "manual", value: "medium" });
  expect(result.manual).toEqual(request.manual);
});
it("releases explicit auto axes while retaining later native settings changes", async () => {
  const f = fixture(); f.settings.effortLevel = "medium";
  f.options.manual = { model: { source: "inherited" }, reasoning: { source: "inherited" } };
  f.$.http.fetch.mockImplementation(async () => response({ ready: true, decision: { status: "preserved", diagnostics: [] } }));
  const input = ordinary(); input.manual = structuredClone(f.options.manual);
  const first = await prepareClaudeRoute(f.$, input, f.options); expect(first.manual.reasoning.source).toBe("inherited");
  f.settings.effortLevel = "low"; const second = await prepareClaudeRoute(f.$, { ...input, manual: first.manual, current: { axes: { model: "native", reasoning: "low" } } }, f.options);
  expect(second.manual.reasoning).toEqual({ source: "manual", value: "low" });
});
it("does not fetch provider metadata when the local catalog remains usable", async () => {
  const f = fixture(); f.$.http.fetch.mockResolvedValueOnce(response({ ready: true })).mockResolvedValueOnce(response({ decision: { status: "proposed", changes: { reasoning: "high" }, diagnostics: [] } }));
  await prepareClaudeRoute(f.$, ordinary(), f.options); expect(f.$.session.authorize).not.toHaveBeenCalled(); expect(f.$.config.list).not.toHaveBeenCalled();
});
it.each(["availableModels", "deniedModels", "enforceAvailableModels", "maxEffortLevel", "modelOverrides", "availableModelsMatch"])("preserves a native %s policy whose Mods enforcement is not verified", async key => {
  const f = fixture(); f.settings[key] = key === "modelOverrides" ? {} : [];
  f.$.http.fetch.mockResolvedValueOnce(response({ ready: true }));
  const result = await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(result).toMatchObject({ status: "preserved", diagnostics: [{ code: "native_policy_unverified" }] });
  expect(f.$.session.authorize).not.toHaveBeenCalled(); expect(f.$.http.fetch).toHaveBeenCalledTimes(1);
});
it("does not use a scratch runtime's default alias mappings when the native session overrides them", async () => {
  const f = fixture(); f.$.env.get.mockImplementation(async name => name === "ANTHROPIC_DEFAULT_OPUS_MODEL" ? "custom-native-deployment" : undefined);
  f.$.http.fetch.mockResolvedValueOnce(response({ ready: true }));
  const result = await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(result.diagnostics[0].code).toBe("native_policy_unverified"); expect(f.$.session.authorize).not.toHaveBeenCalled();
});
it("preserves a session-only native axis change even when no settings or classic event changes", async () => {
  const f = fixture(); f.options.manual = { model: { source: "inherited" }, reasoning: { source: "inherited" } };
  f.$.http.fetch.mockImplementation(async () => response({ ready: true, decision: { status: "preserved", diagnostics: [] } }));
  const first = await prepareClaudeRoute(f.$, { ...ordinary(), manual: f.options.manual }, f.options);
  const second = await prepareClaudeRoute(f.$, { ...ordinary(), manual: first.manual, current: { axes: { model: "new-native", reasoning: "low" } } }, f.options);
  expect(second.manual).toEqual({ model: { source: "unknown" }, reasoning: { source: "unknown" } });
});
it("validates unknown manual lineage against native axes instead of a different previously observed model", async () => {
  const f = fixture(); f.$.http.fetch.mockResolvedValueOnce(response({ ready: true })).mockResolvedValueOnce(response({ decision: { status: "preserved", diagnostics: [] } }));
  await prepareClaudeRoute(f.$, { ...ordinary(), current: { axes: { model: "previous-observed", reasoning: "high" }, turnExecuted: true }, nativeAxes: { model: "native-ui", reasoning: "low" }, manual: { model: { source: "unknown" }, reasoning: { source: "unknown" } } }, f.options);
  const passed = JSON.parse(f.$.http.fetch.mock.calls[1][1].body).request;
  expect(passed.current.axes).toEqual({ model: "native-ui", reasoning: "low" });
});
it.each(["missing authorization", "HTTP failure", "invalid pagination"])("preserves the native configuration on %s", async failure => {
  const f = fixture(); f.$.http.fetch.mockResolvedValueOnce(response({ ready: true })).mockResolvedValueOnce(response({ needsEvidence: true }));
  if (failure === "missing authorization") f.$.session.authorize.mockResolvedValue(null);
  else if (failure === "HTTP failure") f.$.http.fetch.mockResolvedValueOnce({ status: 503, ok: false, text: "private" });
  else f.$.http.fetch.mockResolvedValue(response({ data: [], has_more: true }));
  await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow();
  expect(f.$.http.fetch.mock.calls.filter(([url]) => url.startsWith("http:")).length).toBe(2);
});

// This responder validates the wire protocol rather than relying on call order alone.
function protocol(f, pages = [{ data: [{ id: "opaque-model" }], has_more: false }]) {
  const received = [];
  f.$.http.fetch.mockImplementation(async (url, init) => {
    if (url.startsWith("https:")) {
      expect(init).toEqual({ method: "GET", auth: "opaque-native-handle", headers: { accept: "application/json", "anthropic-version": "2023-06-01" } });
      expect(url).not.toContain("Implement");
      return response(pages.shift());
    }
    expect(url).toBe("http://localhost/prepare");
    expect(init.method).toBe("POST"); expect(init.socketPath).toBe(f.options.socketPath);
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(init).not.toHaveProperty("auth");
    const body = JSON.parse(init.body); received.push(body);
    if (body.action === "activation") {
      expect(body.request).toEqual({ repoRoot: root, prompt: "", runtimeVersion: "2.1.302" });
      expect(body).not.toHaveProperty("native"); return response({ ready: true });
    }
    expect(body.action).toBe("prepare");
    expect(body.request.prompt).toBe(ordinary().prompt);
    expect(body.request.runtimeVersion).toBe("2.1.302");
    return response(body.native ? { decision: { status: "proposed", diagnostics: [] } } : { needsEvidence: true });
  });
  return received;
}

it("sends paginated metadata without changing the original prompt or authorization boundary", async () => {
  const f = fixture(); const pages = [
    { data: [{ id: "one" }], has_more: true, last_id: "one + /?" },
    { data: [{ id: "two" }], has_more: false },
  ];
  const expected = structuredClone(pages); const received = protocol(f, pages);
  const before = new Date().getTime(); await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(f.$.http.fetch.mock.calls.filter(([url]) => url.startsWith("https:")).map(([url]) => url)).toEqual([
    "https://api.anthropic.com/v1/models?limit=100", "https://api.anthropic.com/v1/models?limit=100&after_id=one%20%2B%20%2F%3F",
  ]);
  expect(received).toHaveLength(3);
  expect(received[2].native).toMatchObject({ version: "2.1.302", selectors: ["small", "large"], providerPages: expected });
  const observed = Date.parse(received[2].native.observedAt);
  expect(observed).toBeGreaterThanOrEqual(before); expect(observed).toBeLessThanOrEqual(Date.now());
  expect(received[2].request).toEqual(received[1].request);
});

it.each([undefined, 7, "relative", "/" + "a".repeat(100)])("rejects an invalid private socket before HTTP: %s", async socketPath => {
  const f = fixture(); f.options.socketPath = socketPath;
  await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow("native_bridge_unavailable");
  expect(f.$.http.fetch).not.toHaveBeenCalled();
});

it.each([
  { ok: false, text: "{}" }, { ok: true, text: 3 },
  { ok: true, text: " ".repeat(262143) + "{}" }, { ok: true, text: "{" },
])("rejects failed, malformed or oversized IPC responses", async invalid => {
  const f = fixture(); f.$.http.fetch.mockResolvedValue(invalid);
  await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow();
  expect(f.$.settings.read).not.toHaveBeenCalled(); expect(f.$.session.authorize).not.toHaveBeenCalled();
});

it("accepts a valid IPC response exactly at its size boundary", async () => {
  const f = fixture(); const text = JSON.stringify({ decision: { status: "preserved" } });
  f.$.http.fetch.mockResolvedValue({ ok: true, text: text.padEnd(262144) });
  expect(await prepareClaudeRoute(f.$, ordinary(), f.options)).toEqual({ status: "preserved" });
});

it.each([undefined, [], Array(33).fill("model"), [""], [2], ["a".repeat(201)], ["x\u0000"], ["x\u200d"]])("rejects invalid native selectors before authorization: %j", async selectors => {
  const f = fixture(); protocol(f); f.$.config.list.mockResolvedValue([{ key: "other", options: ["ignored"] }, { key: "model", options: selectors }]);
  await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow("native_catalog_invalid");
  expect(f.$.session.authorize).not.toHaveBeenCalled();
});

it("accepts the native selector count and value boundaries", async () => {
  const f = fixture(); const received = protocol(f); const selectors = Array.from({ length: 32 }, (_, index) => `${index}`.padEnd(200, "x"));
  f.$.config.list.mockResolvedValue([{ key: "model", options: selectors }]);
  await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(received.at(-1).native.selectors).toEqual(selectors);
});

it.each([
  [{ data: [], has_more: "false" }], [{ data: {}, has_more: false }],
  [{ data: [], has_more: true, last_id: "a" }, { data: [], has_more: true, last_id: "a" }],
  [{ data: [], has_more: true, last_id: "x".repeat(201) }],
  [{ data: [], has_more: true, last_id: "x\u0000" }],
  Array.from({ length: 10 }, (_, index) => ({ data: [], has_more: true, last_id: String(index) })),
].map(pages => [pages]))("rejects malformed, repeated or unbounded provider pagination", async pages => {
  const f = fixture(); protocol(f, pages);
  await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow("native_catalog_invalid");
  expect(f.$.http.fetch.mock.calls.filter(([url, init]) => url.startsWith("http:") && JSON.parse(init.body).native)).toHaveLength(0);
});

it("accepts the tenth terminal provider page and never asks for an eleventh", async () => {
  const f = fixture(); const pages = Array.from({ length: 10 }, (_, index) => ({ data: [], has_more: index !== 9, last_id: String(index) }));
  const received = protocol(f, pages); await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(received.at(-1).native.providerPages).toHaveLength(10);
  expect(f.$.http.fetch.mock.calls.filter(([url]) => url.startsWith("https:"))).toHaveLength(10);
});

it.each(["nontext", "too large", "aggregate too large"])("rejects %s provider bodies", async variant => {
  const f = fixture(); protocol(f);
  const real = f.$.http.fetch.getMockImplementation(); let count = 0;
  f.$.http.fetch.mockImplementation(async (url, init) => {
    if (!url.startsWith("https:")) return real(url, init);
    count++;
    if (variant === "nontext") return { ok: true, text: 4 };
    if (variant === "too large") return { ok: true, text: " ".repeat(262145) };
    return { ok: true, text: JSON.stringify({ data: [], has_more: true, last_id: String(count) }).padEnd(140000) };
  });
  await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow("native_catalog_unavailable");
  expect(count).toBe(variant === "aggregate too large" ? 2 : 1);
});

it("accepts a terminal provider response exactly at its size boundary", async () => {
  const f = fixture(); protocol(f); const real = f.$.http.fetch.getMockImplementation();
  f.$.http.fetch.mockImplementation(async (url, init) => url.startsWith("https:") ? { ok: true, text: JSON.stringify({ data: [], has_more: false }).padEnd(262144) } : real(url, init));
  expect((await prepareClaudeRoute(f.$, ordinary(), f.options)).status).toBe("proposed");
});

it.each(["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"])("does not override the native %s control", async name => {
  const f = fixture(); f.$.env.get.mockImplementation(async key => key === name ? "configured" : undefined);
  f.$.http.fetch.mockResolvedValue(response({ ready: true }));
  expect((await prepareClaudeRoute(f.$, ordinary(), f.options)).diagnostics).toEqual([{ code: "native_policy_unverified" }]);
  expect(f.$.http.fetch).toHaveBeenCalledTimes(1);
});

it("preserves even another model's native maximum effort until enforcement is verified", async () => {
  const f = fixture(); f.settings.modelSettings = { other: { maxEffortLevel: "medium" } };
  f.$.http.fetch.mockResolvedValue(response({ ready: true }));
  expect((await prepareClaudeRoute(f.$, ordinary(), f.options)).diagnostics).toEqual([{ code: "native_policy_unverified" }]);
});

it("uses model-specific effort before global or environment controls, with independent manual axes", async () => {
  const f = fixture(); f.settings.modelSettings = { native: { effortLevel: "low" } }; f.settings.effortLevel = "high";
  f.$.env.get.mockImplementation(async key => key === "CLAUDE_CODE_EFFORT_LEVEL" ? "medium" : undefined);
  f.$.http.fetch.mockImplementation(async () => response({ ready: true, decision: { status: "preserved" } }));
  const first = await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(first.manual).toEqual({ model: { source: "inherited" }, reasoning: { source: "manual", value: "medium" } });
  expect(f.options.state.signatures.reasoning).toBe('"low"');
  expect(f.options.state.axes).toEqual(ordinary().current.axes);
});

it("reads environment intent without forwarding its private values, and rejects invalid actual manual axes", async () => {
  const f = fixture(); f.$.env.get.mockImplementation(async key => key === "ANTHROPIC_MODEL" ? "private-alias" : undefined);
  f.$.http.fetch.mockImplementation(async () => response({ ready: true, decision: { status: "preserved" } }));
  const input = ordinary(); input.current.axes.model = "x\u0000";
  const result = await prepareClaudeRoute(f.$, input, f.options);
  expect(result.manual.model).toEqual({ source: "unknown" });
  expect(JSON.stringify(f.$.http.fetch.mock.calls)).not.toContain("private-alias");
});
