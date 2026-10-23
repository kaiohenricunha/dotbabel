import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import * as opencode from "../src/model-intelligence/sources/runtime/opencode.mjs";
import { validateDescriptor } from "../src/model-intelligence/sources/contract.mjs";
import { makeResolvedRuntimeConfiguration } from "../src/model-intelligence/domain/index.mjs";
import { SOURCE_ADAPTERS } from "../src/model-intelligence/sources/index.mjs";
import { fakeRunner, outcome, textFixture, snapshotTree, fixedNow } from "./fixtures/model-intelligence/fake-runner.mjs";

const context = (respond, env = { PATH: "/usr/bin" }) => { const runner = fakeRunner(respond); return { runner, ctx: { runCommand: runner.runCommand, env, homeDir: makeTempDir("mi-opencode-home-"), now: fixedNow } }; };
const listing = stdout => spec => spec.args.includes("--version") ? outcome({ stdout: "2.0.5\n" }) : outcome({ stdout });
const make = (runtimeId, axes) => makeResolvedRuntimeConfiguration({ runtimeId, axes, representation: { kind: "native-id", provenance: { sourceId: runtimeId, sourceKind: "runtime" } } });

describe("OpenCode runtime source adapter (P-22d)", () => {
  it("descriptor matches the measured capability row of DOC-2 for opencode", () => {
    expect(validateDescriptor(opencode.descriptor).errors).toEqual([]);
    const c = opencode.descriptor.capabilities;
    // The list is config-scoped: an isolated run always prints nothing, so discovery is unverified.
    expect(c.discovery).toMatchObject({ support: "unverified", network: "never", auth: "none" });
    expect(c.observation).toEqual({ support: "unsupported" });
    expect(c.validation).toEqual({ support: "unsupported" });
    // `run --model provider/model#variant`; no effort flag (`--thinking` only shows thinking blocks).
    expect(c.invocation).toEqual({ support: "supported", axes: { model: "supported", reasoning: "unsupported" } });
  });

  it("binding for skill stays unsupported and agent model stays unverified, the Phase 0 rows", () => {
    expect(opencode.descriptor.capabilities.binding).toEqual({
      skill: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } },
      agent: { support: "unverified", axes: { model: "unverified", reasoning: "unsupported" } },
    });
  });

  it("discover() parses the recorded DOC-2 listing into provider/model facts", async () => {
    const { ctx } = context(listing(textFixture("opencode", "models-warm-doc2.txt")));
    const result = await opencode.discover(ctx);
    expect(result.status).toBe("ok");
    expect(result.evidence.models.map(model => model.id)).toEqual(["local-qwen/qwen3-coder-30b-a3b", "opencode/big-pickle", "opencode/ling-3.0-flash-fin-free", "opencode/union-alpha"]);
    expect(result.provenance).toMatchObject({ sourceId: "opencode", sourceVersion: "2.0.5" });
  });

  it("exit 0 with empty output is unknown, never an empty catalog (ARCH-30)", async () => {
    const { ctx } = context(listing(""));
    const result = await opencode.discover(ctx);
    expect(result.status).toBe("unknown");
    expect(result.diagnostic.code).toBe("empty_output");
    expect(result.evidence).toBeUndefined();
  });

  it("skips malformed rows by DOC-2's defensive rules (synthetic input)", async () => {
    const { ctx } = context(listing("opencode/ok-model\nno-slash-row\na/b/c\nopencode/variant#high\n\nopencode/ok-model\n"));
    const result = await opencode.discover(ctx);
    expect(result.status).toBe("ok");
    expect(result.evidence.models.map(model => model.id)).toEqual(["opencode/ok-model"]);
    expect(result.evidence.skipped).toBeGreaterThanOrEqual(3);
  });

  it("reports a nonzero exit as unavailable", async () => {
    const { ctx } = context(() => outcome({ exitCode: 1, stderr: "ClientError: Transport\n" }));
    expect((await opencode.discover(ctx)).status).toBe("unavailable");
  });

  it("runs its private server with only loopback exempt from the dead proxy, in a scratch home", async () => {
    const { runner, ctx } = context(listing(""), { PATH: "/usr/bin", OPENAI_API_KEY: "fixture-credential-never-forwarded" });
    await opencode.discover(ctx);
    const call = runner.calls.find(spec => spec.args.includes("models"));
    expect(call.args).toEqual(["models", "--standalone"]);
    expect(call.env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(call.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(JSON.stringify(call.env)).not.toMatch(/fixture-credential/);
  });

  it("reports a truncated listing as unknown malformed output, and names the nonzero exit", async () => {
    const truncated = await opencode.discover(context(() => outcome({ stdout: "opencode/a\n", truncated: true })).ctx);
    expect(truncated).toMatchObject({ status: "unknown", diagnostic: { code: "malformed_output" } });
    expect(truncated.diagnostic.message).toMatch(/size limit/);
    const failed = await opencode.discover(context(() => outcome({ exitCode: 3, stderr: "ClientError: Transport\nmore\n" })).ctx);
    expect(failed.diagnostic).toEqual({ code: "nonzero_exit", message: "ClientError: Transport" });
    const silent = await opencode.discover(context(() => outcome({ exitCode: 3 })).ctx);
    expect(silent.diagnostic.message).toBe("opencode models exited 3");
  });

  it("parseModels() trims rows, ignores blank lines, and counts duplicates as skipped", () => {
    const parsed = opencode.parseModels("  opencode/a  \n\n\nopencode/a\nOpencode/caps\n");
    expect(parsed.models.map(model => model.id)).toEqual(["opencode/a"]);
    expect(parsed.skipped).toBe(2);
  });

  it("runs the real command name with its scratch prefix, and stamps the probed version", async () => {
    const { runner, ctx } = context(listing("opencode/a\n"));
    const result = await opencode.discover(ctx);
    expect(runner.calls.map(call => call.command)).toEqual(["opencode", "opencode"]);
    expect(runner.calls[1].args).toEqual(["--version"]);
    expect(result.provenance.sourceVersion).toBe("2.0.5");
  });

  it("validate() accepts a reasoning-only input and refuses an input that names no axis", async () => {
    const { ctx } = context(() => { throw new Error("must not run"); });
    expect((await opencode.validate({ reasoning: "high" }, ctx)).status).toBe("unsupported");
    for (const input of [{}, null, "opencode/a"]) await expect(opencode.validate(input, ctx)).rejects.toThrow(/opencode validate: input must name a model or a reasoning value/);
  });

  it("observe() and validate() report unsupported without starting a process", async () => {
    const { runner, ctx } = context(() => { throw new Error("must not run"); });
    expect(await opencode.observe(ctx)).toMatchObject({ status: "unsupported", diagnostic: { code: "provider_required" } });
    expect((await opencode.validate({ model: "opencode/big-pickle" }, ctx)).status).toBe("unsupported");
    expect(runner.calls).toHaveLength(0);
  });

  it("renderInvocation() returns structured argv before any shell string", () => {
    expect(opencode.renderInvocation(make("opencode", { model: "opencode/big-pickle" }))).toMatchObject({ command: "opencode", args: ["run", "--model", "opencode/big-pickle"], unsupportedAxes: [] });
    expect(opencode.renderInvocation(make("opencode", { model: "opencode/big-pickle", reasoning: "high" })).unsupportedAxes).toEqual(["reasoning"]);
    expect(() => opencode.renderInvocation(make("codex", { model: "x" }))).toThrow(/opencode/);
  });

  it("the adapter never writes under the runtime configuration root (SEC-1)", async () => {
    const home = makeTempDir("mi-opencode-real-"); const realRoot = join(home, ".config", "opencode");
    mkdirSync(realRoot, { recursive: true }); writeFileSync(join(realRoot, "opencode.json"), "{}");
    const before = snapshotTree(realRoot); const writtenTo = [];
    const runner = fakeRunner(spec => { writtenTo.push(spec.env.HOME); mkdirSync(join(spec.env.HOME, ".local", "share", "opencode"), { recursive: true }); writeFileSync(join(spec.env.HOME, ".local", "share", "opencode", "opencode.db"), "x"); return spec.args.includes("--version") ? outcome({ stdout: "2.0.5\n" }) : outcome(); });
    await opencode.discover({ runCommand: runner.runCommand, env: { PATH: "/usr/bin", OPENCODE_CONFIG_DIR: realRoot }, homeDir: home, now: fixedNow });
    expect(snapshotTree(realRoot)).toEqual(before);
    for (const dir of writtenTo) expect(dir.startsWith(home)).toBe(false);
  });

  it("ships as a source adapter after the existing runtimes", () => {
    const ids = SOURCE_ADAPTERS.map(module => module.descriptor.id);
    expect(ids.indexOf("opencode")).toBeGreaterThan(ids.indexOf("gemini"));
  });
});
