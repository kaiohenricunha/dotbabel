import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import * as copilot from "../src/model-intelligence/sources/runtime/copilot.mjs";
import { validateDescriptor } from "../src/model-intelligence/sources/contract.mjs";
import { makeResolvedRuntimeConfiguration } from "../src/model-intelligence/domain/index.mjs";
import { SOURCE_ADAPTERS } from "../src/model-intelligence/sources/index.mjs";
import { fakeRunner, outcome, textFixture, snapshotTree, fixedNow } from "./fixtures/model-intelligence/fake-runner.mjs";

const context = (respond, env = { PATH: "/usr/bin" }) => { const runner = fakeRunner(respond); return { runner, ctx: { runCommand: runner.runCommand, env, homeDir: makeTempDir("mi-copilot-home-"), now: fixedNow } }; };
const help = stdout => spec => spec.args.includes("--version") ? outcome({ stdout: "GitHub Copilot CLI 1.0.98.\n" }) : outcome({ stdout });
const make = (runtimeId, axes) => makeResolvedRuntimeConfiguration({ runtimeId, axes, representation: { kind: "native-id", provenance: { sourceId: runtimeId, sourceKind: "runtime" } } });

describe("Copilot runtime source adapter (P-22b)", () => {
  it("descriptor matches the measured capability row of DOC-2 and Phase 0 for copilot", () => {
    expect(validateDescriptor(copilot.descriptor).errors).toEqual([]);
    const c = copilot.descriptor.capabilities;
    // The model list exists only as human help text, so discovery is unverified, never a machine contract.
    expect(c.discovery).toMatchObject({ support: "unverified", network: "never", auth: "none" });
    expect(c.observation).toEqual({ support: "unsupported" });
    expect(c.validation).toEqual({ support: "unsupported" });
    // `--model <model>` and `--reasoning-effort <none|minimal|low|medium|high|xhigh|max>`.
    expect(c.invocation).toEqual({ support: "supported", axes: { model: "supported", reasoning: "supported" } });
  });

  it("binding follows Phase 0: agent model unverified, agent effort, skill and .prompt.md unsupported", () => {
    expect(copilot.descriptor.capabilities.binding).toEqual({
      agent: { support: "unverified", axes: { model: "unverified", reasoning: "unsupported" } },
      skill: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } },
      command: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } },
    });
  });

  it("discover() reads the model list from the recorded help config text", async () => {
    const { ctx } = context(help(textFixture("copilot", "help-config-1.0.98.txt")));
    const result = await copilot.discover(ctx);
    expect(result.status).toBe("ok");
    const ids = result.evidence.models.map(model => model.id);
    expect(ids).toHaveLength(31);
    expect(ids.slice(0, 3)).toEqual(["claude-sonnet-5.5", "claude-sonnet-5", "claude-fable-5.1"]);
    expect(ids).toContain("gpt-5.6-luna");
    for (const model of result.evidence.models) expect(model.supportedReasoningLevels).toEqual([]);
    expect(result.provenance).toMatchObject({ sourceId: "copilot", sourceVersion: "1.0.98" });
  });

  it("parseHelpModels() takes only the quoted items directly under the model key (synthetic input)", () => {
    const text = "  `logLevel`: x\n    - \"not-a-model\"\n\n  `model`: AI model to use\n    - \"a-1\"\n    - \"b-2\"\n    - \"a-1\"\n    - \"--model\"\n    - When true, something\n  `other`: y\n    - \"c-3\"\n";
    expect(copilot.parseHelpModels(text)).toEqual({ ids: ["a-1", "b-2"], skipped: 2 });
    expect(copilot.parseHelpModels("no model key\n")).toEqual({ ids: [], skipped: 0 });
  });

  it("help text without the model list is unknown, and a nonzero exit is unavailable", async () => {
    expect(await copilot.discover(context(help("  `logLevel`: x\n")).ctx)).toMatchObject({ status: "unknown", diagnostic: { code: "model_list_absent" } });
    const failed = await copilot.discover(context(() => outcome({ exitCode: 1, stderr: "boom\nmore\n" })).ctx);
    expect(failed).toMatchObject({ status: "unavailable", diagnostic: { code: "nonzero_exit", message: "boom" } });
    expect((await copilot.discover(context(() => outcome({ exitCode: 4 })).ctx)).diagnostic.message).toBe("copilot help config exited 4");
    expect(await copilot.discover(context(() => outcome({ stdout: "x", truncated: true })).ctx)).toMatchObject({ status: "unknown", diagnostic: { code: "malformed_output" } });
  });

  it("observe() and validate() report unsupported without starting a process", async () => {
    const { runner, ctx } = context(() => { throw new Error("must not run"); });
    expect(await copilot.observe(ctx)).toMatchObject({ status: "unsupported", diagnostic: { code: "credential_required" } });
    expect((await copilot.validate({ reasoning: "high" }, ctx)).status).toBe("unsupported");
    for (const input of [{}, null]) await expect(copilot.validate(input, ctx)).rejects.toThrow(/copilot validate: input must name a model or a reasoning value/);
    expect(runner.calls).toHaveLength(0);
  });

  it("renderInvocation() returns structured argv for both axes before any shell string", () => {
    expect(copilot.renderInvocation(make("copilot", { model: "claude-sonnet-5.5", reasoning: "high" }))).toMatchObject({ command: "copilot", args: ["--model", "claude-sonnet-5.5", "--reasoning-effort", "high"], unsupportedAxes: [] });
    expect(copilot.renderInvocation(make("copilot", { model: "m", contextTier: "long_context" })).unsupportedAxes).toEqual(["contextTier"]);
    expect(() => copilot.renderInvocation(make("codex", { model: "m" }))).toThrow(/copilot/);
  });

  it("runs help config in a scratch home with no credential and every proxy dead (SEC-1)", async () => {
    const home = makeTempDir("mi-copilot-real-"); const realRoot = join(home, ".copilot");
    mkdirSync(realRoot, { recursive: true }); writeFileSync(join(realRoot, "config.json"), "{}");
    const before = snapshotTree(realRoot); const calls = [];
    const runner = fakeRunner(spec => { calls.push(spec); mkdirSync(join(spec.env.COPILOT_HOME, "logs"), { recursive: true }); writeFileSync(join(spec.env.COPILOT_HOME, "logs", "a.log"), "x"); return spec.args.includes("--version") ? outcome({ stdout: "GitHub Copilot CLI 1.0.98.\n" }) : outcome({ stdout: "  `model`: m\n    - \"a-1\"\n" }); });
    await copilot.discover({ runCommand: runner.runCommand, env: { PATH: "/usr/bin", GH_TOKEN: "fixture-credential-never-forwarded", COPILOT_HOME: realRoot }, homeDir: home, now: fixedNow });
    expect(snapshotTree(realRoot)).toEqual(before);
    for (const call of calls) { expect(call.env.COPILOT_HOME.startsWith(realRoot)).toBe(false); expect(JSON.stringify(call.env)).not.toMatch(/fixture-credential/); expect(call.env.HTTPS_PROXY).toBe("http://127.0.0.1:9"); }
    expect(calls[0]).toMatchObject({ command: "copilot", args: ["help", "config"] });
  });

  it("ships as a source adapter after the existing runtimes", () => {
    const ids = SOURCE_ADAPTERS.map(module => module.descriptor.id);
    expect(ids.indexOf("copilot")).toBeGreaterThan(ids.indexOf("gemini"));
  });
});
