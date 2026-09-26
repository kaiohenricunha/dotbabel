import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import * as claude from "../src/model-intelligence/sources/runtime/claude.mjs";
import { validateDescriptor, createRegistry } from "../src/model-intelligence/sources/contract.mjs";
import { makeResolvedRuntimeConfiguration } from "../src/model-intelligence/domain/index.mjs";
import { fakeRunner, outcome, enoent, jsonFixture, textFixture, snapshotTree, fixedNow } from "./fixtures/model-intelligence/fake-runner.mjs";

const DIR = "claude";
const stream = (name) => textFixture(DIR, name);
const VERSION_OUTCOME = outcome({ stdout: "2.1.278 (Claude Code)\n" });

/** A responder that answers `--version` itself and hands everything else to `handler`. */
const responder = (handler) => (spec, extra) => (spec.args[0] === "--version" ? VERSION_OUTCOME : handler(spec, extra));

/** The recorded outcome of one validation probe. */
const recorded = (name) => outcome(jsonFixture(DIR, name));

/** A context that runs nothing real. */
const context = (handler, extra = {}) => {
  const runner = fakeRunner(responder(handler));
  return { runner, ctx: { runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow, ...extra } };
};

describe("claude source adapter", () => {
  it("descriptor: discovery unsupported, observation may-execute-model, agent binding supported for model and reasoning, skill binding unsupported, command binding supported for model", () => {
    expect(validateDescriptor(claude.descriptor).errors).toEqual([]);
    const d = claude.descriptor.capabilities;
    expect(d.discovery.support).toBe("unsupported");
    // The capability, as the P-6 prompt states it. Complete observation needs `result.modelUsage`,
    // which exists only after a model turn, and this adapter deliberately never runs one (SEC-1), so
    // a caller must not treat observation as free read-only discovery.
    expect(d.observation).toMatchObject({ support: "supported", execution: "may-execute-model" });
    expect(d.binding.agent).toEqual({ support: "supported", axes: { model: "supported", reasoning: "supported" } });
    expect(d.binding.skill.support).toBe("unsupported");
    expect(d.binding.skill.axes).toEqual({ model: "unsupported", reasoning: "unsupported" });
    expect(d.binding.command.support).toBe("supported");
    expect(d.binding.command.axes.model).toBe("supported");

    // Through the registry, so the ARCH-44 answers are what a consumer sees.
    const reg = createRegistry([claude.descriptor]);
    expect(reg.isVerified("claude", "agent", "reasoning")).toBe(true);
    expect(reg.isVerified("claude", "command", "model")).toBe(true);
    expect(reg.isVerified("claude", "skill")).toBe(false);
    // A kind nobody measured stays unverified rather than being assumed either way.
    expect(reg.bindingSupport("claude", "workflow")).toBe("unverified");
    expect(reg.invocationAxisSupport("claude", "model")).toBe("supported");
    expect(Object.isFrozen(claude.descriptor.capabilities.binding.agent)).toBe(true);
  });

  it("reports discovery as unsupported instead of returning an empty list", async () => {
    // There is no enumeration command (DOC-2), and an empty success would read as "no models".
    const { ctx } = context(() => {
      throw new Error("discover must not run anything");
    });
    const result = await claude.discover(ctx);
    expect(result.status).toBe("unsupported");
    expect(result.diagnostic.code).toBe("no_enumeration");
    expect(result.evidence).toBeUndefined();
    expect(result.provenance).toMatchObject({ sourceId: "claude", sourceKind: "runtime" });
  });

  it("observe() parses system/init.model and result.modelUsage from a stream-json fixture into ObservedEffectiveConfiguration", async () => {
    const result = await claude.observe({ stream: stream("stream-with-model-usage.jsonl"), now: fixedNow });
    expect(result.status).toBe("ok");
    const observed = result.evidence;
    // The model is opaque, including the context variant in brackets (ARCH-17).
    expect(observed).toMatchObject({ runtimeId: "claude", turnExecuted: true, axes: { model: "claude-opus-5[1m]" } });
    expect(observed.fieldSources["axes.model"]).toBe("system/init.model");
    // A stream from a run the caller made is the configuration as it ran, not a reconstruction.
    expect(observed.configurationBasis).toBe("as-run");
    expect(Object.hasOwn(observed, "reconstructedFrom")).toBe(false);
    expect(observed.usage).toHaveLength(2);
    const [haiku, opus] = observed.usage;
    expect(haiku).toMatchObject({ model: "claude-haiku-4-5-20251001", canonicalModel: "claude-haiku-4-5-20251001", provider: "anthropic", contextWindow: 200000, maxOutputTokens: 64000, thinkingTokens: 0 });
    // The runtime's own fields differ by entry. This one carries only thinkingTokens, and nothing is
    // invented for the rest: in particular the provider is not derived from the model id (ARCH-2).
    expect(opus).toEqual({ model: "claude-opus-5[1m]", thinkingTokens: 130 });
    // Claude reports no effort anywhere, so none is claimed (DOC-2, constraint 19).
    expect(Object.hasOwn(observed, "effort")).toBe(false);
    expect(result.provenance).toMatchObject({ sourceId: "claude", sourceKind: "runtime", sourceVersion: "2.1.278", adapterVersion: claude.ADAPTER_VERSION });
    expect(result.observedAt).toBe("2026-09-19T00:00:00.000Z");
  });

  it("reads the resolved model from system/init alone when no turn ran, and says so", async () => {
    const result = await claude.observe({ stream: stream("stream-init-no-turn.jsonl"), now: fixedNow });
    expect(result.status).toBe("ok");
    // This is the free half of observation, found while writing the adapter: `system/init` is
    // emitted before authentication and already names the resolved model, so the model needs no
    // billable turn. Only usage does, and there was none.
    expect(result.evidence).toMatchObject({ axes: { model: "claude-opus-5" }, turnExecuted: false, usage: [] });
    expect(result.evidence.fieldSources).toEqual({ "axes.model": "system/init.model" });
  });

  it("classifies text that is not a usable stream as unknown, never as an empty success", async () => {
    for (const [text, code] of [["", "empty_output"], ["   \n", "empty_output"], ["not json at all\n{broken", "malformed_output"], ['{"type":"assistant"}\n', "insufficient_evidence"], ['{"type":"result","subtype":"success","modelUsage":{}}\n', "insufficient_evidence"]]) {
      const result = await claude.observe({ stream: text, now: fixedNow });
      expect(result.status, JSON.stringify(text)).toBe("unknown");
      expect(result.diagnostic.code, JSON.stringify(text)).toBe(code);
      expect(result.evidence).toBeUndefined();
    }
  });

  it("skips a malformed line but keeps the events around it", () => {
    const parsed = claude.parseStreamJson(["garbage", stream("stream-init-no-turn.jsonl").trim(), "{"].join("\n"));
    expect(parsed.malformedLines).toBe(2);
    expect(parsed.init.model).toBe("claude-opus-5");
    expect(parsed.result.isError).toBe(true);
  });

  it("observe() returns unavailable with diagnostic binary_missing when the CLI is absent", async () => {
    const { ctx } = context(() => {
      throw enoent("claude");
    });
    // The version probe fails the same way, and that must not turn into a crash.
    ctx.runCommand = fakeRunner(() => {
      throw enoent("claude");
    }).runCommand;
    const result = await claude.observe(ctx);
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic.code).toBe("binary_missing");
    expect(result.provenance).toMatchObject({ sourceId: "claude", sourceKind: "runtime" });
    expect(result.evidence).toBeUndefined();
  });

  it("runs the resolve probe with no credentials, no persistence and no model turn, and stops at system/init", async () => {
    const { runner, ctx } = context(() => outcome({ stdout: stream("stream-init-no-turn.jsonl"), exitCode: 1, stoppedEarly: true }));
    const result = await claude.observe({ ...ctx, model: "opus", effort: "high" });
    expect(result.status).toBe("ok");
    expect(result.evidence.axes.model).toBe("claude-opus-5");
    // The probe's scratch CLAUDE_CONFIG_DIR hides the user's own settings, so the answer reflects only
    // the flags carried in plus Claude's defaults, and the evidence names those flags.
    expect(result.evidence.configurationBasis).toBe("reconstructed");
    expect(result.evidence.reconstructedFrom).toEqual(["--model", "--effort"]);
    // Provenance carries the version the runtime itself reported.
    expect(result.provenance.sourceVersion).toBe("2.1.278");

    const probe = runner.calls.find((c) => c.args[0] !== "--version");
    expect(probe.command).toBe("claude");
    expect(probe.args).toEqual(["-p", "x", "--model", "opus", "--effort", "high", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]);
    // The child may end as soon as system/init is complete: waiting for it would wait for a turn.
    const init = stream("stream-init-no-turn.jsonl").split("\n")[0];
    expect(probe.stopWhen({ stdout: init + "\n", stderr: "" })).toBe(true);
    expect(probe.stopWhen({ stdout: init.slice(0, 40), stderr: "" })).toBe(false);
    expect(probe.stopWhen({ stdout: "", stderr: "" })).toBe(false);

    // Without a model or effort the flags are absent instead of empty.
    const bare = context(() => outcome({ stdout: stream("stream-init-no-turn.jsonl") }));
    await claude.observe(bare.ctx);
    expect(bare.runner.calls.find((c) => c.args[0] !== "--version").args).toEqual(["-p", "x", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]);
  });

  it("returns unavailable with code timeout when the CLI does not answer, and aborts it", async () => {
    let seenSignal;
    const { ctx } = context((spec, { signal }) => {
      seenSignal = signal;
      // A real runCommand settles once its signal aborts (that is how the actual child process
      // eventually exits after SIGTERM/SIGKILL); this fake matches that instead of hanging forever,
      // so it does not mask `runIsolated` genuinely waiting for the operation to finish.
      return new Promise((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(outcome({ stdout: "" })), { once: true }));
    });
    const result = await claude.observe({ ...ctx, timeoutMs: 25 });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic).toMatchObject({ code: "timeout", retryable: true });
    // The runner is told to stop, so a hung CLI does not keep running after the caller has its answer.
    expect(seenSignal.aborted).toBe(true);
  });

  it("validate() accepts the stable aliases and rejects an unknown alias with the runtime's own rejection text", async () => {
    const byModel = (spec) => {
      const model = spec.args[spec.args.indexOf("--model") + 1];
      if (model === "opus") return recorded("validate-known-alias.json");
      return recorded("validate-unknown-model.json");
    };
    const { ctx } = context(byModel);

    const known = await claude.validate({ model: "opus" }, ctx);
    expect(known.status).toBe("ok");
    // Recognised means the runtime got past model handling and stopped at authentication. It is not
    // a claim that the account can invoke the model (ARCH-14).
    expect(known.evidence.checks).toEqual([{ axis: "model", value: "opus", verdict: "recognized", scope: "value" }]);
    expect(known.evidence.runtimeVersion).toBe("2.1.278");

    const unknown = await claude.validate({ model: "dotbabel-nonexistent-model" }, ctx);
    const check = unknown.evidence.checks[0];
    // Claude 2.1.278 no longer refuses an unknown model outright, as 2.1.274 did (DOC-2). It warns
    // that its own catalog does not describe the model and goes on, so the honest verdict is
    // "unrecognized" and the model may still be valid to the API. The text is the runtime's own.
    expect(check).toMatchObject({ axis: "model", value: "dotbabel-nonexistent-model", verdict: "unrecognized", scope: "value" });
    expect(check.runtimeText).toContain("isn't described by this version's model catalog");
    expect(unknown.status).toBe("ok");
  });

  it("validate() reads the valid effort values from the runtime's own warning", async () => {
    const { ctx } = context(() => recorded("validate-bad-effort.json"));
    const result = await claude.validate({ model: "sonnet", effort: "dotbabel-bogus" }, ctx);
    const [modelCheck, effortCheck] = result.evidence.checks;
    expect(modelCheck).toMatchObject({ axis: "model", verdict: "recognized" });
    expect(effortCheck).toMatchObject({ axis: "reasoning", value: "dotbabel-bogus", verdict: "unrecognized", scope: "value" });
    // The runtime falls back to its default effort silently otherwise, so this is the only place the
    // valid set is ever revealed (DOC-2, constraint 13).
    expect(effortCheck.validValues).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("validate() runs one probe with the value as a single argument and only for the axes it was given", async () => {
    const { runner, ctx } = context(() => recorded("validate-known-alias.json"));
    await claude.validate({ model: "opus", effort: "high" }, ctx);
    const probes = runner.calls.filter((c) => c.args[0] !== "--version");
    expect(probes).toHaveLength(1);
    expect(probes[0].args).toEqual(["-p", "x", "--model", "opus", "--effort", "high", "--no-session-persistence"]);

    const effortOnly = context(() => recorded("validate-known-alias.json"));
    await claude.validate({ effort: "high" }, effortOnly.ctx);
    expect(effortOnly.runner.calls.find((c) => c.args[0] !== "--version").args).toEqual(["-p", "x", "--effort", "high", "--no-session-persistence"]);
  });

  it("validate() reports unverifiable when the output shows the runtime never reached model handling", async () => {
    const { ctx } = context(() => outcome({ exitCode: 1, stdout: "something the adapter has never seen", stderr: "" }));
    const result = await claude.validate({ model: "opus" }, ctx);
    expect(result.evidence.checks[0].verdict).toBe("unverifiable");
  });

  it("validate() answers a value that could be read as a flag with an invalid_axis_value result, and runs nothing", async () => {
    const { runner, ctx } = context(() => recorded("validate-known-alias.json"));
    // The value is data that may come from a repository's own frontmatter, so a bad one is a result the
    // caller can attribute and report, with provenance, rather than an exception (the split-by-source rule).
    for (const bad of [{ model: "--dangerously-skip-permissions" }, { model: "-x" }, { effort: "--model" }, { model: "" }, { model: "line" + String.fromCharCode(10) + "break" }]) {
      const result = await claude.validate(bad, ctx);
      expect(result.status, JSON.stringify(bad)).toBe("unknown");
      expect(result.diagnostic.code, JSON.stringify(bad)).toBe("invalid_axis_value");
      expect(result.provenance.sourceId).toBe("claude");
      // The diagnostic names the axis and never echoes the value (OPS-4).
      expect(result.diagnostic.message).not.toContain("dangerously");
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("validate() throws when the caller breaks the input contract: no axis, a non-object, or a value that is not a string", async () => {
    const { runner, ctx } = context(() => recorded("validate-known-alias.json"));
    await expect(claude.validate({}, ctx)).rejects.toThrow(/model or an effort/);
    await expect(claude.validate(null, ctx)).rejects.toThrow(/model or an effort/);
    await expect(claude.validate({ model: 7 }, ctx)).rejects.toThrow(/model must be a string/);
    // Nothing was run for any of them.
    expect(runner.calls).toHaveLength(0);
  });

  it("validate() returns unavailable with binary_missing when the CLI is absent", async () => {
    const runner = fakeRunner(() => {
      throw enoent("claude");
    });
    const result = await claude.validate({ model: "opus" }, { runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic.code).toBe("binary_missing");
  });

  it("masks a credential in the runtime's own output before it leaves the adapter (OPS-4)", async () => {
    const secret = "sk-ant-api03-AbCdEf0123456789";
    const { ctx } = context(() => outcome({ exitCode: 1, stdout: "Not logged in", stderr: `model "x" isn't described by this version's model catalog; token ${secret}` }));
    const result = await claude.validate({ model: "x" }, ctx);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("renderInvocation() returns structured argv for --model and --effort before any shell string", () => {
    const resolved = makeResolvedRuntimeConfiguration({
      runtimeId: "claude",
      axes: { model: "opus", reasoning: "high" },
      representation: { kind: "stable-alias", provenance: { sourceId: "claude", sourceKind: "runtime" } },
    });
    const invocation = claude.renderInvocation(resolved);
    expect(invocation).toEqual({ runtimeId: "claude", command: "claude", args: ["--model", "opus", "--effort", "high"], unsupportedAxes: [] });
    // ARCH-47: structure first. There is no shell string to inject into, and nothing is executed.
    expect(Object.hasOwn(invocation, "shell")).toBe(false);
    expect(Array.isArray(invocation.args)).toBe(true);
  });

  it("renderInvocation() names an axis it cannot express instead of dropping it, and takes a model alone", () => {
    const make = (axes) => makeResolvedRuntimeConfiguration({ runtimeId: "claude", axes, representation: { kind: "native-id", provenance: { sourceId: "claude", sourceKind: "runtime" } } });
    // ARCH-49: unsupported binding is explicit state, never silent metadata loss (PB-11).
    expect(claude.renderInvocation(make({ model: "opus", contextTier: "1m" }))).toMatchObject({ args: ["--model", "opus"], unsupportedAxes: ["contextTier"] });
    expect(claude.renderInvocation(make({ model: "claude-opus-5[1m]" })).args).toEqual(["--model", "claude-opus-5[1m]"]);
    expect(claude.renderInvocation(make({ reasoning: "max" })).args).toEqual(["--effort", "max"]);
  });

  it("renderInvocation() refuses another runtime's configuration and a value that could be read as a flag", () => {
    const make = (runtimeId, axes) => makeResolvedRuntimeConfiguration({ runtimeId, axes, representation: { kind: "native-id", provenance: { sourceId: runtimeId, sourceKind: "runtime" } } });
    expect(() => claude.renderInvocation(make("codex", { model: "gpt-5.5" }))).toThrow(/claude/);
    expect(() => claude.renderInvocation(make("claude", { model: "--dangerously-skip-permissions" }))).toThrow(/model/);
    expect(() => claude.renderInvocation(make("claude", { model: 7 }))).toThrow(/model/);
    expect(() => claude.renderInvocation({})).toThrow();
  });

  it("the adapter never writes under the runtime configuration root during discover, observe, or validate", async () => {
    // SEC-1. Claude Code writes projects, backups and telemetry into whatever CLAUDE_CONFIG_DIR it is
    // given, even with --no-session-persistence (observed while writing this adapter), so the only
    // safe place to run it is a scratch directory. The fake runner plays the runtime and does exactly
    // that, so the assertion is about isolation and not about good intentions.
    const home = makeTempDir("mi-claude-home-");
    const realRoot = join(home, ".claude");
    mkdirSync(join(realRoot, "projects", "real-project"), { recursive: true });
    writeFileSync(join(realRoot, ".claude.json"), "{}");
    writeFileSync(join(realRoot, "settings.json"), "{}");
    const before = snapshotTree(realRoot);

    const writtenTo = [];
    const runner = fakeRunner(
      responder((spec) => {
        const target = spec.env.CLAUDE_CONFIG_DIR;
        writtenTo.push(target);
        mkdirSync(join(target, "telemetry"), { recursive: true });
        writeFileSync(join(target, "telemetry", "event.json"), "{}");
        return spec.args.includes("stream-json") ? outcome({ stdout: stream("stream-init-no-turn.jsonl") }) : recorded("validate-known-alias.json");
      }),
    );
    const env = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-api03-AbCdEf0123456789", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value", CLAUDE_CONFIG_DIR: realRoot };
    const ctx = { runCommand: runner.runCommand, env, homeDir: home, now: fixedNow };

    await claude.discover(ctx);
    await claude.observe(ctx);
    await claude.validate({ model: "opus", effort: "high" }, ctx);

    expect(snapshotTree(realRoot)).toEqual(before);
    expect(writtenTo.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      // Every run happened somewhere else, with a home of its own and no credential, so it could not
      // have billed a turn even if the classification below it were wrong.
      for (const dir of [call.cwd, call.env.HOME, call.env.CLAUDE_CONFIG_DIR]) expect(dir.startsWith(realRoot), dir).toBe(false);
      expect(call.env.HOME).not.toBe(home);
      expect(JSON.stringify(call.env)).not.toMatch(/sk-ant|oauth-token|ANTHROPIC|OAUTH/);
      expect(call.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    }
    // The scratch directories the runtime wrote into are gone.
    const { existsSync } = await import("node:fs");
    for (const dir of writtenTo) expect(existsSync(dir), dir).toBe(false);
  });

  it("refuses to run at all when the scratch location would land inside the real configuration root", async () => {
    const home = makeTempDir("mi-claude-home-");
    const runner = fakeRunner(responder(() => outcome()));
    // A tmpdir inside the config root would make the isolation a fiction, so the adapter checks.
    const ctx = { runCommand: runner.runCommand, env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: home }, homeDir: home, tmpDir: home, now: fixedNow };
    await expect(claude.observe(ctx)).rejects.toThrow(/runtime configuration root/);
    expect(runner.calls).toHaveLength(0);
  });
});
