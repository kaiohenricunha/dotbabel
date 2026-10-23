import { expect, it, vi } from "vitest";
import { prepareClaudeRoute } from "../src/adaptive-session-routing/claude-mod-prepare.mjs";

const root = "/project";
const prompt = "Implement integration tests for the payment gateway.";
const ordinary = () => ({ repoRoot: root, prompt, current: { axes: { model: "native", reasoning: "medium" } }, manual: { model: { source: "inherited" }, reasoning: { source: "inherited" } } });
const ran = body => ({ exitCode: 0, stdout: `${JSON.stringify(body)}\n`, stderr: "" });
const response = body => ({ status: 200, ok: true, text: JSON.stringify(body) });
const argv = ["/usr/bin/node", "/opt/dotbabel/bin/dotbabel-models.mjs", "route"];
function fixture() {
  const $ = { session: { id: vi.fn(async () => "5f0c2a8e-1b2c-4d3e-9f00-0123456789ab"), version: vi.fn(async () => ({ version: "2.1.309" })), authorize: vi.fn(async () => ({ handle: "opaque-native-handle" })) },
    settings: { read: vi.fn(async () => ({})) }, env: { get: vi.fn(async () => undefined) }, config: { list: vi.fn(async () => [{ key: "model", options: ["haiku"] }]) },
    http: { fetch: vi.fn(async () => response({ data: [{ id: "claude-haiku-5-5" }], has_more: false })) }, process: { run: vi.fn() } };
  const options = { transport: { kind: "process", argv }, state: {}, manual: { model: { source: "inherited" }, reasoning: { source: "inherited" } } };
  return { $, options };
}

it("sends each request on stdin to the local route command and never puts the prompt in argv", async () => {
  const f = fixture();
  f.$.process.run.mockResolvedValueOnce(ran({ ready: true })).mockResolvedValueOnce(ran({ needsEvidence: true })).mockResolvedValueOnce(ran({ decision: { status: "proposed", changes: { model: "claude-haiku-5-5" }, diagnostics: [] } }));
  const result = await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(result.status).toBe("proposed");
  for (const [args, init] of f.$.process.run.mock.calls) {
    expect(args).toEqual(argv);
    expect(JSON.stringify(args)).not.toContain(prompt);
    expect(init.stdin).toBeTypeOf("string");
    expect(init.stdin).not.toContain("opaque-native-handle");
  }
  expect(JSON.parse(f.$.process.run.mock.calls[1][1].stdin).request.prompt).toBe(prompt);
  for (const [, init] of f.$.process.run.mock.calls) expect(JSON.parse(init.stdin).session).toBe("5f0c2a8e-1b2c-4d3e-9f00-0123456789ab");
  expect(f.$.http.fetch.mock.calls.every(([url]) => url.startsWith("https://api.anthropic.com/"))).toBe(true);
});

it("sends no native evidence on a later turn, so the route command answers from its session cache without new probes", async () => {
  const f = fixture();
  f.$.process.run.mockResolvedValueOnce(ran({ ready: true })).mockResolvedValueOnce(ran({ needsEvidence: true })).mockResolvedValueOnce(ran({ decision: { status: "preserved", diagnostics: [] } }))
    .mockResolvedValueOnce(ran({ ready: true })).mockResolvedValueOnce(ran({ decision: { status: "preserved", diagnostics: [] } }));
  await prepareClaudeRoute(f.$, ordinary(), f.options);
  await prepareClaudeRoute(f.$, ordinary(), f.options);
  expect(f.$.process.run).toHaveBeenCalledTimes(5);
  expect(JSON.parse(f.$.process.run.mock.calls[4][1].stdin)).not.toHaveProperty("native");
  expect(f.$.http.fetch).toHaveBeenCalledTimes(1);
});

it("treats a failed or unparsable route command as an unavailable bridge, never as a decision", async () => {
  for (const outcome of [{ exitCode: 64, stdout: "{}", stderr: "" }, { exitCode: 0, stdout: "not json", stderr: "" }]) {
    const f = fixture(); f.$.process.run.mockResolvedValueOnce(outcome);
    await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow(/native_bridge_unavailable/);
  }
});

it("refuses a process transport without an absolute command path", async () => {
  const f = fixture(); f.options.transport = { kind: "process", argv: ["dotbabel", "models", "route"] };
  await expect(prepareClaudeRoute(f.$, ordinary(), f.options)).rejects.toThrow(/native_bridge_unavailable/);
  expect(f.$.process.run).not.toHaveBeenCalled();
});
