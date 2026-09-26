// Boundaries of the two runtime adapters and the modules under them.
//
// The named P-6 and P-7 tests prove the adapters' contracts. This file pins the edges a mutation run
// found unguarded: what a parser does with a line that is almost right, what a helper does at its
// limit, and the failure paths. Each test states the behavior it protects.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import { fakeRunner, outcome, enoent, fixedNow } from "./fixtures/model-intelligence/fake-runner.mjs";
import { optionalIdentifier, optionalCount, makeModelFact, makeDiscoveryEvidence, makeObservedConfiguration, makeInvocation, makeValidationEvidence } from "../src/model-intelligence/sources/evidence.mjs";
import * as claude from "../src/model-intelligence/sources/runtime/claude.mjs";
import * as codex from "../src/model-intelligence/sources/runtime/codex.mjs";
import { MAX_OUTPUT_BYTES, assertOutsideRoot, firstLine, probeVersion, resolveContext, runIsolated, runProcess } from "../src/model-intelligence/sources/runtime/process.mjs";

const BACKSLASH = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const ZERO_WIDTH = String.fromCharCode(0x200b);
const node = process.execPath;
const ROOT = { rootEnvVar: "CODEX_HOME", rootDirName: ".codex" };

const initLine = (fields = {}) => JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5", claude_code_version: "2.1.278", ...fields });
const resultLine = (fields = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });

describe("shared evidence helpers", () => {
  it("optionalIdentifier keeps a printable string up to 200 characters and drops everything else", () => {
    for (const good of ["a", "x".repeat(200), "claude-opus-5[1m]", "local-qwen/model#variant"]) expect(optionalIdentifier(good)).toBe(good);
    for (const bad of ["", "x".repeat(201), `tab${TAB}bed`, `zero${ZERO_WIDTH}width`, 5, null, undefined, {}, []]) expect(optionalIdentifier(bad)).toBeUndefined();
  });

  it("optionalCount keeps a finite non-negative number, including zero, and drops everything else", () => {
    for (const good of [0, 1, 0.5, 200000]) expect(optionalCount(good)).toBe(good);
    for (const bad of [-1, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) expect(optionalCount(bad)).toBeUndefined();
  });

  it("requires a recorded source for the provider and every axis, and keys each source by the field it describes", () => {
    const base = { runtimeId: "codex", turnExecuted: false, configurationBasis: "as-run", axes: { model: "m" }, fieldSources: { "axes.model": "a" } };
    expect(() => makeObservedConfiguration({ ...base, provider: "openai" })).toThrow(/fieldSources\["provider"\]/);
    expect(() => makeObservedConfiguration({ ...base, axes: { model: "m", reasoning: "high" } })).toThrow(/fieldSources\["axes.reasoning"\]/);
    const full = makeObservedConfiguration({ ...base, axes: { model: "m", reasoning: "high" }, provider: "openai", fieldSources: { "axes.model": "a", "axes.reasoning": "c", provider: "b" } });
    expect(full.fieldSources).toEqual({ "axes.model": "a", "axes.reasoning": "c", provider: "b" });
    // A source for a field that was not reported would be provenance for nothing, so it is refused.
    expect(() => makeObservedConfiguration({ ...base, fieldSources: { "axes.model": "a", provider: "b" } })).toThrow(/not reported/);
    // A source that is not a short printable label is refused like any other identifier.
    expect(() => makeObservedConfiguration({ ...base, fieldSources: { "axes.model": "" } })).toThrow(/fieldSources\["axes.model"\]/);
    expect(() => makeObservedConfiguration({ ...base, fieldSources: "exec-banner" })).toThrow(/fieldSources must be an object/);
  });

  it("accepts only facts that makeModelFact built, so freezing a forged object does not pass", () => {
    const built = makeModelFact({ id: "m", supportedReasoningLevels: [] });
    expect(makeDiscoveryEvidence({ models: [built] }).models).toHaveLength(1);
    const forged = { id: "m", supportedReasoningLevels: [], provider: "smuggled" };
    for (const bad of [forged, Object.freeze({ ...forged }), Object.freeze([built]), null, "m", 7]) {
      expect(() => makeDiscoveryEvidence({ models: [bad] })).toThrow(/built model facts/);
    }
  });

  it("requires supportVerbosity to be a boolean and each unsupported axis to be a name", () => {
    expect(() => makeModelFact({ id: "m", supportedReasoningLevels: [], supportVerbosity: "yes" })).toThrow(/supportVerbosity/);
    expect(makeModelFact({ id: "m", supportedReasoningLevels: [], supportVerbosity: false }).supportVerbosity).toBe(false);
    for (const bad of ["", 3, null, undefined]) {
      expect(() => makeInvocation({ runtimeId: "claude", command: "claude", args: [], unsupportedAxes: [bad] }), String(bad)).toThrow(/unsupportedAxes/);
    }
    expect(() => makeInvocation({ runtimeId: "claude", command: "claude", args: [], unsupportedAxes: "contextTier" })).toThrow(/unsupportedAxes/);
  });

  it("masks runtime text carried in a validation check and in a reasoning-level description", () => {
    const secret = "sk-ant-api03-AbCdEf0123456789";
    const fact = makeModelFact({ id: "m", supportedReasoningLevels: [{ effort: "low", description: `see ${secret}` }] });
    expect(fact.supportedReasoningLevels[0].description).not.toContain(secret);
    const evidence = makeValidationEvidence({ checks: [{ axis: "a", value: "v", verdict: "recognized", scope: "key" }] });
    expect(evidence.checks[0]).toEqual({ axis: "a", value: "v", verdict: "recognized", scope: "key" });
  });
});

describe("claude stream parsing boundaries", () => {
  it("keeps the first system/init, ignores other system events, and counts non-object lines as malformed", () => {
    const parsed = claude.parseStreamJson([initLine({ model: "first" }), initLine({ model: "second" }), JSON.stringify({ type: "system", subtype: "other", model: "nope" }), "[1,2]", "5", "null", '"text"'].join("\n"));
    expect(parsed.init.model).toBe("first");
    expect(parsed.malformedLines).toBe(4);
    expect(parsed.result).toBeUndefined();
    expect(parsed.empty).toBe(false);
  });

  it("takes an error result only when is_error is the boolean true, and the last result wins", () => {
    expect(claude.parseStreamJson(resultLine({ is_error: "true" })).result.isError).toBe(false);
    expect(claude.parseStreamJson(resultLine({ is_error: true })).result.isError).toBe(true);
    expect(claude.parseStreamJson([resultLine({ is_error: true }), resultLine({ is_error: false })].join("\n")).result.isError).toBe(false);
  });

  it("drops a usage entry or field of the wrong shape and never invents one", () => {
    const usage = { good: { thinkingTokens: 5, contextWindow: -1, provider: 7, canonicalModel: "c", maxOutputTokens: "big" }, "": { thinkingTokens: 1 }, bad: "text", list: [1], [`${"x".repeat(201)}`]: { thinkingTokens: 1 } };
    expect(claude.parseStreamJson(resultLine({ modelUsage: usage })).result.usage).toEqual([{ model: "good", canonicalModel: "c", thinkingTokens: 5 }]);
    for (const notAnObject of [[], null, "text", 5, undefined]) expect(claude.parseStreamJson(resultLine({ modelUsage: notAnObject })).result.usage, String(notAnObject)).toEqual([]);
  });

  it("reads the runtime version only when it has the shape of one", async () => {
    const ok = await claude.observe({ stream: initLine({ claude_code_version: "2.1.278" }), now: fixedNow });
    expect(ok.provenance.sourceVersion).toBe("2.1.278");
    expect(ok.evidence.runtimeVersion).toBe("2.1.278");
    const bad = await claude.observe({ stream: initLine({ claude_code_version: "not a version" }), now: fixedNow });
    expect(bad.status).toBe("ok");
    expect(Object.hasOwn(bad.provenance, "sourceVersion")).toBe(false);
    expect(Object.hasOwn(bad.evidence, "runtimeVersion")).toBe(false);
  });

  it("rejects a caller-supplied stream larger than the output cap, instead of parsing it unbounded", async () => {
    // Unlike a probed stream, which `runProcess`'s own cap already bounds, `context.stream` is
    // caller-supplied text with no upstream bound. This line is syntactically VALID JSON that names a
    // real model -- so without a size check it parses successfully (slowly) and returns "ok" -- to
    // prove the rejection comes from the size bound and not merely from a parse failure.
    const oversized = initLine({ padding: "x".repeat(MAX_OUTPUT_BYTES) });
    const result = await claude.observe({ stream: oversized, now: fixedNow });
    expect(result.status).toBe("unknown");
    expect(result.diagnostic.code).toBe("malformed_output");
  });

  it("explains why a stream is unusable, and distinguishes garbage from a stream that simply lacks the event", async () => {
    const observe = (stream) => claude.observe({ stream, now: fixedNow });
    const garbage = await observe("garbage");
    expect(garbage.diagnostic).toMatchObject({ code: "malformed_output" });
    expect(garbage.diagnostic.message).toContain("no readable stream-json event");
    // Garbage next to a real result is not "no readable event": the stream was readable, it just had no init.
    const withResult = await observe(["garbage", resultLine()].join("\n"));
    expect(withResult.diagnostic.code).toBe("insufficient_evidence");
    const noModel = await observe(initLine({ model: undefined }));
    expect(noModel.diagnostic).toMatchObject({ code: "insufficient_evidence", message: "the stream held no system/init event naming a model" });
    expect((await observe("")).diagnostic.message).toContain("no output");
  });
});

describe("claude probe boundaries", () => {
  const runWith = (handler) => {
    const runner = fakeRunner((spec) => (spec.args[0] === "--version" ? outcome({ stdout: "2.1.278 (Claude Code)" }) : handler(spec)));
    return { runner, ctx: { runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow } };
  };

  it("stops the probe only at a complete system/init line", async () => {
    const { runner, ctx } = runWith(() => outcome({ stdout: initLine() }));
    await claude.observe(ctx);
    const stop = runner.calls.find((c) => c.args[0] !== "--version").stopWhen;
    const other = JSON.stringify({ type: "system", subtype: "other" });
    expect(stop({ stdout: `${other}\n` })).toBe(false);
    expect(stop({ stdout: `${JSON.stringify({ type: "assistant" })}\n` })).toBe(false);
    expect(stop({ stdout: `not json\n${initLine()}\n` })).toBe(true);
    expect(stop({ stdout: initLine() })).toBe(false);
  });

  it("puts the runtime's own first line in the reason when the stream held no init, and masks it", async () => {
    const { ctx } = runWith(() => outcome({ stdout: JSON.stringify({ type: "assistant" }), stderr: "boom happened sk-ant-api03-AbCdEf0123456789\nsecond line" }));
    const result = await claude.observe(ctx);
    expect(result.diagnostic.code).toBe("insufficient_evidence");
    expect(result.diagnostic.message).toContain("boom happened");
    expect(result.diagnostic.message).not.toContain("AbCdEf0123456789");
    expect(result.diagnostic.message).not.toContain("second line");
    const fromStdout = await claude.observe(runWith(() => outcome({ stdout: JSON.stringify({ type: "assistant" }) })).ctx);
    expect(fromStdout.diagnostic.message).toContain("assistant");
  });

  it("reports output that hit the size limit before system/init as malformed", async () => {
    const { ctx } = runWith(() => outcome({ stdout: initLine(), truncated: true }));
    const result = await claude.observe(ctx);
    expect(result.status).toBe("unknown");
    expect(result.diagnostic.code).toBe("malformed_output");
    expect(result.diagnostic.message).toContain("size limit");
  });

  it("marks an effort unrecognised on the warning alone, and adds the valid values only when it lists them", async () => {
    const withList = runWith(() => outcome({ stderr: "Warning: Unknown --effort value 'x' - ignoring it. Valid values: low, high.", stdout: "Not logged in" }));
    const [listed] = (await claude.validate({ effort: "x" }, withList.ctx)).evidence.checks;
    expect(listed).toMatchObject({ verdict: "unrecognized", validValues: ["low", "high"] });
    expect(listed.runtimeText).toContain("Unknown --effort value");

    // A later Claude may word the warning without the list. The verdict must not depend on it.
    const noList = runWith(() => outcome({ stderr: "Warning: Unknown --effort value 'x' - ignoring it.", stdout: "Not logged in" }));
    const [bare] = (await claude.validate({ effort: "x" }, noList.ctx)).evidence.checks;
    expect(bare.verdict).toBe("unrecognized");
    expect(Object.hasOwn(bare, "validValues")).toBe(false);

    const clean = runWith(() => outcome({ stdout: "Not logged in" }));
    const [fine] = (await claude.validate({ effort: "high" }, clean.ctx)).evidence.checks;
    expect(fine).toEqual({ axis: "reasoning", value: "high", verdict: "recognized", scope: "value" });
  });
});

describe("codex parsing boundaries", () => {
  it("parseExecBanner reports whether the banner is complete and ignores lines that are not fields", () => {
    const one = "OpenAI Codex v0.155.1\n--------\nmodel: m\n";
    expect(codex.parseExecBanner(one).complete).toBe(false);
    expect(codex.parseExecBanner(`${one}--------\n`).complete).toBe(true);
    const noisy = ["model: before", "OpenAI Codex v0.1.2", "--------", "no colon here", "1bad: x", "model: m", "reasoning effort:   high  ", "workdir: /a:b", "--------", "model: after"].join("\n");
    const parsed = codex.parseExecBanner(noisy);
    expect(parsed.fields).toEqual({ model: "m", "reasoning effort": "high", workdir: "/a:b" });
    expect(parsed.version).toBe("0.1.2");
    expect(codex.parseExecBanner("no banner at all").fields).toEqual({});
    expect(Object.hasOwn(codex.parseExecBanner("no banner"), "version")).toBe(false);
    expect(codex.parseExecBanner(undefined).fields).toEqual({});
  });

  it("stops the exec probe only when the banner's second separator has arrived on stderr", async () => {
    const runner = fakeRunner(() => outcome({ stderr: "OpenAI Codex v0.155.1\n--------\nmodel: m\n--------\n" }));
    await codex.observe({ runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: makeTempDir("mi-codex-home-"), now: fixedNow });
    const stop = runner.calls.find((c) => c.args[0] === "exec").stopWhen;
    expect(stop({ stderr: "--------\nmodel: m\n" })).toBe(false);
    expect(stop({ stderr: "--------\nmodel: m\n--------\n" })).toBe(true);
    // The banner is printed to stderr. Separators on stdout are not the banner.
    expect(stop({ stderr: "--------\n", stdout: "--------\n--------\n" })).toBe(false);
  });

  it("readModelKeys reads only the four model keys, above the first table, and skips an unsafe value", () => {
    const text = ["# comment", 'model = "a"', "model_provider = 'b'", `model_reasoning_effort = "hi${BACKSLASH}"gh"  # note`, 'model_verbosity = "low"', 'other = "x"', 'model_extra = "y"', "", "[table]", 'model = "in a table"'].join("\n");
    expect(codex.readModelKeys(text)).toEqual({ model: "a", model_provider: "b", model_reasoning_effort: 'hi"gh', model_verbosity: "low" });
    expect(codex.readModelKeys('model = "-x"\nmodel_provider = ""\nmodel_verbosity = 3\n')).toEqual({});
    expect(codex.readModelKeys('[first]\nmodel = "x"')).toEqual({});
    expect(codex.readModelKeys('  model = "indented"\r\nmodel_provider = "crlf"\r\n')).toEqual({ model: "indented", model_provider: "crlf" });
    expect(codex.readModelKeys(`model = 'has${TAB}tab'`)).toEqual({});
    expect(codex.readModelKeys("")).toEqual({});
  });

  it("parseDebugModels keeps an optional field only when it is well formed", () => {
    const text = JSON.stringify({
      models: [
        { slug: "m", display_name: "M", visibility: "list", default_reasoning_level: "low", context_window: 10, max_context_window: -1, default_verbosity: "low", support_verbosity: true, supported_reasoning_levels: [{ effort: "low", description: "d" }, { effort: "" }, {}, "x", { effort: "high", description: 5 }] },
        { slug: "n", support_verbosity: "yes", context_window: "big" },
      ],
    });
    const { models, skipped } = codex.parseDebugModels(text);
    expect(skipped).toBe(0);
    expect(models[0]).toMatchObject({ id: "m", displayName: "M", visibility: "list", defaultReasoningLevel: "low", contextWindow: 10, defaultVerbosity: "low", supportVerbosity: true });
    expect(Object.hasOwn(models[0], "maxContextWindow")).toBe(false);
    expect(models[0].supportedReasoningLevels).toEqual([{ effort: "low", description: "d" }, { effort: "high" }]);
    expect(Object.hasOwn(models[1], "supportVerbosity")).toBe(false);
    expect(Object.hasOwn(models[1], "contextWindow")).toBe(false);
  });

  it("parseDebugModels calls a catalog of only unusable entries malformed and an empty one empty", () => {
    expect(codex.parseDebugModels('{"models":[null,1]}')).toMatchObject({ problem: "malformed_output", skipped: 2 });
    expect(codex.parseDebugModels('{"models":[]}')).toMatchObject({ problem: "empty_output", skipped: 0 });
    for (const empty of [undefined, null, "", "  "]) expect(codex.parseDebugModels(empty).problem, String(empty)).toBe("empty_output");
  });

  it("discover reports the exit status when a failing runtime says nothing, and takes the runtime's first line when it does", async () => {
    const run = (result) => codex.discover({ runCommand: fakeRunner(() => result).runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow });
    const silent = await run(outcome({ exitCode: 3, stderr: "" }));
    expect(silent.diagnostic).toMatchObject({ code: "nonzero_exit", retryable: true });
    expect(silent.diagnostic.message).toContain("exited 3");
    const chatty = await run(outcome({ exitCode: 3, stderr: `${"\n"}  ${"  "}first real line ${"\n"}second` }));
    expect(chatty.diagnostic.message).toBe("first real line");
    // A child stopped on purpose exits with a signal and no code, and that is not a failure.
    const stopped = await run(outcome({ exitCode: null, signal: "SIGTERM", stoppedEarly: true, stdout: JSON.stringify({ models: [{ slug: "m", supported_reasoning_levels: [] }] }) }));
    expect(stopped.status).toBe("ok");
  });
});

describe("process helper boundaries", () => {
  it("firstLine returns the first non-blank line, trimmed and cut at 300 characters", () => {
    expect(firstLine("")).toBe("");
    expect(firstLine("\n \n  a  \nb")).toBe("a");
    expect(firstLine("y".repeat(300))).toHaveLength(300);
    expect(firstLine("x".repeat(400))).toHaveLength(300);
  });

  it("resolveContext takes the config root from the environment, else from the home directory", () => {
    expect(resolveContext({ env: { CODEX_HOME: "/a/b" }, homeDir: "/h" }, ROOT).realRoot).toBe("/a/b");
    expect(resolveContext({ env: { CODEX_HOME: "" }, homeDir: "/h" }, ROOT).realRoot).toBe("/h/.codex");
    expect(resolveContext({ env: {}, homeDir: "/h" }, ROOT).realRoot).toBe("/h/.codex");
    expect(resolveContext({ env: { CODEX_HOME: "rel/x" }, homeDir: "/h" }, ROOT).realRoot).toBe(resolve("rel/x"));
  });

  it("resolveContext supplies real defaults and passes injected dependencies through", () => {
    const defaults = resolveContext(undefined, ROOT);
    expect(defaults.runCommand).toBe(runProcess);
    expect(defaults.env).toBe(process.env);
    expect(defaults.now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(typeof defaults.readFile).toBe("function");
    const injected = { runCommand: () => {}, env: { PATH: "p" }, homeDir: "/h", now: () => "t", timeoutMs: 7, tmpDir: "/t", readFile: () => "" };
    expect(resolveContext(injected, ROOT)).toMatchObject({ homeDir: "/h", timeoutMs: 7, tmpDir: "/t" });
    expect(resolveContext(injected, ROOT).now()).toBe("t");
  });

  it("assertOutsideRoot protects nothing when there is no root, and a path that does not exist yet", () => {
    const other = makeTempDir("mi-other-");
    expect(() => assertOutsideRoot(other, "")).not.toThrow();
    const root = makeTempDir("mi-root-");
    expect(() => assertOutsideRoot(`${root}/not/yet/created/${"a".repeat(3)}`, root)).toThrow(/runtime configuration root/);
    expect(() => assertOutsideRoot(`${other}/not/yet/created`, root)).not.toThrow();
  });

  it("cuts a child's output at exactly the cap", async () => {
    const out = await runProcess({ command: node, args: ["-e", "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)"], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" }, maxOutputBytes: 200_000 });
    expect(out.truncated).toBe(true);
    expect(out.stdout).toHaveLength(200_000);
  });

  it("returns a version from stdout or stderr, and undefined when the runtime does not answer or says none", async () => {
    const ctxFor = (handler, extra = {}) => resolveContext({ runCommand: fakeRunner(handler).runCommand, env: { PATH: "/usr/bin" }, homeDir: "/h", now: fixedNow, ...extra }, ROOT);
    const run = { prefix: "mi-test", command: "codex", ...ROOT, provenance: { sourceId: "codex", sourceKind: "runtime" } };
    expect(await probeVersion(ctxFor(() => outcome({ stdout: "codex-cli 0.155.1" })), run)).toBe("0.155.1");
    expect(await probeVersion(ctxFor(() => outcome({ stderr: "OpenAI Codex v1.2.3" })), run)).toBe("1.2.3");
    expect(await probeVersion(ctxFor(() => outcome({ stdout: "no version here" })), run)).toBeUndefined();
    expect(await probeVersion(ctxFor(() => { throw enoent("codex"); }), run)).toBeUndefined();
  });

  it("does not swallow the SEC-1 guard when it probes a version", async () => {
    // A failure of the runtime is absorbed, but a scratch location inside the real root is a safety
    // fault, and hiding it would hide exactly what the guard exists to report.
    const home = makeTempDir("mi-home-");
    const ctx = resolveContext({ runCommand: fakeRunner(() => outcome({ stdout: "1.2.3" })).runCommand, env: { PATH: "/usr/bin", CODEX_HOME: home }, homeDir: home, tmpDir: home, now: fixedNow }, ROOT);
    await expect(probeVersion(ctx, { prefix: "mi-test", command: "codex", ...ROOT, provenance: { sourceId: "codex", sourceKind: "runtime" } })).rejects.toThrow(/runtime configuration root/);
  });

  it("runIsolated seeds the scratch root before the child runs and runs it in the work directory with its own root", async () => {
    const seen = {};
    const runner = fakeRunner((spec) => {
      seen.spec = spec;
      return outcome({ stdout: "ok" });
    });
    const ctx = resolveContext({ runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: "/nowhere", now: fixedNow }, ROOT);
    const stopWhen = () => true;
    const result = await runIsolated(ctx, {
      prefix: "mi-test",
      command: "codex",
      args: ["x"],
      ...ROOT,
      stopWhen,
      prepare: async (paths) => {
        seen.paths = paths;
      },
      provenance: { sourceId: "codex", sourceKind: "runtime" },
    });
    expect(result.status).toBe("ok");
    expect(seen.spec.cwd).toBe(seen.paths.work);
    expect(seen.spec.env.CODEX_HOME).toBe(seen.paths.runtimeRoot);
    expect(seen.spec.env.HOME).toBe(seen.paths.home);
    expect(seen.spec.stopWhen).toBe(stopWhen);
    expect(seen.spec.args).toEqual(["x"]);
  });

  it("does not remove the scratch root until the operation itself has settled, even after a timeout", async () => {
    // `runBounded` returns as soon as its race against the timeout settles; it does not await the
    // losing operation. If `runIsolated` removed the scratch root as soon as `runBounded` returned,
    // an operation still running past the timeout would be writing into a directory that no longer
    // exists.
    let scratchDir;
    let releaseOperation;
    const runCommand = (spec) => {
      scratchDir = dirname(spec.cwd);
      return new Promise((resolvePromise) => {
        releaseOperation = () => resolvePromise(outcome({ stdout: "late" }));
      });
    };
    const ctx = resolveContext({ runCommand, env: { PATH: "/usr/bin" }, homeDir: "/nowhere", now: fixedNow, timeoutMs: 20 }, ROOT);
    const pending = runIsolated(ctx, { prefix: "mi-race", command: "codex", args: ["x"], ...ROOT, provenance: { sourceId: "codex", sourceKind: "runtime" } });

    await new Promise((r) => setTimeout(r, 100)); // well past the 20ms timeout
    expect(existsSync(scratchDir)).toBe(true); // the operation has not settled yet, so cleanup must wait

    releaseOperation();
    const result = await pending;
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic.code).toBe("timeout");
    expect(existsSync(scratchDir)).toBe(false); // cleanup ran once the operation actually finished
  });
});

describe("provenance carries the runtime version only when the runtime reported one", () => {
  const NO_VERSION = outcome({ stdout: "no version to be found" });
  const runnerWith = (handler, versionOutcome) => fakeRunner((spec) => (spec.args[0] === "--version" ? versionOutcome : handler(spec)));
  const ctxFor = (runner) => ({ runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: makeTempDir("mi-home-"), now: fixedNow });
  const versioned = outcome({ stdout: "9.8.7" });
  const catalog = JSON.stringify({ models: [{ slug: "m", supported_reasoning_levels: [] }] });
  const banner = "--------\nmodel: m\n--------\n";
  const bannerWithVersion = `OpenAI Codex v4.5.6\n${banner}`;

  it("claude validate", async () => {
    const answer = () => outcome({ stdout: "Not logged in" });
    const without = await claude.validate({ model: "opus" }, ctxFor(runnerWith(answer, NO_VERSION)));
    expect(Object.hasOwn(without.provenance, "sourceVersion")).toBe(false);
    expect(Object.hasOwn(without.evidence, "runtimeVersion")).toBe(false);
    const withVersion = await claude.validate({ model: "opus" }, ctxFor(runnerWith(answer, versioned)));
    expect(withVersion.provenance.sourceVersion).toBe("9.8.7");
    expect(withVersion.evidence.runtimeVersion).toBe("9.8.7");
  });

  it("codex discover and validate", async () => {
    const answer = (spec) => (spec.args[0] === "debug" ? outcome({ stdout: catalog }) : outcome({ stderr: bannerWithVersion, stoppedEarly: true }));
    const found = await codex.discover(ctxFor(runnerWith(answer, NO_VERSION)));
    expect(Object.hasOwn(found.provenance, "sourceVersion")).toBe(false);
    expect((await codex.discover(ctxFor(runnerWith(answer, versioned)))).provenance.sourceVersion).toBe("9.8.7");
    const checked = await codex.validate({ model: "m" }, ctxFor(runnerWith(answer, NO_VERSION)));
    expect(Object.hasOwn(checked.provenance, "sourceVersion")).toBe(false);
    expect(Object.hasOwn(checked.evidence, "runtimeVersion")).toBe(false);
    const checkedWith = await codex.validate({ model: "m" }, ctxFor(runnerWith(answer, versioned)));
    expect(checkedWith.provenance.sourceVersion).toBe("9.8.7");
    expect(checkedWith.evidence.runtimeVersion).toBe("9.8.7");
  });

  it("codex observe takes its version from the banner, and has none when the banner names none", async () => {
    const observe = (stderr) => codex.observe(ctxFor(runnerWith(() => outcome({ stderr, stoppedEarly: true }), NO_VERSION)));
    const named = await observe(bannerWithVersion);
    expect(named.provenance.sourceVersion).toBe("4.5.6");
    expect(named.evidence.runtimeVersion).toBe("4.5.6");
    const anonymous = await observe(banner);
    expect(anonymous.status).toBe("ok");
    expect(Object.hasOwn(anonymous.provenance, "sourceVersion")).toBe(false);
    expect(Object.hasOwn(anonymous.evidence, "runtimeVersion")).toBe(false);
  });
});

describe("event and config-line boundaries", () => {
  it("does not take an event as system/init unless it is a system event", () => {
    const wrongType = JSON.stringify({ type: "assistant", subtype: "init", model: "impostor" });
    expect(claude.parseStreamJson(wrongType).init).toBeUndefined();
    const rightTypeWrongSubtype = JSON.stringify({ type: "system", subtype: "hook", model: "impostor" });
    expect(claude.parseStreamJson(rightTypeWrongSubtype).init).toBeUndefined();
    const runner = fakeRunner(() => outcome({ stdout: initLine() }));
    return claude.observe({ runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow }).then(() => {
      const stop = runner.calls.find((c) => c.args[0] !== "--version").stopWhen;
      expect(stop({ stdout: `${wrongType}\n` })).toBe(false);
      expect(stop({ stdout: `${rightTypeWrongSubtype}\n` })).toBe(false);
    });
  });

  it("readModelKeys accepts a key with no spaces, extra spaces, or a comment glued to the value", () => {
    expect(codex.readModelKeys('model="tight"')).toEqual({ model: "tight" });
    expect(codex.readModelKeys('model   =   "wide"')).toEqual({ model: "wide" });
    expect(codex.readModelKeys('model = "glued"#comment')).toEqual({ model: "glued" });
    expect(codex.readModelKeys("model = 'single' # note")).toEqual({ model: "single" });
    // A trailing token that is not a comment is not a valid line, so the value is not taken.
    expect(codex.readModelKeys('model = "a" trailing')).toEqual({});
    // An uppercase or digit-led key is not one of the four.
    expect(codex.readModelKeys('Model = "a"\n1model = "b"')).toEqual({});
  });

  it("says why a catalog was unusable in words that differ for an empty one and a malformed one", async () => {
    const run = (stdout) => codex.discover({ runCommand: fakeRunner(() => outcome({ stdout })).runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow });
    expect((await run('{"models":[]}')).diagnostic.message).toContain("held no models");
    expect((await run("not json")).diagnostic.message).toContain("models list");
  });
});

describe("subprocess runner boundaries", () => {
  const env = { PATH: process.env.PATH ?? "" };
  const spec = (body, extra = {}) => ({ command: node, args: ["-e", body], cwd: tmpdir(), env, ...extra });

  it("gives the child a closed stdin, so a runtime that waits for input sees end-of-file at once", async () => {
    // Codex prints "Reading additional input from stdin..." and would wait forever on an open pipe.
    const started = Date.now();
    const out = await runProcess(spec("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))"));
    expect(out.stdout).toBe("eof");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("escalates to SIGKILL when a child ignores SIGTERM", async () => {
    const out = await runProcess(spec("process.on('SIGTERM', () => {}); process.stderr.write('up'); setInterval(() => {}, 1000)", { stopWhen: ({ stderr }) => stderr.includes("up") }));
    expect(out.stoppedEarly).toBe(true);
    expect(out.signal).toBe("SIGKILL");
  }, 20_000);

  it("kills a child at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await runProcess(spec("setInterval(() => {}, 1000)"), { signal: controller.signal });
    expect(out.aborted).toBe(true);
    expect(out.signal).not.toBeNull();
  });

  it("cuts one oversized chunk at the cap and flags it", async () => {
    const out = await runProcess(spec("process.stdout.write('y'.repeat(100)); setInterval(() => {}, 1000)", { maxOutputBytes: 10 }));
    expect(out.truncated).toBe(true);
    expect(out.stdout).toBe("y".repeat(10));
  });

  it("rejects, and stops the child, when the stop predicate throws", async () => {
    const failure = new Error("predicate broke");
    await expect(runProcess(spec("process.stdout.write('x'); setInterval(() => {}, 1000)", { stopWhen: () => { throw failure; } }))).rejects.toBe(failure);
  });

  it("still escalates to SIGKILL when the stop predicate throws and the child ignores SIGTERM", async () => {
    // A child that traps SIGTERM needs the SIGKILL escalation to actually die. If `finish()` clears
    // `killTimer` on this path (as it did before this fix), the escalation never fires and the child
    // is never reaped -- only the promise settles.
    const failure = new Error("predicate broke");
    const pidFile = await makeTempDir("mi-pidfile");
    const pidPath = resolve(pidFile, "pid");
    const body = `require('fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM', () => {}); process.stdout.write('up'); setInterval(() => {}, 1000)`;
    await expect(runProcess(spec(body, { stopWhen: ({ stdout }) => { if (stdout.includes("up")) throw failure; return false; } }))).rejects.toBe(failure);

    const { readFileSync } = await import("node:fs");
    const pid = Number(readFileSync(pidPath, "utf8"));
    await new Promise((r) => setTimeout(r, 1_500)); // past KILL_GRACE_MS
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 20_000);

  it("does not split a multibyte character across two chunks, and decodes stderr the same way", async () => {
    const out = await runProcess(spec("const b = Buffer.from('a\\u00e9b'); process.stderr.write(b.subarray(0, 2)); setTimeout(() => process.stderr.write(b.subarray(2)), 30)"));
    expect(out.stderr).toBe("aéb");
  });
});
