import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./fixtures/temp-dir.mjs";
import * as codex from "../src/model-intelligence/sources/runtime/codex.mjs";
import { validateDescriptor, createRegistry } from "../src/model-intelligence/sources/contract.mjs";
import { makeResolvedRuntimeConfiguration } from "../src/model-intelligence/domain/index.mjs";
import { fakeRunner, outcome, enoent, jsonFixture, textFixture, snapshotTree, fixedNow } from "./fixtures/model-intelligence/fake-runner.mjs";

const DIR = "codex";
const catalogText = () => JSON.stringify(jsonFixture(DIR, "debug-models.json"));
const banner = () => textFixture(DIR, "exec-banner.stderr.txt");
const VERSION_OUTCOME = outcome({ stdout: "codex-cli 0.155.1\n" });

const responder = (handler) => (spec, extra) => (spec.args[0] === "--version" ? VERSION_OUTCOME : handler(spec, extra));

/** A context that runs nothing real and reads config from a temp root. */
const context = (handler, extra = {}) => {
  const runner = fakeRunner(responder(handler));
  const home = makeTempDir("mi-codex-home-");
  return { runner, home, ctx: { runCommand: runner.runCommand, env: { PATH: "/usr/bin", CODEX_HOME: join(home, ".codex") }, homeDir: home, now: fixedNow, ...extra } };
};

const resolved = (axes) => makeResolvedRuntimeConfiguration({ runtimeId: "codex", axes, representation: { kind: "native-id", provenance: { sourceId: "codex", sourceKind: "runtime" } } });

describe("codex source adapter", () => {
  it("descriptor: discovery supported, network never, auth none, cacheable true, execution read-only", () => {
    expect(validateDescriptor(codex.descriptor).errors).toEqual([]);
    const c = codex.descriptor.capabilities;
    expect(c.discovery).toEqual({ support: "supported", network: "never", auth: "none", cacheable: true, execution: "read-only" });
    // Observation and validation run in a scratch home with no credential and no route to the
    // network, so they cannot start a model turn and are read-only in fact, not just by intent.
    expect(c.observation).toMatchObject({ support: "supported", network: "never", auth: "none", execution: "read-only" });
    expect(c.validation).toMatchObject({ support: "supported", network: "never", auth: "none", execution: "read-only" });
    expect(c.observation.cacheable).toBe(false);
    // Skill binding is out of scope: RQ-4 leaves it unverified, and unverified is never coerced.
    expect(c.binding.skill).toEqual({ support: "unverified", axes: { model: "unverified", reasoning: "unverified" } });
    const reg = createRegistry([codex.descriptor]);
    expect(reg.isVerified("codex", "skill")).toBe(false);
    expect(reg.bindingSupport("codex", "skill")).toBe("unverified");
    expect(reg.invocationAxisSupport("codex", "model")).toBe("supported");
    expect(reg.invocationAxisSupport("codex", "reasoning")).toBe("supported");
  });

  it("discover() parses the codex debug models fixture into per-model supported_reasoning_levels", async () => {
    const { runner, ctx } = context(() => outcome({ stdout: catalogText() }));
    const result = await codex.discover(ctx);
    expect(result.status).toBe("ok");
    const byId = Object.fromEntries(result.evidence.models.map((m) => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual(["codex-auto-review", "gpt-5.5", "gpt-5.6-luna", "gpt-6-astra"]);
    expect(byId["gpt-6-astra"].supportedReasoningLevels.map((l) => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(byId["gpt-5.5"].supportedReasoningLevels.map((l) => l.effort)).toEqual(["low", "medium", "high", "xhigh"]);
    // The catalog's own descriptions and defaults survive, and the model id is used verbatim (ARCH-17).
    expect(byId["gpt-6-astra"].supportedReasoningLevels[0].description).toEqual(expect.any(String));
    expect(byId["gpt-5.5"]).toMatchObject({ defaultReasoningLevel: "medium", visibility: "list" });
    expect(byId["codex-auto-review"].visibility).toBe("hide");
    expect(result.provenance).toMatchObject({ sourceId: "codex", sourceKind: "runtime", sourceVersion: "0.155.1", adapterVersion: codex.ADAPTER_VERSION });
    expect(result.evidence.skipped).toBe(0);
    expect(result.observedAt).toBe("2026-09-19T00:00:00.000Z");

    // Offline and credential-free: the command that ran is the catalog and nothing else.
    const call = runner.calls.find((c) => c.args[0] !== "--version");
    expect(call.command).toBe("codex");
    expect(call.args).toEqual(["debug", "models"]);
  });

  it("discover() never invents a provider, because the catalog carries none", async () => {
    const { ctx } = context(() => outcome({ stdout: catalogText() }));
    const result = await codex.discover(ctx);
    for (const model of result.evidence.models) {
      expect(Object.hasOwn(model, "provider"), model.id).toBe(false);
    }
    // And no model id is parsed for meaning: `gpt-` is not evidence of a vendor (ARCH-2, ARCH-17).
    expect(JSON.stringify(result.evidence)).not.toMatch(/"provider"/);
  });

  it("discover() reports models that do not support max so a max requirement can be refused", async () => {
    const { ctx } = context(() => outcome({ stdout: catalogText() }));
    const result = await codex.discover(ctx);
    const support = result.evidence.effortSupport;
    // Effort validity is a function of the model, never of the runtime (DOC-2, constraint 3).
    expect(support.max.notSupportedBy).toEqual(["gpt-5.5"]);
    expect([...support.max.supportedBy].sort()).toEqual(["codex-auto-review", "gpt-5.6-luna", "gpt-6-astra"]);
    expect(support.ultra.supportedBy).toEqual(["gpt-6-astra"]);
    expect([...support.ultra.notSupportedBy].sort()).toEqual(["codex-auto-review", "gpt-5.5", "gpt-5.6-luna"]);
    expect(support.low.notSupportedBy).toEqual([]);
  });

  it("discover() classifies a catalog it cannot use as unknown, never as an empty success", async () => {
    // The OpenCode lesson (ARCH-30): a zero exit code and empty output is not "no models".
    for (const [stdout, code] of [["", "empty_output"], ["   \n", "empty_output"], ["not json", "malformed_output"], ["[]", "malformed_output"], ['{"models":"x"}', "malformed_output"], ['{"models":[]}', "empty_output"]]) {
      const { ctx } = context(() => outcome({ stdout }));
      const result = await codex.discover(ctx);
      expect(result.status, JSON.stringify(stdout)).toBe("unknown");
      expect(result.diagnostic.code, JSON.stringify(stdout)).toBe(code);
      expect(result.evidence).toBeUndefined();
    }
  });

  it("discover() counts an entry it could not use and keeps the rest", async () => {
    const catalog = { models: [{ slug: "good", supported_reasoning_levels: [{ effort: "low", description: "d" }] }, { no_slug: true }, { slug: "" }, null, "str", { slug: "bad-levels", supported_reasoning_levels: "low" }] };
    const { ctx } = context(() => outcome({ stdout: JSON.stringify(catalog) }));
    const result = await codex.discover(ctx);
    expect(result.evidence.models.map((m) => m.id)).toEqual(["good", "bad-levels"]);
    expect(result.evidence.skipped).toBe(4);
    // A level list that is not a list is treated as reporting none, not as a crash.
    expect(result.evidence.models[1].supportedReasoningLevels).toEqual([]);
  });

  it("discover() reports a truncated catalog as unknown", async () => {
    const { ctx } = context(() => outcome({ stdout: catalogText(), truncated: true }));
    const result = await codex.discover(ctx);
    expect(result.status).toBe("unknown");
    expect(result.diagnostic.code).toBe("malformed_output");
  });

  it("discover() returns unavailable with binary_missing and never throws", async () => {
    const runner = fakeRunner(() => {
      throw enoent("codex");
    });
    const result = await codex.discover({ runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic.code).toBe("binary_missing");
  });

  it("discover() reports a non-zero exit as unavailable with nonzero_exit and the runtime's message", async () => {
    const { ctx } = context(() => outcome({ exitCode: 2, stderr: "error: something broke" }));
    const result = await codex.discover(ctx);
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic.code).toBe("nonzero_exit");
    expect(result.diagnostic.message).toContain("something broke");
  });

  it("observe() reads the resolved model and provider from the exec banner fixture without network", async () => {
    const { runner, ctx } = context(() => outcome({ stderr: banner(), exitCode: null, signal: "SIGTERM", stoppedEarly: true }));
    const result = await codex.observe(ctx);
    expect(result.status).toBe("ok");
    const observed = result.evidence;
    // The defect in handoff-extract.sh:276 stored the provider in the model field. Here they are
    // separate fields with separate sources (ARCH-2, ARCH-28).
    expect(observed).toMatchObject({ runtimeId: "codex", turnExecuted: false, axes: { model: "gpt-6-astra", reasoning: "xhigh" }, provider: "openai" });
    expect(observed.axes.model).not.toBe(observed.provider);
    expect(observed.fieldSources).toEqual({ "axes.model": "exec-banner:model", "axes.reasoning": "exec-banner:reasoning effort", provider: "exec-banner:provider" });
    // No user config was carried in, so every value is the runtime's own default, and that is stated.
    expect(observed.configurationBasis).toBe("reconstructed");
    expect(observed.reconstructedFrom).toEqual([]);
    // Nothing that identifies the scratch run leaks into the evidence.
    expect(JSON.stringify(observed)).not.toMatch(/scratch|session|workdir|00000000/);
    expect(result.provenance.sourceVersion).toBe("0.155.1");

    const probe = runner.calls.find((c) => c.args[0] !== "--version");
    expect(probe.args).toEqual(["exec", "--skip-git-repo-check", "x"]);
    // The banner is complete at its second separator; the reconnect noise after it is never waited for.
    expect(probe.stopWhen({ stdout: "", stderr: banner() })).toBe(true);
    expect(probe.stopWhen({ stdout: "", stderr: banner().split("--------")[0] + "--------\nworkdir: /x\nmodel: m\n" })).toBe(false);
    expect(probe.stopWhen({ stdout: "", stderr: "" })).toBe(false);
  });

  it("observe() takes each field from its own banner line and never from another", () => {
    const parsed = codex.parseExecBanner(banner());
    expect(parsed.version).toBe("0.155.1");
    expect(parsed.fields).toMatchObject({ model: "gpt-6-astra", provider: "openai", "reasoning effort": "xhigh", approval: "never", sandbox: "read-only" });
    // The reconnect errors after the banner contain "model"-shaped and URL-shaped text and are ignored.
    expect(Object.keys(parsed.fields)).not.toContain("user");
    // A banner with no provider line yields no provider, and the model is never used in its place.
    const noProvider = codex.parseExecBanner("OpenAI Codex v0.155.1\n--------\nmodel: gpt-5.5\nreasoning effort: low\n--------\n");
    expect(noProvider.fields.model).toBe("gpt-5.5");
    expect(Object.hasOwn(noProvider.fields, "provider")).toBe(false);
  });

  it("observe() classifies output with no banner as unknown and keeps the runtime's error text bounded and masked", async () => {
    const secret = "sk-ant-api03-AbCdEf0123456789";
    const { ctx } = context(() => outcome({ exitCode: 1, stderr: `Error loading config.toml: bad value ${secret}` }));
    const result = await codex.observe(ctx);
    expect(result.status).toBe("unknown");
    expect(result.diagnostic.code).toBe("insufficient_evidence");
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const stderr of ["", "  \n"]) {
      const empty = await codex.observe(context(() => outcome({ stderr })).ctx);
      expect(empty.diagnostic.code).toBe("empty_output");
    }
  });

  it("observe() returns unavailable when the CLI is absent or does not answer", async () => {
    const runner = fakeRunner(() => {
      throw enoent("codex");
    });
    const missing = await codex.observe({ runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow });
    expect(missing.diagnostic.code).toBe("binary_missing");

    // A real runCommand settles once its signal aborts (that is how the actual child process
    // eventually exits after SIGTERM/SIGKILL); this fake matches that instead of hanging forever, so
    // it does not mask `runIsolated` genuinely waiting for the operation to finish.
    const hung = context((spec, { signal }) => new Promise((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(outcome({ stderr: "" })), { once: true })));
    const timedOut = await codex.observe({ ...hung.ctx, timeoutMs: 25 });
    expect(timedOut.status).toBe("unavailable");
    expect(timedOut.diagnostic).toMatchObject({ code: "timeout", retryable: true });
  });

  it("carries only the model keys of the user's config into the scratch config, and never the credential file", async () => {
    const home = makeTempDir("mi-codex-home-");
    const realRoot = join(home, ".codex");
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(join(realRoot, "auth.json"), '{"OPENAI_API_KEY":"sk-proj-abcdefghijklmnop"}');
    writeFileSync(
      join(realRoot, "config.toml"),
      [
        '# a comment',
        'model = "gpt-5.5"',
        "model_provider = 'openai'",
        'model_reasoning_effort = "high"   # trailing comment',
        'personality = "friendly"',
        'approval_policy = "never"',
        '',
        '[plugins."github@openai-curated"]',
        'enabled = true',
        '[projects."/home/someone/private-project"]',
        'trust_level = "trusted"',
        'model = "must-not-be-read-from-a-table"',
      ].join("\n"),
    );
    let scratchConfig;
    let scratchRootFiles;
    const runner = fakeRunner(
      responder((spec) => {
        const scratchHome = spec.env.CODEX_HOME;
        const file = join(scratchHome, "config.toml");
        scratchConfig = existsSync(file) ? readFileSync(file, "utf8") : null;
        scratchRootFiles = existsSync(scratchHome) ? JSON.stringify(snapshotTree(scratchHome).map((e) => e.split("|")[0])) : "";
        return outcome({ stderr: banner(), stoppedEarly: true });
      }),
    );
    const result = await codex.observe({ runCommand: runner.runCommand, env: { PATH: "/usr/bin", CODEX_HOME: realRoot, OPENAI_API_KEY: "sk-proj-abcdefghijklmnop" }, homeDir: home, now: fixedNow });
    // The banner reflects a scratch config that carries exactly these keys, and the evidence says so,
    // so a caller never reads a reconstruction as the user's full configuration (ARCH-28).
    expect(result.evidence.configurationBasis).toBe("reconstructed");
    expect(result.evidence.reconstructedFrom).toEqual(["model", "model_provider", "model_reasoning_effort"]);

    // Only the four model keys, read from the top of the file. The plugin and project sections, and
    // a `model` key inside a table, are private and irrelevant, and are not carried.
    expect(scratchConfig).toBe('model = "gpt-5.5"\nmodel_provider = "openai"\nmodel_reasoning_effort = "high"\n');
    expect(scratchRootFiles).not.toContain("auth.json");
    expect(scratchConfig).not.toMatch(/plugins|projects|personality|approval|trusted|private/);
  });

  it("starts from an empty scratch config when the user has none, and ignores a value it cannot read safely", async () => {
    const seen = [];
    const run = async (configText) => {
      const home = makeTempDir("mi-codex-home-");
      const realRoot = join(home, ".codex");
      mkdirSync(realRoot, { recursive: true });
      if (configText !== null) writeFileSync(join(realRoot, "config.toml"), configText);
      const runner = fakeRunner(
        responder((spec) => {
          const file = join(spec.env.CODEX_HOME, "config.toml");
          seen.push(existsSync(file) ? readFileSync(file, "utf8") : "");
          return outcome({ stderr: banner(), stoppedEarly: true });
        }),
      );
      await codex.observe({ runCommand: runner.runCommand, env: { PATH: "/usr/bin", CODEX_HOME: realRoot }, homeDir: home, now: fixedNow });
    };
    await run(null);
    await run('model = "x"\nmodel_provider = "bad' + String.fromCharCode(7) + 'value"\nmodel_reasoning_effort = "--flag"\nmodel_verbosity = 3\n');
    expect(seen[0]).toBe("");
    // A value with a control character, one that starts with a dash, and a non-string are all skipped.
    expect(seen[1]).toBe('model = "x"\n');
  });

  it("validate() uses --strict-config recognition and reports version_unsupported when the flag is absent", async () => {
    const byKey = (spec) => {
      const override = spec.args[spec.args.indexOf("-c") + 1];
      if (override.startsWith("model_reasoning_effort=")) return outcome({ stderr: banner(), stoppedEarly: true });
      if (override.startsWith("dotbabel_fake_key=")) return outcome(jsonFixture(DIR, "strict-config-unknown-key.json"));
      return outcome({ stderr: banner(), stoppedEarly: true });
    };
    const { runner, ctx } = context(byKey);
    const result = await codex.validate({ model: "gpt-5.5", reasoning: "xhigh" }, ctx);
    expect(result.status).toBe("ok");
    // Codex enum-validates some sibling keys but accepts any string for these two, so what
    // --strict-config can prove is that the KEY is recognised, and the evidence says so (scope "key").
    expect(result.evidence.checks).toEqual([
      { axis: "model", value: "gpt-5.5", verdict: "recognized", scope: "key" },
      { axis: "reasoning", value: "xhigh", verdict: "recognized", scope: "key" },
    ]);
    const probes = runner.calls.filter((c) => c.args[0] !== "--version");
    expect(probes.map((p) => p.args)).toEqual([
      ["exec", "--skip-git-repo-check", "--strict-config", "-c", 'model="gpt-5.5"', "x"],
      ["exec", "--skip-git-repo-check", "--strict-config", "-c", 'model_reasoning_effort="xhigh"', "x"],
    ]);
    expect(probes[0].stopWhen({ stdout: "", stderr: banner() })).toBe(true);
    expect(probes[0].stopWhen({ stdout: "", stderr: jsonFixture(DIR, "strict-config-unknown-key.json").stderr })).toBe(true);
    expect(probes[0].stopWhen({ stdout: "", stderr: "" })).toBe(false);

    const missing = context(() => outcome(jsonFixture(DIR, "strict-config-flag-missing.json")));
    const unsupported = await codex.validate({ model: "gpt-5.5" }, missing.ctx);
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.diagnostic.code).toBe("version_unsupported");
    expect(unsupported.evidence).toBeUndefined();
  });

  it("validate() reports an unknown configuration field as unrecognized with the runtime's own text", async () => {
    const { ctx } = context(() => outcome(jsonFixture(DIR, "strict-config-unknown-key.json")));
    const result = await codex.validate({ model: "gpt-5.5" }, ctx);
    expect(result.status).toBe("ok");
    expect(result.evidence.checks[0]).toMatchObject({ axis: "model", verdict: "unrecognized", scope: "key" });
    expect(result.evidence.checks[0].runtimeText).toContain("unknown configuration field");
  });

  it("validate() is unverifiable when the output shows neither a banner nor a config error", async () => {
    const { ctx } = context(() => outcome({ exitCode: 1, stderr: "something else entirely" }));
    const result = await codex.validate({ reasoning: "high" }, ctx);
    expect(result.evidence.checks[0]).toMatchObject({ axis: "reasoning", verdict: "unverifiable", scope: "key" });
  });

  it("validate() answers a value that could be read as a flag or a TOML injection with an invalid_axis_value result, and runs nothing", async () => {
    const { runner, ctx } = context(() => outcome({ stderr: banner() }));
    for (const bad of [{ model: "--config" }, { reasoning: "-c" }, { model: "" }, { model: "a" + String.fromCharCode(10) + "b" }]) {
      const result = await codex.validate(bad, ctx);
      expect(result.status, JSON.stringify(bad)).toBe("unknown");
      expect(result.diagnostic.code, JSON.stringify(bad)).toBe("invalid_axis_value");
      expect(result.provenance.sourceId).toBe("codex");
    }
    expect(runner.calls).toHaveLength(0);
  });

  it("validate() throws when the caller breaks the input contract: no known axis, or a value that is not a string", async () => {
    const { runner, ctx } = context(() => outcome({ stderr: banner() }));
    await expect(codex.validate({}, ctx)).rejects.toThrow(/model or a reasoning/);
    await expect(codex.validate({ contextTier: "1m" }, ctx)).rejects.toThrow(/model or a reasoning/);
    await expect(codex.validate({ model: 3 }, ctx)).rejects.toThrow(/model must be a string/);
    expect(runner.calls).toHaveLength(0);
  });

  it("validate() returns unavailable with binary_missing when the CLI is absent", async () => {
    const runner = fakeRunner(() => {
      throw enoent("codex");
    });
    const result = await codex.validate({ model: "gpt-5.5" }, { runCommand: runner.runCommand, env: { PATH: "/usr/bin" }, homeDir: "/home/nobody", now: fixedNow });
    expect(result.status).toBe("unavailable");
    expect(result.diagnostic.code).toBe("binary_missing");
  });

  it("renderInvocation() returns structured argv, with the effort as a TOML string", () => {
    const invocation = codex.renderInvocation(resolved({ model: "gpt-6-astra", reasoning: "xhigh" }));
    expect(invocation).toEqual({ runtimeId: "codex", command: "codex", args: ["--model", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"'], unsupportedAxes: [] });
    expect(Object.hasOwn(invocation, "shell")).toBe(false);
    expect(codex.renderInvocation(resolved({ reasoning: "max" })).args).toEqual(["-c", 'model_reasoning_effort="max"']);
    expect(codex.renderInvocation(resolved({ model: "gpt-5.5", verbosity: "low" }))).toMatchObject({ args: ["--model", "gpt-5.5"], unsupportedAxes: ["verbosity"] });
  });

  it("renderInvocation() cannot be made to emit a second option through a quote in the value", () => {
    // The value goes inside a TOML string, so a quote must be escaped rather than closing it.
    const hostile = 'high" -c model="evil';
    const invocation = codex.renderInvocation(resolved({ reasoning: hostile }));
    expect(invocation.args).toHaveLength(2);
    expect(invocation.args[1]).toBe('model_reasoning_effort="high\\" -c model=\\"evil"');
  });

  it("renderInvocation() refuses another runtime's configuration and a value that could be read as a flag", () => {
    const other = makeResolvedRuntimeConfiguration({ runtimeId: "claude", axes: { model: "opus" }, representation: { kind: "native-id", provenance: { sourceId: "claude", sourceKind: "runtime" } } });
    expect(() => codex.renderInvocation(other)).toThrow(/codex/);
    expect(() => codex.renderInvocation(resolved({ model: "--config" }))).toThrow(/model/);
    expect(() => codex.renderInvocation(resolved({ reasoning: 7 }))).toThrow(/reasoning/);
  });

  it("the adapter never writes under the runtime configuration root during discover, observe, or validate", async () => {
    // SEC-1. `codex exec` wrote 4.2 MB of state (rollout files, sqlite databases, shell snapshots)
    // into its config root while this adapter was being written, so the runtime is only ever run in a
    // scratch home. The fake runner plays the runtime and writes there too.
    const home = makeTempDir("mi-codex-home-");
    const realRoot = join(home, ".codex");
    mkdirSync(join(realRoot, "sessions"), { recursive: true });
    writeFileSync(join(realRoot, "config.toml"), 'model = "gpt-5.5"\n');
    writeFileSync(join(realRoot, "auth.json"), "{}");
    const before = snapshotTree(realRoot);

    const writtenTo = [];
    const runner = fakeRunner(
      responder((spec) => {
        const target = spec.env.CODEX_HOME;
        writtenTo.push(target);
        mkdirSync(join(target, "sessions"), { recursive: true });
        writeFileSync(join(target, "sessions", "rollout.jsonl"), "{}");
        if (spec.args[0] === "debug") return outcome({ stdout: catalogText() });
        return outcome({ stderr: banner(), stoppedEarly: true });
      }),
    );
    const env = { PATH: "/usr/bin", OPENAI_API_KEY: "sk-proj-abcdefghijklmnop", CODEX_HOME: realRoot, HTTPS_PROXY: "http://real-proxy:3128", NO_PROXY: "api.openai.com" };
    const ctx = { runCommand: runner.runCommand, env, homeDir: home, now: fixedNow };

    await codex.discover(ctx);
    await codex.observe(ctx);
    await codex.validate({ model: "gpt-5.5", reasoning: "high" }, ctx);

    // The user's own config and credential file are untouched, byte for byte.
    expect(snapshotTree(realRoot)).toEqual(before);
    expect(readFileSync(join(realRoot, "auth.json"), "utf8")).toBe("{}");
    expect(writtenTo.length).toBeGreaterThan(0);
    for (const call of runner.calls) {
      for (const dir of [call.cwd, call.env.HOME, call.env.CODEX_HOME]) expect(dir.startsWith(realRoot), dir).toBe(false);
      // No credential, and the network is unreachable: an ambient proxy or NO_PROXY is replaced, so
      // the provider host cannot be exempted, and no request can leave the machine.
      expect(JSON.stringify(call.env)).not.toMatch(/sk-proj|OPENAI|real-proxy|api\.openai/);
      expect(call.env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
      expect(call.env.NO_PROXY).toBe("");
    }
    for (const dir of writtenTo) expect(existsSync(dir), dir).toBe(false);
  });

  it("refuses to run at all when the scratch location would land inside the real configuration root", async () => {
    const home = makeTempDir("mi-codex-home-");
    const runner = fakeRunner(responder(() => outcome()));
    const ctx = { runCommand: runner.runCommand, env: { PATH: "/usr/bin", CODEX_HOME: home }, homeDir: home, tmpDir: home, now: fixedNow };
    await expect(codex.discover(ctx)).rejects.toThrow(/runtime configuration root/);
    expect(runner.calls).toHaveLength(0);
  });
});
