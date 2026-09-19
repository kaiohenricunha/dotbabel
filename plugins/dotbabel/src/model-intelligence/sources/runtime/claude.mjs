/**
 * model-intelligence/sources/runtime/claude — the Claude Code source adapter (P-6)
 * (docs/specs/model-intelligence, ARCH-13, ARCH-17, ARCH-47, ARCH-49, SEC-1).
 *
 * What Claude Code exposes, as measured (DOC-2, re-measured on 2.1.278 while this was written):
 *
 * - **No enumeration.** There is no command that lists models, so `discover` is `unsupported`.
 * - **The resolved model is free.** `system/init` is emitted before authentication and already names
 *   the resolved canonical model: `--model opus` became `claude-opus-5`, at no cost. DOC-2 says
 *   observation needs a billable turn; that is true only of `result.modelUsage`, which stays empty
 *   until a turn runs. So the model itself is observable with no credential and no turn.
 * - **Model validation is a catalog check, not a refusal.** 2.1.274 rejected an unknown model
 *   synchronously. 2.1.278 prints a warning that its own catalog does not describe the model and
 *   carries on to authentication, so a model unknown to the CLI may still be valid to the API.
 *   Recognising is therefore reported as `recognized` / `unrecognized`, never as accepted / rejected.
 * - **Effort is invisible.** Neither `system/init` nor `modelUsage` carries an effort, so an effort
 *   setting can be validated but never observed (DOC-2, constraint 19).
 *
 * Every run happens in a scratch home with no credential and no route to the network (see
 * `process.mjs`), because Claude Code writes projects, backups and telemetry into its configuration
 * root even with `--no-session-persistence`, and SEC-1 forbids writing there. A consequence is that
 * this adapter never runs a model turn. Complete observation, with `result.modelUsage`, needs one, and
 * the descriptor declares `may-execute-model` for the capability so no caller mistakes it for free
 * discovery: a caller that has a stream from a turn it ran elsewhere passes it as `context.stream`.
 */

import { makeAdapterResult, assertDescriptor, isVersionString } from "../contract.mjs";
import { deepFreeze, makeInvocation, makeObservedConfiguration, makeValidationEvidence, optionalCount, optionalIdentifier } from "../evidence.mjs";
import { assertOpaqueValue, firstLine, probeVersion, resolveContext, runIsolated } from "./process.mjs";

/** The `RUNTIMES` id this adapter serves, and the `sourceId` of every result it returns. */
export const RUNTIME_ID = "claude";

/** Stamped into provenance as `adapterVersion`. Bump it when the adapter's behavior or evidence shape changes. */
export const ADAPTER_VERSION = "1";

/** The runtime's configuration-root variable and default directory name. */
const ROOT = Object.freeze({ rootEnvVar: "CLAUDE_CONFIG_DIR", rootDirName: ".claude" });

/** A prompt is required by `-p`, but nothing is ever sent: there is no credential to send it with. */
const PROBE_PROMPT = "x";

const OPERATION_READ_ONLY = { support: "supported", network: "never", auth: "none", cacheable: false, execution: "read-only" };

/**
 * The adapter's declared capabilities.
 *
 * Observation declares `may-execute-model` because complete observation needs `result.modelUsage`,
 * which exists only after a model turn that this adapter deliberately never runs (SEC-1).
 */
export const descriptor = deepFreeze(
  assertDescriptor({
    id: RUNTIME_ID,
    kind: "runtime",
    capabilities: {
      discovery: { support: "unsupported" },
      observation: { support: "supported", network: "optional", auth: "optional-existing", cacheable: false, execution: "may-execute-model" },
      binding: {
        agent: { support: "supported", axes: { model: "supported", reasoning: "supported" } },
        command: { support: "supported", axes: { model: "supported", reasoning: "unverified" } },
        skill: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } },
      },
      invocation: { support: "supported", axes: { model: "supported", reasoning: "supported" } },
      validation: { ...OPERATION_READ_ONLY },
    },
  }),
);

/** The provenance every result from this adapter starts from. */
const baseProvenance = () => ({ sourceId: RUNTIME_ID, sourceKind: "runtime", adapterVersion: ADAPTER_VERSION });

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `result.modelUsage`. Its entries are keyed by model id and carry a set of fields that differs
 * from entry to entry, so every field is optional and a field of the wrong type is dropped, never invented.
 * @param {unknown} modelUsage
 * @returns {object[]}
 */
function parseUsage(modelUsage) {
  if (!isPlainObject(modelUsage)) return [];
  /** @type {object[]} */
  const usage = [];
  for (const [key, entry] of Object.entries(/** @type {object} */ (modelUsage))) {
    const model = optionalIdentifier(key);
    if (model === undefined || !isPlainObject(entry)) continue;
    const e = /** @type {Record<string, unknown>} */ (entry);
    /** @type {Record<string, unknown>} */
    const record = { model };
    for (const [field, read] of [["canonicalModel", optionalIdentifier], ["provider", optionalIdentifier], ["contextWindow", optionalCount], ["maxOutputTokens", optionalCount], ["thinkingTokens", optionalCount]]) {
      const value = /** @type {(v: unknown) => unknown} */ (read)(e[/** @type {string} */ (field)]);
      if (value !== undefined) record[/** @type {string} */ (field)] = value;
    }
    usage.push(record);
  }
  return usage;
}

/**
 * Parse Claude Code's `--output-format stream-json`: one JSON event per line.
 *
 * A line that is not JSON, or not an object, is counted and skipped, so one bad line cannot hide the
 * events around it. Only the two events this adapter reads are kept.
 * @param {unknown} text
 * @returns {{init?: {model?: string, version?: string, apiKeySource?: string}, result?: {isError: boolean, usage: object[]}, malformedLines: number, empty: boolean}}
 */
export function parseStreamJson(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  /** @type {any} */
  const parsed = { malformedLines: 0, empty: lines.length === 0 };
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parsed.malformedLines += 1;
      continue;
    }
    if (!isPlainObject(event)) {
      parsed.malformedLines += 1;
      continue;
    }
    if (event.type === "system" && event.subtype === "init" && parsed.init === undefined) {
      parsed.init = { model: optionalIdentifier(event.model), version: optionalIdentifier(event.claude_code_version), apiKeySource: optionalIdentifier(event.apiKeySource) };
    } else if (event.type === "result") {
      parsed.result = { isError: event.is_error === true, usage: parseUsage(event.modelUsage) };
    }
  }
  return parsed;
}

/**
 * True once a complete `system/init` line has arrived. The last line may be cut off, so it is ignored.
 * @param {{stdout: string}} streams
 * @returns {boolean}
 */
function initComplete({ stdout }) {
  const lines = stdout.split("\n");
  lines.pop();
  return lines.some((line) => {
    try {
      const event = JSON.parse(line);
      return isPlainObject(event) && event.type === "system" && event.subtype === "init";
    } catch {
      return false;
    }
  });
}

/**
 * Turn a parsed stream into a result, classifying what cannot be used as `unknown`.
 * @param {ReturnType<typeof parseStreamJson>} parsed
 * @param {import("./process.mjs").RuntimeContext} ctx
 * @param {string} [detail] Runtime text to include in a diagnostic, already a single line.
 * @returns {object}
 */
function classifyStream(parsed, ctx, detail) {
  const provenance = baseProvenance();
  const unknown = (code, message) => makeAdapterResult({ status: "unknown", provenance, observedAt: ctx.now(), diagnostic: { code, message } });
  if (parsed.empty) return unknown("empty_output", "the runtime produced no output, so the resolved model cannot be determined");
  if (parsed.init === undefined || parsed.init.model === undefined) {
    if (parsed.malformedLines > 0 && parsed.result === undefined) return unknown("malformed_output", "the output contained no readable stream-json event");
    return unknown("insufficient_evidence", detail === undefined || detail === "" ? "the stream held no system/init event naming a model" : `the stream held no system/init event naming a model: ${detail}`);
  }
  const turnExecuted = (parsed.result?.usage.length ?? 0) > 0;
  const observed = makeObservedConfiguration({
    runtimeId: RUNTIME_ID,
    turnExecuted,
    model: parsed.init.model,
    fieldSources: { model: "system/init.model" },
    usage: parsed.result?.usage ?? [],
    ...(isVersionString(parsed.init.version) ? { runtimeVersion: parsed.init.version } : {}),
  });
  return makeAdapterResult({
    status: "ok",
    evidence: observed,
    provenance: { ...provenance, ...(isVersionString(parsed.init.version) ? { sourceVersion: parsed.init.version } : {}) },
    observedAt: ctx.now(),
  });
}

/**
 * Claude Code offers no way to list models, so this reports discovery as unsupported instead of
 * returning an empty list that would read as "no models".
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function discover(context) {
  const ctx = resolveContext(context, ROOT);
  return makeAdapterResult({
    status: "unsupported",
    provenance: baseProvenance(),
    observedAt: ctx.now(),
    diagnostic: { code: "no_enumeration", message: "Claude Code exposes no command that enumerates models; only the active model is observable" },
  });
}

/**
 * Observe the model Claude Code resolves.
 *
 * With `context.stream` (stream-json text from a run the caller already made) nothing is executed and the
 * text is parsed. Without it, one credential-free probe runs in a scratch home and stops as soon as
 * `system/init` arrives, so the resolved model is read with no model turn (see the module header).
 *
 * `context.model` and `context.effort` are passed to the probe so the answer reflects those flags.
 * @param {object} [context]
 * @param {string} [context.stream]
 * @param {string} [context.model]
 * @param {string} [context.effort]
 * @returns {Promise<object>}
 */
export async function observe(context = {}) {
  const ctx = resolveContext(context, ROOT);
  const options = /** @type {any} */ (context);
  if (typeof options.stream === "string") return classifyStream(parseStreamJson(options.stream), ctx);

  const args = ["-p", PROBE_PROMPT];
  if (options.model !== undefined) args.push("--model", assertOpaqueValue("model", options.model));
  if (options.effort !== undefined) args.push("--effort", assertOpaqueValue("effort", options.effort));
  args.push("--output-format", "stream-json", "--verbose", "--no-session-persistence");

  const ran = /** @type {any} */ (await runIsolated(ctx, { prefix: "mi-claude", command: "claude", args, ...ROOT, stopWhen: initComplete, provenance: baseProvenance() }));
  if (ran.status !== "ok") return ran;
  const outcome = ran.evidence;
  if (outcome.truncated) {
    return makeAdapterResult({ status: "unknown", provenance: baseProvenance(), observedAt: ctx.now(), diagnostic: { code: "malformed_output", message: "the output exceeded the size limit before system/init arrived" } });
  }
  return classifyStream(parseStreamJson(outcome.stdout), ctx, firstLine(outcome.stderr || outcome.stdout));
}

/** Text Claude prints when its own catalog does not describe a model. */
const CATALOG_MISS_RE = /isn't described by this version's model catalog|unrecognized_model/;

/** Text that proves the run got past model and effort handling and stopped at authentication. */
const REACHED_AUTH_RE = /Not logged in|Please run \/login/i;

/** Claude's warning about an unknown effort. */
const EFFORT_WARNING_RE = /Unknown --effort value/;

/** The list of valid values that Claude appends to that warning, when it does. */
const VALID_VALUES_RE = /Valid values:\s*(.*?)\.?\s*$/;

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {string | undefined}
 */
function lineMatching(text, pattern) {
  return text.split("\n").find((line) => pattern.test(line));
}

/**
 * Ask Claude Code whether it recognises a model and an effort, without running a turn.
 *
 * One probe runs in a scratch home with no credential. A recognised model gets past model handling and
 * stops at `Not logged in`, so it cannot bill; the runtime's own warnings answer for the rest. The verdict
 * is `recognized` or `unrecognized`, never "available": recognising a model is not proof an account can
 * invoke it (ARCH-14).
 * @param {{model?: string, effort?: string}} input
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function validate(input, context) {
  if (!isPlainObject(input) || (/** @type {any} */ (input).model === undefined && /** @type {any} */ (input).effort === undefined)) {
    throw new TypeError("claude validate: input must name a model or an effort");
  }
  const { model, effort } = /** @type {any} */ (input);
  const args = ["-p", PROBE_PROMPT];
  if (model !== undefined) args.push("--model", assertOpaqueValue("model", model));
  if (effort !== undefined) args.push("--effort", assertOpaqueValue("effort", effort));
  args.push("--no-session-persistence");

  const ctx = resolveContext(context, ROOT);
  const provenance = baseProvenance();
  const ran = /** @type {any} */ (await runIsolated(ctx, { prefix: "mi-claude", command: "claude", args, ...ROOT, provenance }));
  if (ran.status !== "ok") return ran;
  const text = `${ran.evidence.stderr}\n${ran.evidence.stdout}`;
  const progressed = REACHED_AUTH_RE.test(text);

  /** @type {object[]} */
  const checks = [];
  if (model !== undefined) {
    const missLine = lineMatching(text, CATALOG_MISS_RE);
    checks.push({
      axis: "model",
      value: model,
      verdict: missLine !== undefined ? "unrecognized" : progressed ? "recognized" : "unverifiable",
      scope: "value",
      ...(missLine === undefined ? {} : { runtimeText: missLine }),
    });
  }
  if (effort !== undefined) {
    // The warning is what marks the effort unrecognised. The list of valid values is a bonus on it, so a
    // later Claude that words the warning without the list still gives the right verdict.
    const warningLine = lineMatching(text, EFFORT_WARNING_RE);
    const listed = warningLine === undefined ? null : VALID_VALUES_RE.exec(warningLine);
    const validValues = listed === null ? [] : listed[1].split(",").map((v) => v.trim()).filter((v) => v !== "");
    checks.push({
      axis: "reasoning",
      value: effort,
      verdict: warningLine !== undefined ? "unrecognized" : progressed ? "recognized" : "unverifiable",
      scope: "value",
      ...(warningLine === undefined ? {} : { runtimeText: warningLine, ...(validValues.length > 0 ? { validValues } : {}) }),
    });
  }
  const version = await probeVersion(ctx, { prefix: "mi-claude", command: "claude", ...ROOT, provenance });
  return makeAdapterResult({
    status: "ok",
    evidence: makeValidationEvidence({ checks, ...(version === undefined ? {} : { runtimeVersion: version }) }),
    provenance: { ...provenance, ...(version === undefined ? {} : { sourceVersion: version }) },
    observedAt: ctx.now(),
  });
}

/**
 * Render a resolved configuration as structured Claude Code arguments (ARCH-47).
 *
 * The model becomes `--model` and the reasoning axis becomes `--effort`. Any other axis is named in
 * `unsupportedAxes` rather than dropped (ARCH-49). Nothing is executed and no shell string is built.
 * @param {{runtimeId: string, axes: Record<string, unknown>}} resolvedConfig
 * @returns {Readonly<import("../evidence.mjs").Invocation>}
 */
export function renderInvocation(resolvedConfig) {
  if (!isPlainObject(resolvedConfig) || /** @type {any} */ (resolvedConfig).runtimeId !== RUNTIME_ID || !isPlainObject(/** @type {any} */ (resolvedConfig).axes)) {
    throw new TypeError("claude renderInvocation: the configuration is not a resolved claude configuration");
  }
  const axes = /** @type {Record<string, unknown>} */ (/** @type {any} */ (resolvedConfig).axes);
  const args = [];
  if (axes.model !== undefined) args.push("--model", assertOpaqueValue("model", axes.model));
  if (axes.reasoning !== undefined) args.push("--effort", assertOpaqueValue("reasoning", axes.reasoning));
  const unsupportedAxes = Object.keys(axes).filter((name) => name !== "model" && name !== "reasoning").sort();
  return makeInvocation({ runtimeId: RUNTIME_ID, command: "claude", args, unsupportedAxes });
}
