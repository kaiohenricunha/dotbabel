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
it.each(["missing authorization", "HTTP failure", "invalid pagination"])("preserves the native configuration on %s", async failure => {
  const f = fixture(); f.$.http.fetch.mockResolvedValueOnce(response({ ready: true })).mockResolvedValueOnce(response({ needsEvidence: true }));
  if (failure === "missing authorization") f.$.session.authorize.mockResolvedValue(null);
  else if (failure === "HTTP failure") f.$.http.fetch.mockResolvedValueOnce({ status: 503, ok: false, text: "private" });
  else f.$.http.fetch.mockResolvedValue(response({ data: [], has_more: true }));
  await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow();
  expect(f.$.http.fetch.mock.calls.filter(([url]) => url.startsWith("http:")).length).toBe(2);
});
