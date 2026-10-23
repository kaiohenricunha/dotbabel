import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import * as antigravity from "../src/model-intelligence/sources/runtime/antigravity.mjs";
import { validateDescriptor } from "../src/model-intelligence/sources/contract.mjs";
import { makeResolvedRuntimeConfiguration } from "../src/model-intelligence/domain/index.mjs";
import { SOURCE_ADAPTERS } from "../src/model-intelligence/sources/index.mjs";
import { fakeRunner, outcome, textFixture, snapshotTree, fixedNow } from "./fixtures/model-intelligence/fake-runner.mjs";

const context = (respond, env = { PATH: "/usr/bin" }) => { const runner = fakeRunner(respond); return { runner, ctx: { runCommand: runner.runCommand, env, homeDir: makeTempDir("mi-agy-home-"), now: fixedNow } }; };
const listing = stdout => spec => spec.args.includes("--version") ? outcome({ stdout: "1.4.2\n" }) : outcome({ stdout, stderr: "Fetching available models...\n" });
const make = (runtimeId, axes) => makeResolvedRuntimeConfiguration({ runtimeId, axes, representation: { kind: "native-id", provenance: { sourceId: runtimeId, sourceKind: "runtime" } } });

describe("Antigravity runtime source adapter (P-22c)", () => {
  it("descriptor matches the measured capability row of DOC-2 for antigravity", () => {
    expect(validateDescriptor(antigravity.descriptor).errors).toEqual([]);
    expect(antigravity.RUNTIME_ID).toBe("antigravity");
    const c = antigravity.descriptor.capabilities;
    // 1.4.2 requires a sign-in to list models; the parser follows DOC-2's recorded 1.2.5 grammar.
    expect(c.discovery).toMatchObject({ support: "unverified", network: "required", auth: "none" });
    expect(c.observation).toEqual({ support: "unsupported" });
    expect(c.validation).toEqual({ support: "unsupported" });
    // `--model` and `--effort (low|medium|high|xhigh|max)` are session flags in `agy --help`.
    expect(c.invocation).toEqual({ support: "supported", axes: { model: "supported", reasoning: "supported" } });
  });

  it("binding stays unverified for skill and agent, the Phase 0 rows", () => {
    expect(antigravity.descriptor.capabilities.binding).toEqual({
      skill: { support: "unverified", axes: { model: "unverified", reasoning: "unverified" } },
      agent: { support: "unverified", axes: { model: "unverified", reasoning: "unverified" } },
    });
  });

  it("discover() parses the recorded DOC-2 TSV and keeps opaque selectors verbatim", async () => {
    const { ctx } = context(listing(textFixture("antigravity", "models-doc2-1.2.5.tsv")));
    const result = await antigravity.discover(ctx);
    expect(result.status).toBe("ok");
    expect(result.evidence.models).toHaveLength(14);
    expect(result.evidence.models[0]).toMatchObject({ id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)" });
    expect(result.evidence.models.map(model => model.id)).toContain("claude-opus-4-6-thinking");
    // The suffix slot is not an effort field (DOC-2): no per-model effort is inferred from an id.
    for (const model of result.evidence.models) expect(model.supportedReasoningLevels).toEqual([]);
    expect(result.provenance).toMatchObject({ sourceId: "antigravity", sourceVersion: "1.4.2" });
  });

  it("a sign-in refusal is unavailable, never an empty catalog (recorded on 1.4.2)", async () => {
    const stderr = textFixture("antigravity", "models-sign-in-1.4.2.stderr");
    const result = await antigravity.discover(context(() => outcome({ exitCode: 1, stdout: "Fetching available models...\n", stderr })).ctx);
    expect(result).toMatchObject({ status: "unavailable", diagnostic: { code: "sign_in_required" } });
    expect(result.evidence).toBeUndefined();
  });

  it("other failures are unavailable with the first stderr line, and empty output is unknown", async () => {
    const failed = await antigravity.discover(context(() => outcome({ exitCode: 2, stderr: "boom\nmore\n" })).ctx);
    expect(failed.diagnostic).toEqual({ code: "nonzero_exit", message: "boom" });
    expect((await antigravity.discover(context(() => outcome({ exitCode: 2 })).ctx)).diagnostic.message).toBe("agy models exited 2");
    const empty = await antigravity.discover(context(listing("")).ctx);
    expect(empty).toMatchObject({ status: "unknown", diagnostic: { code: "empty_output" } });
    const truncated = await antigravity.discover(context(() => outcome({ stdout: "a\tA\n", truncated: true })).ctx);
    expect(truncated).toMatchObject({ status: "unknown", diagnostic: { code: "malformed_output" } });
  });

  it("parseModels() skips rows without exactly one TAB, blank ids, and duplicates (synthetic input)", () => {
    const parsed = antigravity.parseModels("ok-model\tOk Model\nno-tab-row\na\tb\tc\n\tNo Id\n\nok-model\tOk Model\n  spaced  \t  Spaced  \n");
    expect(parsed.models.map(model => [model.id, model.displayName])).toEqual([["ok-model", "Ok Model"], ["spaced", "Spaced"]]);
    expect(parsed.skipped).toBe(4);
  });

  it("observe() and validate() report unsupported without starting a process", async () => {
    const { runner, ctx } = context(() => { throw new Error("must not run"); });
    expect(await antigravity.observe(ctx)).toMatchObject({ status: "unsupported", diagnostic: { code: "credential_required" } });
    expect((await antigravity.validate({ reasoning: "high" }, ctx)).status).toBe("unsupported");
    for (const input of [{}, null]) await expect(antigravity.validate(input, ctx)).rejects.toThrow(/antigravity validate: input must name a model or a reasoning value/);
    expect(runner.calls).toHaveLength(0);
  });

  it("renderInvocation() returns structured argv for both axes before any shell string", () => {
    expect(antigravity.renderInvocation(make("antigravity", { model: "gemini-3.8-flash-high", reasoning: "xhigh" }))).toMatchObject({ command: "agy", args: ["--model", "gemini-3.8-flash-high", "--effort", "xhigh"], unsupportedAxes: [] });
    expect(antigravity.renderInvocation(make("antigravity", { model: "m", contextTier: "1m" })).unsupportedAxes).toEqual(["contextTier"]);
    expect(() => antigravity.renderInvocation(make("codex", { model: "m" }))).toThrow(/antigravity/);
  });

  it("runs agy models in a scratch home with no credential and every proxy dead (SEC-1)", async () => {
    const home = makeTempDir("mi-agy-real-"); const realRoot = join(home, ".gemini");
    mkdirSync(join(realRoot, "antigravity-cli"), { recursive: true }); writeFileSync(join(realRoot, "settings.json"), "{}");
    const before = snapshotTree(realRoot); const calls = [];
    const runner = fakeRunner(spec => { calls.push(spec); mkdirSync(join(spec.env.HOME, ".gemini", "config"), { recursive: true }); writeFileSync(join(spec.env.HOME, ".gemini", "config", "mcp_config.json"), "{}"); return spec.args.includes("--version") ? outcome({ stdout: "1.4.2\n" }) : outcome({ stdout: "a\tA\n" }); });
    await antigravity.discover({ runCommand: runner.runCommand, env: { PATH: "/usr/bin", GEMINI_API_KEY: "fixture-credential-never-forwarded", GEMINI_HOME: realRoot }, homeDir: home, now: fixedNow });
    expect(snapshotTree(realRoot)).toEqual(before);
    for (const call of calls) {
      expect(call.env.HOME.startsWith(home)).toBe(false);
      expect(JSON.stringify(call.env)).not.toMatch(/fixture-credential/);
      expect(call.env.HTTPS_PROXY).toBe("http://127.0.0.1:9"); expect(call.env.NO_PROXY).toBe("");
    }
    expect(calls[0]).toMatchObject({ command: "agy", args: ["models"] });
  });

  it("ships as a source adapter after the existing runtimes", () => {
    const ids = SOURCE_ADAPTERS.map(module => module.descriptor.id);
    expect(ids.indexOf("antigravity")).toBeGreaterThan(ids.indexOf("gemini"));
  });
});
