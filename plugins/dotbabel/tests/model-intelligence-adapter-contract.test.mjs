import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DESCRIPTOR_KINDS,
  NETWORK_MODES,
  AUTH_MODES,
  EXECUTION_MODES,
  OPERATION_TIMEOUTS_MS,
  validateDescriptor,
  assertDescriptor,
  makeAdapterResult,
  unavailable,
  createRegistry,
  resolveTimeoutMs,
  runBounded,
  redactForDiagnostic,
} from "../src/model-intelligence/sources/contract.mjs";
import { SUPPORT_STATES, ADAPTER_RESULT_STATUSES, ARTIFACT_KINDS, SOURCE_KINDS } from "../src/model-intelligence/domain/index.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/model-intelligence/adapter-contract/", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(FIXTURES + name, "utf8"));

/** A minimal valid operation capability. */
const op = (over = {}) => ({ support: "supported", network: "never", auth: "none", cacheable: true, execution: "read-only", ...over });

/** A minimal valid runtime descriptor. */
const descriptor = (over = {}) => ({
  id: "claude",
  kind: "runtime",
  capabilities: {
    discovery: op(),
    observation: op({ execution: "may-execute-model" }),
    binding: { agent: { support: "supported", axes: { model: "supported" } } },
    invocation: { support: "supported", axes: { model: "supported" } },
    validation: op(),
    ...(over.capabilities ?? {}),
  },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "capabilities")),
});

describe("source adapter contract", () => {
  it("validates a SourceAdapterDescriptor and rejects a binding axis with a value outside supported, unsupported, unverified", () => {
    expect(validateDescriptor(descriptor()).errors).toEqual([]);

    // The three static support states are the whole vocabulary (§5 `Support state`).
    // `partial` is the tempting fourth that the spec deliberately does not have:
    // partial discovery is expressed as `unverified`, not as a new state.
    for (const bad of ["partial", "available", "yes", true, null, ""]) {
      const d = descriptor({ capabilities: { binding: { agent: { support: "supported", axes: { model: bad } } } } });
      const { errors } = validateDescriptor(d);
      expect(errors.map((e) => e.path), String(bad)).toContain("capabilities.binding.agent.axes.model");
    }
    // The same vocabulary governs a binding's own support and the invocation axes.
    expect(validateDescriptor(descriptor({ capabilities: { binding: { agent: { support: "partial", axes: {} } } } })).errors.map((e) => e.path)).toContain(
      "capabilities.binding.agent.support",
    );
    expect(validateDescriptor(descriptor({ capabilities: { invocation: { support: "supported", axes: { model: "partial" } } } })).errors.map((e) => e.path)).toContain(
      "capabilities.invocation.axes.model",
    );

    // An unknown artifact kind is rejected, because `binding` is keyed by the
    // canonical kinds (§5 `Artifact kinds`).
    expect(validateDescriptor(descriptor({ capabilities: { binding: { plugin: { support: "supported", axes: {} } } } })).errors.map((e) => e.path)).toContain(
      "capabilities.binding.plugin",
    );

    // An axis NAME is free-form on purpose: axis identifiers belong to the runtime
    // adapter contract and are not a universal Dotbabel enum (§5 `Configuration
    // axes`). An Antigravity selector that fuses model and effort stays one opaque
    // axis rather than being split into `model` and `reasoning`.
    expect(validateDescriptor(descriptor({ capabilities: { invocation: { support: "supported", axes: { selector: "supported" } } } })).errors).toEqual([]);

    expect(() => assertDescriptor(descriptor({ id: "" }))).toThrow(/id/);
  });

  it("restricts descriptor kind to runtime and knowledge-source, which is narrower than the domain source kinds", () => {
    expect([...DESCRIPTOR_KINDS]).toEqual(["runtime", "knowledge-source"]);
    // `domain` also knows `artifact` as a source kind, because an artifact's own
    // frontmatter is evidence about itself. An artifact is not a source ADAPTER, so
    // reusing the wider list here would admit a descriptor that can never implement
    // discover/observe/validate.
    expect(SOURCE_KINDS).toContain("artifact");
    expect(validateDescriptor(descriptor({ kind: "artifact" })).errors.map((e) => e.path)).toContain("kind");
  });

  it("an AdapterResult carries provenance even when status is unavailable", () => {
    const prov = { sourceId: "codex", sourceKind: "runtime" };
    for (const status of ADAPTER_RESULT_STATUSES) {
      // `ok` is the one status that must carry evidence, so it supplies some here;
      // the point of the loop is that provenance is required in every case.
      const r = makeAdapterResult({ status, provenance: prov, ...(status === "ok" ? { evidence: { models: [] } } : {}) });
      expect(r.status, status).toBe(status);
      // Provenance is not a success-path luxury: a failure a caller cannot attribute
      // to a source is a failure it cannot act on or cache against.
      expect(r.provenance, status).toEqual({ sourceId: "codex", sourceKind: "runtime" });
    }
    expect(() => makeAdapterResult({ status: "unavailable" })).toThrow(/provenance/);
    expect(() => makeAdapterResult({ status: "unavailable", provenance: { sourceId: "codex" } })).toThrow(/sourceKind/);

    // A non-ok result carries no evidence, and `ok` without evidence is a
    // contradiction the helper refuses rather than papering over.
    expect(() => makeAdapterResult({ status: "unsupported", provenance: prov, evidence: { models: [] } })).toThrow(/evidence/);
    expect(() => makeAdapterResult({ status: "ok", provenance: prov })).toThrow(/evidence/);

    // The three dimensions stay independent (§5 `Invariant`): freshness and refresh
    // are derived by catalog/, never reported by an adapter.
    for (const leak of ["freshness", "refresh", "stale", "available"]) {
      expect(() => makeAdapterResult({ status: "unknown", provenance: prov, [leak]: "x" }), leak).toThrow(/unknown key/);
    }
  });

  it("contract fixture: exit 0 with empty output is unknown, not ok", () => {
    // The measured OpenCode case (DOC-2, "`opencode models` Grammar and Stability").
    // A zero exit code alone does not mean success, and an empty catalog must never
    // replace a previously valid one (ARCH-30).
    const f = fixture("opencode-exit0-empty-output.json");
    expect(f.process.exitCode).toBe(0);
    expect(f.process.stdout).toBe("");
    const r = makeAdapterResult(f.expectedResult);
    expect(r.status).toBe("unknown");
    expect(r.status).not.toBe("ok");
    expect(r.evidence).toBeUndefined();
    expect(r.diagnostic.code).toBe("empty_output");
    expect(r.provenance.sourceId).toBe("opencode");
  });

  it("contract fixture: a knowledge-source adapter declares binding {} and observation unsupported", () => {
    const d = fixture("knowledge-source-descriptor.json");
    expect(validateDescriptor(d).errors).toEqual([]);
    expect(d.kind).toBe("knowledge-source");
    expect(d.capabilities.binding).toEqual({});
    expect(d.capabilities.observation.support).toBe("unsupported");
    // An operation declared `unsupported` may omit the operational axes: there is no
    // network, auth or execution story for something that does not happen (§5
    // `Knowledge-source adapters`). Declaring them would be noise a reader could
    // mistake for capability.
    expect(d.capabilities.observation.network).toBeUndefined();
    expect(validateDescriptor({ ...d, capabilities: { ...d.capabilities, observation: { support: "supported" } } }).errors.map((e) => e.path)).toContain(
      "capabilities.observation.network",
    );
  });

  it("unverified is never coerced to supported by the registry", () => {
    const reg = createRegistry([
      descriptor({ id: "claude", capabilities: { binding: { agent: { support: "supported", axes: { model: "supported" } } } } }),
      descriptor({ id: "opencode", capabilities: { binding: { skill: { support: "unverified", axes: { model: "unverified" } } } } }),
    ]);

    expect(reg.bindingSupport("claude", "agent")).toBe("supported");
    expect(reg.bindingSupport("opencode", "skill")).toBe("unverified");
    // ARCH-44: fan-out emits a concrete runtime-native value only when the binding is
    // verified. `unverified` means Dotbabel lacks evidence, so treating it as support
    // would emit a projection on a guess.
    expect(reg.isVerified("opencode", "skill")).toBe(false);
    expect(reg.isVerified("claude", "agent")).toBe(true);
    // An undeclared kind is `unverified`, never `unsupported` and never `supported`:
    // absence of a declaration is absence of evidence, not evidence of absence.
    expect(reg.bindingSupport("claude", "workflow")).toBe("unverified");
    expect(reg.isVerified("claude", "workflow")).toBe(false);
    expect(reg.axisSupport("opencode", "skill", "model")).toBe("unverified");
    expect(reg.axisSupport("opencode", "skill", "reasoning")).toBe("unverified");

    // No boolean collapse (§5 `Invariant`): the registry exposes the state, and
    // `isVerified` answers only the ARCH-44 question.
    expect(reg.get("opencode").capabilities.binding.skill.support).toBe("unverified");
    expect(() => reg.get("missing")).toThrow(/missing/);
    expect(() => createRegistry([descriptor({ id: "claude" }), descriptor({ id: "claude" })])).toThrow(/duplicate/);
  });

  it("an operation with no declared timeout gets 10 seconds for a subprocess and 20 seconds for a network call, and expiry returns unavailable with code timeout and retryable true", async () => {
    // REL-1.
    expect(OPERATION_TIMEOUTS_MS.subprocess).toBe(10_000);
    expect(OPERATION_TIMEOUTS_MS.network).toBe(20_000);
    expect(resolveTimeoutMs({ channel: "subprocess" })).toBe(10_000);
    expect(resolveTimeoutMs({ channel: "network" })).toBe(20_000);
    expect(resolveTimeoutMs({ channel: "network", timeoutMs: 500 })).toBe(500);
    expect(() => resolveTimeoutMs({ channel: "carrier-pigeon" })).toThrow(/channel/);
    for (const bad of [0, -1, Number.NaN, Infinity, "500"]) {
      expect(() => resolveTimeoutMs({ channel: "network", timeoutMs: bad }), String(bad)).toThrow(/timeoutMs/);
    }

    const prov = { sourceId: "opencode", sourceKind: "runtime" };
    const slow = await runBounded(() => new Promise((res) => setTimeout(() => res({ models: ["x"] }), 5_000)), { channel: "subprocess", timeoutMs: 20, provenance: prov });
    expect(slow.status).toBe("unavailable");
    expect(slow.diagnostic.code).toBe("timeout");
    // A timeout is a condition of the moment, not a capability fact: the caller may
    // retry, and the adapter keeps its declared support state.
    expect(slow.diagnostic.retryable).toBe(true);
    expect(slow.provenance).toEqual(prov);
    expect(slow.evidence).toBeUndefined();

    const quick = await runBounded(async () => ({ models: ["x"] }), { channel: "subprocess", timeoutMs: 5_000, provenance: prov });
    expect(quick.status).toBe("ok");
    expect(quick.evidence).toEqual({ models: ["x"] });
    expect(quick.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // A thrown operation is `unavailable`, not a crash that loses the provenance.
    const boom = await runBounded(() => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); }, { channel: "subprocess", provenance: prov });
    expect(boom.status).toBe("unavailable");
    expect(boom.diagnostic.code).toBe("binary_missing");
    expect(boom.provenance).toEqual(prov);
  });

  it("a diagnostic built from a command line or environment that holds a secret is redacted before it leaves the adapter", () => {
    // OPS-4: diagnostics must carry 0 credentials, 0 tokens, 0 keys and 0 account
    // identifiers taken from runtime authentication state.
    const secret = "sk-ant-api03-REDACTME0123456789abcdef";
    const out = redactForDiagnostic({
      argv: ["codex", "--api-key", secret, "models", "list", "--token=ghp_ABCDEF0123456789abcdef0123"],
      env: { ANTHROPIC_API_KEY: secret, OPENAI_TOKEN: "sk-proj-zzzz1111", HOME: "/home/kaiocunha", PATH: "/usr/bin" },
    });
    expect(out).not.toContain(secret);
    expect(out).not.toContain("REDACTME");
    expect(out).not.toContain("ghp_ABCDEF0123456789abcdef0123");
    expect(out).not.toContain("sk-proj-zzzz1111");
    // The shape of the failure still has to be readable, or the redaction has simply
    // destroyed the diagnostic.
    expect(out).toContain("codex");
    expect(out).toContain("models");
    expect(out).toMatch(/ANTHROPIC_API_KEY=\[redacted\]/);
    // A non-secret variable survives, so a reader can still tell what ran.
    expect(out).toContain("PATH=/usr/bin");

    // A bare high-entropy token with no flag or variable name attached is still
    // redacted: the adapter cannot rely on a secret being politely labelled.
    expect(redactForDiagnostic({ argv: ["gemini", "AIzaSyB1234567890abcdefghijklmnopqrstuv"] })).not.toContain("AIzaSyB1234567890abcdefghijklmnopqrstuv");

    // Control characters and unbounded length cannot ride into a terminal or a PR
    // comment through a diagnostic.
    const noisy = redactForDiagnostic({ argv: ["codex", "a\u0007b\u001b[31mc", "x".repeat(5_000)] });
    expect(noisy).not.toMatch(/[\u0000-\u0008\u001b]/);
    expect(noisy.length).toBeLessThanOrEqual(1_024);

    // And the helper is wired into the result builder, not merely available beside it.
    const r = unavailable({ provenance: { sourceId: "codex", sourceKind: "runtime" }, code: "nonzero_exit", argv: ["codex", "--api-key", secret] });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.diagnostic.code).toBe("nonzero_exit");
  });

  it("keeps the three independent dimensions out of the descriptor", () => {
    // §5 `Invariant`: static support, current operation outcome, and freshness are
    // three dimensions. A descriptor that carries a runtime outcome or a freshness
    // state has collapsed them.
    for (const leak of ["freshness", "refresh", "availability", "status", "observedAt"]) {
      expect(validateDescriptor(descriptor({ [leak]: "x" })).errors.map((e) => e.path), leak).toContain(leak);
    }
    expect(SUPPORT_STATES).not.toContain("unavailable");
    expect(ADAPTER_RESULT_STATUSES).not.toContain("unverified");
    // Every canonical artifact kind is a legal binding key.
    for (const kind of ARTIFACT_KINDS) {
      expect(validateDescriptor(descriptor({ capabilities: { binding: { [kind]: { support: "unverified", axes: {} } } } })).errors, kind).toEqual([]);
    }
  });

  it("rejects a descriptor whose required capability blocks are missing or malformed", () => {
    const d = descriptor();
    for (const key of ["discovery", "observation", "validation", "invocation", "binding"]) {
      const caps = { ...d.capabilities };
      delete caps[key];
      expect(validateDescriptor({ ...d, capabilities: caps }).errors.map((e) => e.path), key).toContain(`capabilities.${key}`);
    }
    expect(validateDescriptor({ id: "x", kind: "runtime" }).errors.map((e) => e.path)).toContain("capabilities");
    for (const bad of [null, [], "x", 7]) {
      expect(validateDescriptor(bad).errors.length, String(bad)).toBeGreaterThan(0);
    }
    // Every enum on an operation capability is checked, so a typo cannot become an
    // implied default.
    expect(validateDescriptor(descriptor({ capabilities: { discovery: op({ network: "maybe" }) } })).errors.map((e) => e.path)).toContain("capabilities.discovery.network");
    expect(validateDescriptor(descriptor({ capabilities: { discovery: op({ auth: "oauth" }) } })).errors.map((e) => e.path)).toContain("capabilities.discovery.auth");
    expect(validateDescriptor(descriptor({ capabilities: { discovery: op({ execution: "writes" }) } })).errors.map((e) => e.path)).toContain("capabilities.discovery.execution");
    expect(validateDescriptor(descriptor({ capabilities: { discovery: op({ cacheable: "yes" }) } })).errors.map((e) => e.path)).toContain("capabilities.discovery.cacheable");
    expect([...NETWORK_MODES]).toEqual(["never", "optional", "required"]);
    expect([...AUTH_MODES]).toEqual(["none", "optional-existing", "required-existing"]);
    expect([...EXECUTION_MODES]).toEqual(["read-only", "may-execute-model"]);
  });

  it("maps each errno to the failure mode it really is, rather than to a generic error", async () => {
    const prov = { sourceId: "codex", sourceKind: "runtime" };
    const run = (code) => runBounded(() => { throw Object.assign(new Error(`failed: ${code}`), { code }); }, { channel: "subprocess", provenance: prov });

    // A missing binary and a permission refusal are the same actionable fact for a
    // caller: this runtime cannot be invoked here. Neither is a capability change.
    for (const code of ["ENOENT", "EACCES", "EPERM"]) {
      expect((await run(code)).diagnostic.code, code).toBe("binary_missing");
    }
    // A network failure must stay distinguishable from a missing binary, because only
    // one of them is worth retrying on a different connection.
    for (const code of ["ENOTFOUND", "ECONNREFUSED", "ENETUNREACH", "EAI_AGAIN"]) {
      expect((await run(code)).diagnostic.code, code).toBe("network_unavailable");
    }
    expect((await run("ETIMEDOUT")).diagnostic.code).toBe("timeout");
    // An unrecognised errno is named as such instead of being forced into one of the
    // above: guessing a failure mode is how a diagnostic misleads.
    expect((await run("EIO")).diagnostic.code).toBe("runtime_error");
    expect((await run(undefined)).diagnostic.code).toBe("runtime_error");
    // Every error path keeps the provenance and stays retryable.
    const r = await run("EIO");
    expect(r.provenance).toEqual(prov);
    expect(r.diagnostic.retryable).toBe(true);
    expect(r.status).toBe("unavailable");
    // A thrown non-Error still produces a usable diagnostic rather than "undefined".
    const thrownString = await runBounded(() => { throw "plain string failure"; }, { channel: "subprocess", provenance: prov });
    expect(thrownString.diagnostic.message).toContain("plain string failure");
    // And a secret inside a thrown message is masked on the way out (OPS-4).
    const leaky = await runBounded(() => { throw new Error("auth failed for sk-proj-abcdefghijklmnop"); }, { channel: "subprocess", provenance: prov });
    expect(leaky.diagnostic.message).not.toContain("sk-proj-abcdefghijklmnop");
  });

  it("redacts every credential shape it claims to, and each secret-bearing variable name", () => {
    // One assertion per pattern. A redaction suite that checks only the first shape
    // gives false confidence, because the shapes are what the helper is made of.
    const tokens = {
      "openai-style": "sk-proj-abcdefghijklmnop",
      "github-pat": "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "github-oauth": "gho_abcdefghijklmnopqrstuvwxyz0123",
      google: "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
      slack: "xoxb-1234567890-abcdefghij",
      jwt: "eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSM",
      aws: "AKIAIOSFODNN7EXAMPLE",
      "long-opaque": "z".repeat(44),
    };
    for (const [label, token] of Object.entries(tokens)) {
      expect(redactForDiagnostic({ argv: ["codex", token] }), label).not.toContain(token);
      expect(redactForDiagnostic({ env: { SOMETHING: token } }), label).not.toContain(token);
    }
    // Name-based redaction, which catches a credential too short or too plain for any
    // shape rule to notice.
    for (const name of ["ANTHROPIC_API_KEY", "GH_TOKEN", "MY_SECRET", "DB_PASSWORD", "AUTH", "SESSION_ID", "GOOGLE_ACCOUNT", "USER_EMAIL", "COOKIE"]) {
      expect(redactForDiagnostic({ env: { [name]: "short" } }), name).toBe(`${name}=[redacted]`);
    }
    // A variable that merely contains the word elsewhere is not a secret.
    expect(redactForDiagnostic({ env: { KEYBOARD_LAYOUT: "uk" } })).toBe("KEYBOARD_LAYOUT=uk");
    // Flag forms: separated, inline, short and long.
    for (const argv of [["c", "--api-key", "hunter2"], ["c", "--token", "hunter2"], ["c", "--secret", "hunter2"], ["c", "-k", "hunter2"], ["c", "--password", "hunter2"]]) {
      expect(redactForDiagnostic({ argv }), argv.join(" ")).not.toContain("hunter2");
    }
    expect(redactForDiagnostic({ argv: ["c", "--api-key=hunter2"] })).toBe("c --api-key=[redacted]");
    // An inline non-secret flag keeps its value, so the command stays readable.
    expect(redactForDiagnostic({ argv: ["c", "--profile=fast"] })).toBe("c --profile=fast");
    // Only the ONE argument after a secret flag is masked; the rest of the line lives.
    expect(redactForDiagnostic({ argv: ["c", "--token", "hunter2", "models"] })).toBe("c --token [redacted] models");
    // argv and env are joined so a reader can tell which is which.
    expect(redactForDiagnostic({ argv: ["c"], env: { PATH: "/bin" } })).toBe("c | PATH=/bin");
    expect(redactForDiagnostic({})).toBe("");
    expect(redactForDiagnostic()).toBe("");
    // A non-string env value is skipped rather than coerced into the text.
    expect(redactForDiagnostic({ env: { N: 7, OK: "y" } })).toBe("OK=y");
  });

  it("bounds diagnostic text exactly at the documented limit and marks the truncation", () => {
    // Many short words, not one long token: a single 3,000-character token is caught by
    // the opaque-value rule and becomes `[redacted]`, so it never reaches the length
    // bound and would test nothing.
    const long = redactForDiagnostic({ argv: ["c", ...Array.from({ length: 900 }, (_, i) => `arg${i % 10}`)] });
    expect(long.length).toBe(1_024);
    // An ellipsis tells the reader the text was cut, instead of leaving them to
    // wonder whether the command really ended there.
    expect(long.endsWith("…")).toBe(true);
    // A string under the limit is untouched.
    const short = redactForDiagnostic({ argv: ["codex", "models"] });
    expect(short).toBe("codex models");
    expect(short.endsWith("…")).toBe(false);
  });

  it("builds an unavailable result with and without an optional message or retryable flag", () => {
    const provenance = { sourceId: "codex", sourceKind: "runtime" };
    // With no message and no context, the code still has to produce readable text
    // rather than an empty message.
    expect(unavailable({ provenance, code: "auth_required" }).diagnostic.message).toBe("auth_required");
    expect(unavailable({ provenance, code: "auth_required" }).diagnostic).not.toHaveProperty("retryable");
    expect(unavailable({ provenance, code: "auth_required", retryable: false }).diagnostic.retryable).toBe(false);
    // A message and a redacted context are joined, not one dropped for the other.
    const both = unavailable({ provenance, code: "nonzero_exit", message: "exit 1", argv: ["codex", "models"] });
    expect(both.diagnostic.message).toBe("exit 1: codex models");
    expect(unavailable({ provenance, code: "nonzero_exit", message: "exit 1" }).diagnostic.message).toBe("exit 1");
    expect(unavailable({ provenance, code: "x", argv: ["codex"] }).diagnostic.message).toBe("codex");
    expect(unavailable({ provenance, code: "x" }).status).toBe("unavailable");
  });

  it("names the field and the reason when a descriptor or result is rejected", () => {
    // A thrown message is the only thing an author sees, so it carries the path.
    expect(() => assertDescriptor({ id: "x", kind: "runtime" })).toThrow(/capabilities: is required|capabilities: must be an object/);
    expect(() => assertDescriptor(7)).toThrow(/<root>: descriptor must be an object, got number/);
    expect(() => assertDescriptor(descriptor({ kind: "artifact" }))).toThrow(/kind: must be one of runtime, knowledge-source/);
    expect(validateDescriptor(descriptor({ capabilities: { discovery: op({ support: "partial" }) } })).errors[0].message).toMatch(
      /must be one of supported, unsupported, unverified/,
    );
    // Several problems come back together, because an author fixing a descriptor
    // wants the whole list rather than one error per run.
    expect(validateDescriptor({ id: "", kind: "nope", capabilities: {} }).errors.length).toBeGreaterThan(2);

    const prov = { sourceId: "codex", sourceKind: "runtime" };
    expect(() => makeAdapterResult({ status: "nope", provenance: prov })).toThrow(/status must be one of ok, unsupported, unavailable, unknown/);
    expect(() => makeAdapterResult({ status: "unknown", provenance: { sourceId: "", sourceKind: "runtime" } })).toThrow(/sourceId must be a non-empty string/);
    expect(() => makeAdapterResult({ status: "unknown", provenance: { sourceId: "x", sourceKind: "artifact" } })).toThrow(/sourceKind must be one of/);
    expect(() => makeAdapterResult({ status: "unknown", provenance: prov, diagnostic: "boom" })).toThrow(/diagnostic must be an object, got string/);
    expect(() => makeAdapterResult({ status: "unknown", provenance: prov, diagnostic: { message: "no code" } })).toThrow(/diagnostic\.code must be a non-empty string/);
    expect(() => makeAdapterResult(null)).toThrow(/must be an object, got null/);
    // The result and its nested records are frozen, so a consumer cannot edit
    // provenance after the fact and change what a cached fact claims.
    const r = makeAdapterResult({ status: "ok", evidence: 1, provenance: prov, diagnostic: { code: "c" } });
    expect(Object.isFrozen(r) && Object.isFrozen(r.provenance) && Object.isFrozen(r.diagnostic)).toBe(true);
  });

  it("exposes registry membership and invocation axes without collapsing a state to a boolean", () => {
    const reg = createRegistry([fixture("runtime-descriptor.json"), fixture("knowledge-source-descriptor.json")]);
    expect(reg.ids).toEqual(["claude", "models-dev"]);
    expect(reg.has("claude")).toBe(true);
    expect(reg.has("nope")).toBe(false);

    // Invocation is a separate dimension from artifact binding: a runtime can select a
    // model on its CLI with no verified way to bind one to a skill (ARCH-50).
    expect(reg.invocationAxisSupport("claude", "model")).toBe("supported");
    expect(reg.invocationAxisSupport("claude", "reasoning")).toBe("unsupported");
    expect(reg.invocationAxisSupport("claude", "contextTier")).toBe("unverified");
    expect(reg.invocationAxisSupport("models-dev", "model")).toBe("unverified");

    // isVerified with an axis requires BOTH the kind and that axis to be supported.
    expect(reg.isVerified("claude", "agent", "model")).toBe(true);
    expect(reg.isVerified("claude", "command", "reasoning")).toBe(false);
    expect(reg.isVerified("claude", "command", "model")).toBe(true);
    expect(reg.isVerified("claude", "skill", "model")).toBe(false);
    expect(reg.isVerified("claude", "agent", "contextTier")).toBe(false);
    expect(reg.axisSupport("claude", "command", "reasoning")).toBe("unsupported");

    // A knowledge source binds nothing, and says so explicitly.
    expect(reg.bindingSupport("models-dev", "agent")).toBe("unverified");
    expect(reg.isVerified("models-dev", "agent")).toBe(false);

    // A prototype key cannot be smuggled through a lookup.
    expect(reg.bindingSupport("claude", "__proto__")).toBe("unverified");
    expect(reg.axisSupport("claude", "agent", "__proto__")).toBe("unverified");
    expect(reg.invocationAxisSupport("claude", "__proto__")).toBe("unverified");

    expect(() => createRegistry("nope")).toThrow(/must be an array, got string/);
    expect(() => createRegistry([{ id: "bad", kind: "runtime" }])).toThrow(/invalid source adapter descriptor/);
    expect(Object.isFrozen(reg)).toBe(true);
  });

  it("uses the injected clock and permits the documented optional descriptor keys", async () => {
    // `runBounded` does not read the clock itself, so a caller can make the whole
    // result deterministic (ARCH-56: the resolver cannot read time).
    const prov = { sourceId: "codex", sourceKind: "runtime" };
    const fixed = "2026-01-01T00:00:00.000Z";
    const r = await runBounded(async () => 1, { channel: "network", provenance: prov, now: () => fixed });
    expect(r.observedAt).toBe(fixed);
    const t = await runBounded(() => new Promise((res) => setTimeout(res, 5_000)), { channel: "network", timeoutMs: 15, provenance: prov, now: () => fixed });
    expect(t.observedAt).toBe(fixed);
    expect(t.diagnostic.message).toMatch(/exceeded 15 ms on the network channel/);

    // `version` and `$comment` are accepted so a descriptor can be shipped as a
    // documented file; every other extra key is still an error.
    expect(validateDescriptor({ ...descriptor(), version: 1, $comment: "notes" }).errors).toEqual([]);
    expect(validateDescriptor({ ...descriptor(), notes: "x" }).errors.map((e) => e.path)).toContain("notes");
  });

  it("handles a non-string argv element and every inline flag spelling", () => {
    // An adapter may assemble argv from numbers or paths, and a diagnostic must not
    // crash on one or silently drop it.
    expect(redactForDiagnostic({ argv: ["codex", 7, true] })).toBe("codex 7 true");
    expect(redactForDiagnostic({ argv: ["codex", "--retries=3"] })).toBe("codex --retries=3");
    // A single-dash inline flag is handled like a double-dash one.
    expect(redactForDiagnostic({ argv: ["c", "-t=hunter2"] })).toBe("c -t=[redacted]");
    // An inline value that is itself secret-shaped is masked even behind a benign flag.
    expect(redactForDiagnostic({ argv: ["c", "--url=https://x/sk-proj-abcdefghijklmnop"] })).not.toContain("sk-proj-abcdefghijklmnop");
    // An `=` inside the value does not split it twice.
    expect(redactForDiagnostic({ argv: ["c", "--filter=a=b"] })).toBe("c --filter=a=b");
    // A bare `--` and a lone `-` are not flags and pass through.
    expect(redactForDiagnostic({ argv: ["c", "--", "-"] })).toBe("c -- -");

    // Only `argv`, only `env`, and neither, so the joining logic is exercised on each
    // branch rather than only the both-present one.
    const provenance = { sourceId: "codex", sourceKind: "runtime" };
    expect(unavailable({ provenance, code: "c", env: { PATH: "/bin" } }).diagnostic.message).toBe("PATH=/bin");
    expect(unavailable({ provenance, code: "c", argv: ["x"] }).diagnostic.message).toBe("x");
    expect(unavailable({ provenance, code: "c", env: {} }).diagnostic.message).toBe("c");
    expect(unavailable({ provenance, code: "c", argv: [] }).diagnostic.message).toBe("c");
  });

  it("names an array and a null distinctly in a shape error, and blocks every unsafe key", () => {
    // `typeOf` exists so a shape error tells an author what they actually wrote. An
    // array reported as "object" sends them looking in the wrong place.
    expect(validateDescriptor(descriptor({ capabilities: { discovery: [] } })).errors[0].message).toContain("got array");
    expect(validateDescriptor(descriptor({ capabilities: { discovery: null } })).errors[0].message).toContain("got null");
    expect(validateDescriptor(descriptor({ capabilities: { invocation: { support: "supported", axes: [] } } })).errors.map((e) => e.message).join()).toContain("got array");
    expect(validateDescriptor([]).errors[0].message).toContain("got array");

    // All three unsafe keys, in both places a parsed document can carry them.
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const asAxis = validateDescriptor(descriptor({ capabilities: { invocation: { support: "supported", axes: { [key]: "supported" } } } }));
      expect(asAxis.errors.map((e) => e.path), key).toContain(`capabilities.invocation.axes.${key}`);
      const asKind = JSON.parse(`{"id":"x","kind":"runtime","capabilities":{"discovery":{"support":"unsupported"},"observation":{"support":"unsupported"},"validation":{"support":"unsupported"},"invocation":{"support":"unsupported","axes":{}},"binding":{"${key}":{"support":"supported","axes":{}}}}}`);
      expect(validateDescriptor(asKind).errors.map((e) => e.path), key).toContain(`capabilities.binding.${key}`);
    }
    // An env variable named for a prototype key is dropped rather than rendered.
    expect(redactForDiagnostic({ env: JSON.parse(String.raw`{"__proto__":"x","OK":"y"}`) })).toBe("OK=y");
  });

  it("validates the shipped runtime fixture and treats a prototype key as a validation error", () => {
    const d = fixture("runtime-descriptor.json");
    expect(validateDescriptor(d).errors).toEqual([]);
    expect(d.capabilities.observation.execution).toBe("may-execute-model");

    // A descriptor may be read from a file, so the same prototype hazard that bit
    // policy/ applies here (CWE-1321).
    const hostile = JSON.parse(String.raw`{"id":"x","kind":"runtime","capabilities":{"binding":{"__proto__":{"support":"supported","axes":{}}}}}`);
    expect(validateDescriptor(hostile).errors.map((e) => e.path)).toContain("capabilities.binding.__proto__");
  });
});
