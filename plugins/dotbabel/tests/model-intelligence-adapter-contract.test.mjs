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
const descriptor = ({ capabilities, ...rest } = {}) => ({
  id: "claude",
  kind: "runtime",
  capabilities: {
    discovery: op(),
    observation: op({ execution: "may-execute-model" }),
    binding: { agent: { support: "supported", axes: { model: "supported" } } },
    invocation: { support: "supported", axes: { model: "supported" } },
    validation: op(),
    ...capabilities,
  },
  ...rest,
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
    //
    // What this proves, and what it does not. P-5 defines the contract and owns no
    // classifier, so it cannot show that an ADAPTER turns this process into `unknown`:
    // that is the P-6 and P-7 adapters' obligation, and `expectedResult` in the fixture
    // is the outcome their classification must produce for the `process` block. What the
    // contract does own is (1) admitting and preserving this result, and (2) refusing
    // the wrong answer: it will not build an `ok` result that carries no evidence, so an
    // empty catalog can never be reported as a successful one (ARCH-30). Cache
    // preservation on a failed refresh is REL-2 and belongs to catalog/, not here.
    const f = fixture("opencode-exit0-empty-output.json");
    expect(f.process.exitCode).toBe(0);
    expect(f.process.stdout).toBe("");
    const r = makeAdapterResult(f.expectedResult);
    expect(r.status).toBe("unknown");
    expect(() => makeAdapterResult({ ...f.expectedResult, status: "ok" })).toThrow(/requires evidence/);
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
    const r = makeAdapterResult({ status: "ok", evidence: 1, provenance: prov, diagnostic: { code: "c", message: "m" } });
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

    // `$comment` is accepted so a descriptor can be shipped as a documented file;
    // every other extra key is an error, including `version`, which the §5 interface
    // does not define and which would be ambiguous beside the two provenance versions.
    expect(validateDescriptor({ ...descriptor(), $comment: "notes" }).errors).toEqual([]);
    expect(validateDescriptor({ ...descriptor(), notes: "x" }).errors.map((e) => e.path)).toContain("notes");
    expect(validateDescriptor({ ...descriptor(), version: 1 }).errors.map((e) => e.path)).toContain("version");
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

// Findings from the PR 407 review. Each defect below was reproduced against the module
// before it was fixed, so each of these tests failed first.
describe("review hardening", () => {
  const prov = { sourceId: "codex", sourceKind: "runtime" };
  const paths = (d) => validateDescriptor(d).errors.map((e) => e.path);

  it("masks a secret in a diagnostic message on every path that can carry one", async () => {
    const secret = "sk-ant-api03-AbCdEf0123456789";
    expect(unavailable({ provenance: prov, code: "nonzero_exit", message: `login failed: ${secret}` }).diagnostic.message).not.toContain(secret);

    // unavailable() is not the only builder. A hand-built unsupported or unknown result
    // goes through the same guard, so an adapter cannot forget it (OPS-4).
    const built = makeAdapterResult({ status: "unsupported", provenance: prov, diagnostic: { code: "auth_required", message: `${secret} ${"x ".repeat(2_000)}` } });
    expect(built.diagnostic.message).not.toContain(secret);
    expect(built.diagnostic.message.length).toBeLessThanOrEqual(1_024);

    // A LABELLED secret has no recognisable shape; the label is what identifies it.
    const labelled = [
      "Command failed with exit code 1: codex --api-key hunter2 models",
      "authentication failed (password=hunter2)",
      "token: hunter2 rejected",
      "Authorization: Bearer hunter2",
      "request to https://user:hunter2@example.com/x failed",
    ];
    for (const message of labelled) {
      const thrown = await runBounded(() => { throw new Error(message); }, { channel: "subprocess", provenance: prov });
      expect(thrown.diagnostic.message, message).not.toContain("hunter2");
    }
  });

  it("requires a diagnostic message, as section 5 declares it required", () => {
    expect(() => makeAdapterResult({ status: "unknown", provenance: prov, diagnostic: { code: "timeout" } })).toThrow(/diagnostic\.message/);
    expect(() => makeAdapterResult({ status: "unknown", provenance: prov, diagnostic: { code: "timeout", message: "" } })).toThrow(/diagnostic\.message/);
  });

  it("redacts compound credential flags, header arguments and URL userinfo", () => {
    const secretArgv = [
      ["c", "--access-token", "hunter2"],
      ["c", "--client-secret=hunter2"],
      ["c", "--refresh-token", "hunter2"],
      ["c", "--auth-token", "hunter2"],
      ["c", "--private-key", "hunter2"],
      ["c", "--authorization", "hunter2"],
      ["curl", "-H", "Authorization: Bearer hunter2"],
      ["curl", "-H", "Cookie: sid=hunter2"],
      ["curl", "--header", "X-Api-Key: hunter2"],
    ];
    for (const argv of secretArgv) expect(redactForDiagnostic({ argv }), argv.join(" ")).not.toContain("hunter2");

    // The command and its subcommands survive, so the diagnostic stays readable.
    expect(redactForDiagnostic({ argv: ["codex", "--access-token", "hunter2", "models"] })).toBe("codex --access-token [redacted] models");
    expect(redactForDiagnostic({ argv: ["curl", "-H", "Authorization: Bearer hunter2"] })).toBe("curl -H Authorization: [redacted]");

    // Userinfo carries the credential; the host and path do not, and stay.
    expect(redactForDiagnostic({ argv: ["git", "clone", "https://oauth2:glpat-A1b2C3d4E5f6G7h8I9j0@gitlab.com/x.git"] })).toBe("git clone https://[redacted]@gitlab.com/x.git");
    expect(redactForDiagnostic({ env: { DATABASE_URL: "postgres://admin:hunter2@db:5432/app" } })).toBe("DATABASE_URL=postgres://[redacted]@db:5432/app");
    expect(redactForDiagnostic({ argv: ["curl", "https://example.com/a?b=c"] })).toBe("curl https://example.com/a?b=c");
  });

  it("redacts every conventional secret-bearing variable name, including compound and plural forms", () => {
    const secretNames = ["PGPASSWORD", "OPENAI_APIKEY", "API_KEYS", "TOKENS", "MYSQL_PASS", "GITHUB_PAT", "NPM_AUTHTOKEN", "APP_PWD", "CLIENT_SECRETS"];
    for (const name of secretNames) expect(redactForDiagnostic({ env: { [name]: "hunter2" } }), name).toBe(`${name}=[redacted]`);
    // Over-redaction is the deliberate bias, but ordinary variables must stay readable.
    for (const name of ["KEYBOARD_LAYOUT", "PATH", "HOME", "EDITOR", "LANG"]) {
      expect(redactForDiagnostic({ env: { [name]: "plain" } }), name).toBe(`${name}=plain`);
    }
  });

  it("normalizes control and format characters before matching, so they cannot split a token", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const bell = String.fromCharCode(7);
    // The shape rule needs the token contiguous. A zero-width character used to break the
    // match first and only become visible noise afterwards.
    expect(redactForDiagnostic({ env: { OPAQUE: `sk-abc${zeroWidth}defghijklmnop` } })).not.toContain("defghijklmnop");
    expect(redactForDiagnostic({ argv: ["codex", `sk-abc${bell}defghijklmnop`] })).not.toContain("defghijklmnop");
  });

  it("never splits a surrogate pair when it truncates", () => {
    const emoji = String.fromCodePoint(0x1f600);
    // The cut falls between the two halves of the emoji, which used to leave a lone
    // surrogate that corrupts JSON output and PR comments.
    const r = unavailable({ provenance: prov, code: "x", message: "a".repeat(1_022) + emoji + "tail" });
    expect(r.diagnostic.message.length).toBeLessThanOrEqual(1_024);
    expect(r.diagnostic.message.isWellFormed()).toBe(true);
  });

  it("accepts only the four provenance fields, typed, and an ISO observedAt", () => {
    const base = { status: "ok", evidence: 1 };
    const full = makeAdapterResult({ ...base, provenance: { sourceId: "x", sourceKind: "runtime", sourceVersion: "2.0.5", adapterVersion: "1" }, observedAt: "2026-09-18T00:00:00.000Z" });
    expect(full.provenance).toEqual({ sourceId: "x", sourceKind: "runtime", sourceVersion: "2.0.5", adapterVersion: "1" });

    // OPS-4 keeps identifiers out of provenance, and the section 5 invariant keeps the
    // three dimensions apart: neither an account nor a freshness may ride along.
    for (const extra of [{ accountId: "user@example.com" }, { derivation: "declared" }, { freshness: "stale" }]) {
      expect(() => makeAdapterResult({ ...base, provenance: { sourceId: "x", sourceKind: "runtime", ...extra } }), Object.keys(extra)[0]).toThrow(/provenance.*unknown key/);
    }
    for (const bad of [42, {}, true, ""]) {
      expect(() => makeAdapterResult({ ...base, provenance: { sourceId: "x", sourceKind: "runtime", sourceVersion: bad } }), String(bad)).toThrow(/sourceVersion/);
      expect(() => makeAdapterResult({ ...base, provenance: { sourceId: "x", sourceKind: "runtime", adapterVersion: bad } }), String(bad)).toThrow(/adapterVersion/);
    }
    // observedAt is the one input catalog/ derives freshness from, so a bad one becomes a
    // freshness bug in a module that cannot defend itself against it.
    for (const bad of [12345, new Date(), "yesterday", "2026-13-40T99:00:00Z", ""]) {
      expect(() => makeAdapterResult({ ...base, provenance: prov, observedAt: bad }), String(bad)).toThrow(/observedAt/);
    }
    expect(() => makeAdapterResult({ ...base, provenance: prov, observedAt: "2026-09-18T00:00:00+02:00" })).not.toThrow();
  });

  it("rejects unknown keys inside capability blocks, and operational keys on an unsupported operation", () => {
    expect(paths(descriptor({ capabilities: { discovery: op({ availability: "available" }) } }))).toContain("capabilities.discovery.availability");
    expect(paths(descriptor({ capabilities: { discovery: op({ freshness: "fresh" }) } }))).toContain("capabilities.discovery.freshness");
    // "May omit" is not "may contradict": an unsupported operation with a network story
    // is the reader confusion the omission rule exists to prevent.
    for (const key of ["network", "auth", "cacheable", "execution"]) {
      const block = { support: "unsupported", [key]: key === "cacheable" ? true : "never" };
      expect(paths(descriptor({ capabilities: { observation: block } })), key).toContain(`capabilities.observation.${key}`);
    }
    // A resurrected boolean the spec deliberately replaced with enums must not survive.
    expect(paths(descriptor({ capabilities: { binding: { agent: { support: "supported", axes: {}, requiresNetwork: true } } } }))).toContain("capabilities.binding.agent.requiresNetwork");
    expect(paths(descriptor({ capabilities: { invocation: { support: "supported", axes: {}, extra: 1 } } }))).toContain("capabilities.invocation.extra");
    // `$comment` is the documented annotation key inside every block.
    expect(paths(descriptor({ capabilities: { discovery: op({ $comment: "why" }) } }))).toEqual([]);
  });

  it("answers from a validated snapshot, not from an object the caller can still edit", () => {
    const d = descriptor();
    const reg = createRegistry([d]);
    // The registry does not own the caller's object, so it must not freeze it.
    expect(Object.isFrozen(d)).toBe(false);
    // Editing afterwards must not change what the registry reports about an unmeasured
    // capability (ARCH-44).
    d.capabilities.binding.agent.support = "unsupported";
    d.capabilities.binding.skill = { support: "supported", axes: { model: "supported" } };
    expect(reg.bindingSupport("claude", "agent")).toBe("supported");
    expect(reg.isVerified("claude", "skill")).toBe(false);
    // And the snapshot itself is frozen all the way down.
    expect(Object.isFrozen(reg.get("claude").capabilities.binding.agent.axes)).toBe(true);
  });

  it("hands the operation an AbortSignal and aborts it only when the timeout wins", async () => {
    let seen;
    let aborted = false;
    const timedOut = await runBounded(
      ({ signal }) => {
        seen = signal;
        signal.addEventListener("abort", () => { aborted = true; });
        return new Promise(() => {});
      },
      { channel: "subprocess", timeoutMs: 20, provenance: prov },
    );
    expect(timedOut.diagnostic.code).toBe("timeout");
    expect(seen).toBeInstanceOf(AbortSignal);
    // Promise.race abandons the loser but cannot stop it; the signal is what lets a
    // subprocess adapter kill its child instead of leaving it running.
    expect(aborted).toBe(true);

    let finished;
    await runBounded(async ({ signal }) => { finished = signal; return 1; }, { channel: "subprocess", provenance: prov });
    expect(finished.aborted).toBe(false);
  });

  it("reports an operation that resolves no evidence as unknown, not as a transient failure", async () => {
    // A resolved undefined used to make makeAdapterResult throw inside the try block, and
    // the catch reported that programming error as an unavailable, retryable runtime error.
    const r = await runBounded(async () => undefined, { channel: "subprocess", provenance: prov });
    expect(r.status).toBe("unknown");
    expect(r.diagnostic.code).toBe("insufficient_evidence");
    expect(r.evidence).toBeUndefined();
  });

  it("rejects a timeout the timer cannot honour", () => {
    // Node clamps a delay above 2**31-1 to 1 ms, which turns a generous timeout into an
    // immediate one, and a fraction is clamped up the same way.
    for (const bad of [2 ** 31, 2_147_483_648, 0.4, 1.5]) {
      expect(() => resolveTimeoutMs({ channel: "network", timeoutMs: bad }), String(bad)).toThrow(/timeoutMs/);
    }
    expect(resolveTimeoutMs({ channel: "network", timeoutMs: 2_147_483_647 })).toBe(2_147_483_647);
    expect(resolveTimeoutMs({ channel: "network", timeoutMs: 1 })).toBe(1);
  });

  it("keeps stale out of the adapter result vocabulary, because freshness is derived by catalog", () => {
    // ARCH-12 lists `stale` among the states an adapter may report. Section 5 supersedes
    // it: freshness is derived from observedAt, and a flat `status: stale` is the
    // ambiguous form the spec names as the thing to avoid.
    expect(ADAPTER_RESULT_STATUSES).not.toContain("stale");
    expect(() => makeAdapterResult({ status: "stale", provenance: prov })).toThrow(/status must be one of/);
  });
});
