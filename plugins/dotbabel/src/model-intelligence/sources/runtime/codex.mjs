/**
 * model-intelligence/sources/runtime/codex — the Codex source adapter (P-7)
 * (docs/specs/model-intelligence, ARCH-1, ARCH-2, ARCH-17, ARCH-28, SEC-1).
 *
 * Codex has the best discovery surface of the six runtimes (DOC-2), and every part of it that matters
 * here was re-measured on 0.155.1 while this was written:
 *
 * - **`codex debug models`** prints the model catalog as JSON. It is offline, deterministic and needs no
 *   credential. The catalog held 9 models, not the 11 DOC-2 recorded one version earlier, which is the
 *   version drift the spec warns to expect. It carries no provider field, so none is ever invented.
 * - **The `exec` banner** names the resolved model, provider and effort, before any network attempt. It
 *   goes to stderr, and `exec` then never exits when the network is unreachable: it retries forever. The
 *   adapter therefore stops the child as soon as the banner is complete, instead of waiting for it.
 * - **`--strict-config`** rejects an unknown configuration key before authentication. It proves a KEY is
 *   recognised and nothing about its value: Codex accepts any string for `model` and
 *   `model_reasoning_effort` (DOC-2, constraint 12), so the evidence says `scope: "key"`.
 * - **`codex exec` writes 4.2 MB** (rollout files, sqlite databases, shell snapshots) into its
 *   configuration root, so it is only ever run in a scratch home (SEC-1; see `process.mjs`). To let the
 *   banner reflect the user's own settings, the four model keys are copied from the top of their
 *   `config.toml` into the scratch config. The rest of that file (plugins, connectors, project paths) and
 *   `auth.json` are never read into the scratch home.
 *
 * Provider is a field the runtime reports, never something derived from the model. The extractor in
 * `handoff-extract.sh` stored the provider in the model field; here they are separate throughout (ARCH-2).
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { assertDescriptor, makeAdapterResult } from "../contract.mjs";
import { deepFreeze, makeDiscoveryEvidence, makeInvocation, makeModelFact, makeObservedConfiguration, makeValidationEvidence, optionalCount, optionalIdentifier } from "../evidence.mjs";
import { assertOpaqueValue, firstLine, parseVersion, probeVersion, resolveContext, runIsolated } from "./process.mjs";

/** The `RUNTIMES` id this adapter serves, and the `sourceId` of every result it returns. */
export const RUNTIME_ID = "codex";

/** Stamped into provenance as `adapterVersion`. Bump it when the adapter's behavior or evidence shape changes. */
export const ADAPTER_VERSION = "1";

/** The runtime's configuration-root variable and default directory name. */
const ROOT = Object.freeze({ rootEnvVar: "CODEX_HOME", rootDirName: ".codex" });

/** A prompt is required by `exec`, but nothing is sent: there is no credential and no route. */
const PROBE_PROMPT = "x";

const OPERATION_READ_ONLY = { support: "supported", network: "never", auth: "none", cacheable: false, execution: "read-only" };

/**
 * The adapter's declared capabilities.
 *
 * Observation and validation run in a scratch home with no credential and no route to the network, so
 * they cannot start a model turn and are read-only in fact. Skill binding is unverified: RQ-4 leaves it
 * open, and unverified is never coerced to supported.
 */
export const descriptor = deepFreeze(
  assertDescriptor({
    id: RUNTIME_ID,
    kind: "runtime",
    capabilities: {
      discovery: { support: "supported", network: "never", auth: "none", cacheable: true, execution: "read-only" },
      observation: { ...OPERATION_READ_ONLY },
      binding: {
        skill: { support: "unverified", axes: { model: "unverified", reasoning: "unverified" } },
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
 * Build a model fact from one catalog entry, or `undefined` when the entry cannot be used.
 * @param {unknown} entry
 * @returns {ReturnType<typeof makeModelFact> | undefined}
 */
function factFromEntry(entry) {
  if (!isPlainObject(entry)) return undefined;
  const e = /** @type {Record<string, unknown>} */ (entry);
  const id = optionalIdentifier(e.slug);
  if (id === undefined) return undefined;
  const levels = Array.isArray(e.supported_reasoning_levels)
    ? e.supported_reasoning_levels.flatMap((level) => {
        const effort = isPlainObject(level) ? optionalIdentifier(/** @type {any} */ (level).effort) : undefined;
        if (effort === undefined) return [];
        const description = /** @type {any} */ (level).description;
        return [{ effort, ...(typeof description === "string" ? { description } : {}) }];
      })
    : [];
  /** @type {Record<string, unknown>} */
  const fields = { id, supportedReasoningLevels: levels };
  for (const [target, read, source] of [
    ["displayName", optionalIdentifier, e.display_name],
    ["visibility", optionalIdentifier, e.visibility],
    ["defaultReasoningLevel", optionalIdentifier, e.default_reasoning_level],
    ["contextWindow", optionalCount, e.context_window],
    ["maxContextWindow", optionalCount, e.max_context_window],
    ["defaultVerbosity", optionalIdentifier, e.default_verbosity],
  ]) {
    const value = /** @type {(v: unknown) => unknown} */ (read)(source);
    if (value !== undefined) fields[/** @type {string} */ (target)] = value;
  }
  if (typeof e.support_verbosity === "boolean") fields.supportVerbosity = e.support_verbosity;
  return makeModelFact(fields);
}

/**
 * Parse `codex debug models`.
 *
 * An entry that cannot be used is counted, not hidden and not fatal. A zero exit code with an empty or
 * unusable catalog is a problem to report, never an empty success: that is the OpenCode lesson (ARCH-30).
 * @param {unknown} text
 * @returns {{models: ReturnType<typeof makeModelFact>[], skipped: number, problem?: "empty_output" | "malformed_output"}}
 */
export function parseDebugModels(text) {
  const raw = String(text ?? "");
  if (raw.trim() === "") return { models: [], skipped: 0, problem: "empty_output" };
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch {
    return { models: [], skipped: 0, problem: "malformed_output" };
  }
  if (!isPlainObject(catalog) || !Array.isArray(/** @type {any} */ (catalog).models)) return { models: [], skipped: 0, problem: "malformed_output" };
  const models = [];
  let skipped = 0;
  for (const entry of /** @type {any} */ (catalog).models) {
    const fact = factFromEntry(entry);
    if (fact === undefined) skipped += 1;
    else models.push(fact);
  }
  if (models.length === 0) return { models, skipped, problem: skipped > 0 ? "malformed_output" : "empty_output" };
  return { models, skipped };
}

/**
 * Parse the banner `codex exec` prints to stderr before it does anything else.
 *
 * The fields sit between the first two separator lines. Text after the banner, such as the reconnect
 * errors when the network is unreachable, is ignored. Each field is kept under its own name, so the
 * provider can never be read from the model line or the other way round.
 * @param {unknown} text
 * @returns {{version?: string, fields: Record<string, string>, complete: boolean}}
 */
export function parseExecBanner(text) {
  const lines = String(text ?? "").split("\n");
  const version = parseVersion(lines.find((l) => /^OpenAI Codex v/.test(l)));
  /** @type {Record<string, string>} */
  const fields = {};
  let separators = 0;
  for (const line of lines) {
    if (/^-{8}$/.test(line.trim())) {
      separators += 1;
      if (separators === 2) break;
      continue;
    }
    if (separators !== 1) continue;
    const match = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/.exec(line);
    if (match !== null) fields[match[1]] = match[2].trim();
  }
  return { ...(version === undefined ? {} : { version }), fields, complete: separators >= 2 };
}

/**
 * True once the banner is complete: its second separator has arrived on stderr, where Codex prints it.
 * @param {{stderr: string}} streams
 * @returns {boolean}
 */
function bannerComplete({ stderr }) {
  return (stderr.match(/^-{8}$/gm) ?? []).length >= 2;
}

/** The four configuration keys a banner depends on, and the order they are written in. */
const MODEL_KEYS = Object.freeze(["model", "model_provider", "model_reasoning_effort", "model_verbosity"]);

/**
 * Read the four model keys from the TOP of a `config.toml`, before its first table.
 *
 * A hand parse of `key = "value"` lines is enough because only those four scalar keys are wanted, and it
 * keeps the rest of the file, which holds plugins, connectors and project paths, out of the scratch home.
 * A value that is not a plain string, or that could be read as a flag, or that holds a control character,
 * is skipped rather than passed on.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function readModelKeys(text) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    const match = /^([a-z_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(trimmed);
    if (match === null || !MODEL_KEYS.includes(match[1])) continue;
    let value;
    try {
      value = match[2].startsWith("'") ? match[2].slice(1, -1) : JSON.parse(match[2]);
    } catch {
      continue;
    }
    try {
      found[match[1]] = assertOpaqueValue(match[1], value);
    } catch {
      // Not safe to pass on, so it is left out.
    }
  }
  return found;
}

/**
 * Write a scratch config holding only the user's model keys. With none, no file is written.
 * @param {import("./process.mjs").RuntimeContext} ctx
 * @param {{runtimeRoot: string}} paths
 * @returns {Promise<void>}
 */
async function seedScratchConfig(ctx, { runtimeRoot }) {
  let text;
  try {
    text = await ctx.readFile(join(ctx.realRoot, "config.toml"), "utf8");
  } catch {
    return;
  }
  const keys = readModelKeys(text);
  const body = MODEL_KEYS.filter((k) => keys[k] !== undefined).map((k) => `${k} = ${JSON.stringify(keys[k])}\n`).join("");
  if (body !== "") await writeFile(join(runtimeRoot, "config.toml"), body);
}

/**
 * Discover the models Codex knows, from its bundled offline catalog.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function discover(context) {
  const ctx = resolveContext(context, ROOT);
  const provenance = baseProvenance();
  const ran = /** @type {any} */ (await runIsolated(ctx, { prefix: "mi-codex", command: "codex", args: ["debug", "models"], ...ROOT, provenance }));
  if (ran.status !== "ok") return ran;
  const outcome = ran.evidence;
  const unknown = (code, message) => makeAdapterResult({ status: "unknown", provenance, observedAt: ctx.now(), diagnostic: { code, message } });

  if (outcome.exitCode !== 0 && !outcome.stoppedEarly) {
    return makeAdapterResult({ status: "unavailable", provenance, observedAt: ctx.now(), diagnostic: { code: "nonzero_exit", message: firstLine(outcome.stderr) || `codex debug models exited ${outcome.exitCode}`, retryable: true } });
  }
  if (outcome.truncated) return unknown("malformed_output", "the catalog exceeded the size limit and was cut off");
  const parsed = parseDebugModels(outcome.stdout);
  if (parsed.problem !== undefined) {
    return unknown(parsed.problem, parsed.problem === "empty_output" ? "the catalog held no models, so support cannot be determined" : "the catalog was not the JSON object with a models list that was expected");
  }
  const version = await probeVersion(ctx, { prefix: "mi-codex", command: "codex", ...ROOT, provenance });
  return makeAdapterResult({
    status: "ok",
    evidence: makeDiscoveryEvidence({ models: parsed.models, skipped: parsed.skipped }),
    provenance: { ...provenance, ...(version === undefined ? {} : { sourceVersion: version }) },
    observedAt: ctx.now(),
  });
}

/**
 * Observe the model, provider and effort Codex resolves, from its `exec` banner.
 *
 * The run happens in a scratch home holding only the user's model keys, with no credential and no route
 * to the network, and the child is stopped as soon as the banner is complete.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function observe(context) {
  const ctx = resolveContext(context, ROOT);
  const provenance = baseProvenance();
  const ran = /** @type {any} */ (
    await runIsolated(ctx, {
      prefix: "mi-codex",
      command: "codex",
      args: ["exec", "--skip-git-repo-check", PROBE_PROMPT],
      ...ROOT,
      stopWhen: bannerComplete,
      prepare: (paths) => seedScratchConfig(ctx, paths),
      provenance,
    })
  );
  if (ran.status !== "ok") return ran;
  const outcome = ran.evidence;
  const text = outcome.stderr.trim() !== "" ? outcome.stderr : outcome.stdout;
  const unknown = (code, message) => makeAdapterResult({ status: "unknown", provenance, observedAt: ctx.now(), diagnostic: { code, message } });
  if (text.trim() === "") return unknown("empty_output", "the runtime printed no banner, so the resolved model cannot be determined");

  const banner = parseExecBanner(text);
  const model = optionalIdentifier(banner.fields.model);
  if (model === undefined) return unknown("insufficient_evidence", `no banner naming a model: ${firstLine(text)}`);
  const provider = optionalIdentifier(banner.fields.provider);
  const effort = optionalIdentifier(banner.fields["reasoning effort"]);
  const observed = makeObservedConfiguration({
    runtimeId: RUNTIME_ID,
    turnExecuted: false,
    model,
    ...(provider === undefined ? {} : { provider }),
    ...(effort === undefined ? {} : { effort }),
    fieldSources: {
      model: "exec-banner:model",
      ...(provider === undefined ? {} : { provider: "exec-banner:provider" }),
      ...(effort === undefined ? {} : { effort: "exec-banner:reasoning effort" }),
    },
    ...(banner.version === undefined ? {} : { runtimeVersion: banner.version }),
  });
  return makeAdapterResult({
    status: "ok",
    evidence: observed,
    provenance: { ...provenance, ...(banner.version === undefined ? {} : { sourceVersion: banner.version }) },
    observedAt: ctx.now(),
  });
}

/** The configuration key each axis is written to. */
const AXIS_KEYS = Object.freeze({ model: "model", reasoning: "model_reasoning_effort" });

/**
 * A string as a TOML basic string. `JSON.stringify` escapes a quote and a backslash, so a value cannot
 * close the string and start a second option, and the value was already checked for control characters.
 * @param {string} value
 * @returns {string}
 */
const tomlString = (value) => JSON.stringify(value);

/**
 * True once a probe has an answer: the banner started, or the runtime named a config error or a flag it lacks.
 * @param {{stderr: string}} streams
 * @returns {boolean}
 */
function probeAnswered({ stderr }) {
  return stderr.includes("OpenAI Codex v") || /unknown configuration field/.test(stderr) || /unexpected argument/.test(stderr);
}

/**
 * Ask Codex whether it recognises the configuration KEYS for a model and a reasoning effort.
 *
 * `--strict-config` rejects an unknown key before authentication, so it proves a key is recognised. It
 * proves nothing about the value, which Codex accepts verbatim, and the evidence says `scope: "key"`. A
 * Codex too old to have the flag gets `unsupported` with `version_unsupported`.
 * @param {{model?: string, reasoning?: string}} input
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function validate(input, context) {
  const known = isPlainObject(input) ? Object.keys(AXIS_KEYS).filter((axis) => /** @type {any} */ (input)[axis] !== undefined) : [];
  if (known.length === 0) throw new TypeError("codex validate: input must name a model or a reasoning axis");
  const values = Object.fromEntries(known.map((axis) => [axis, assertOpaqueValue(axis, /** @type {any} */ (input)[axis])]));

  const ctx = resolveContext(context, ROOT);
  const provenance = baseProvenance();
  /** @type {object[]} */
  const checks = [];
  for (const axis of known) {
    const key = /** @type {Record<string, string>} */ (AXIS_KEYS)[axis];
    const args = ["exec", "--skip-git-repo-check", "--strict-config", "-c", `${key}=${tomlString(values[axis])}`, PROBE_PROMPT];
    const ran = /** @type {any} */ (await runIsolated(ctx, { prefix: "mi-codex", command: "codex", args, ...ROOT, stopWhen: probeAnswered, provenance }));
    if (ran.status !== "ok") return ran;
    const text = `${ran.evidence.stderr}\n${ran.evidence.stdout}`;
    if (/unexpected argument '--strict-config'/.test(text)) {
      return makeAdapterResult({
        status: "unsupported",
        provenance,
        observedAt: ctx.now(),
        diagnostic: { code: "version_unsupported", message: "this Codex version has no --strict-config flag, so configuration keys cannot be checked" },
      });
    }
    const miss = text.split("\n").find((line) => /unknown configuration field/.test(line));
    checks.push({
      axis,
      value: values[axis],
      verdict: miss !== undefined ? "unrecognized" : text.includes("OpenAI Codex v") ? "recognized" : "unverifiable",
      scope: "key",
      ...(miss === undefined ? {} : { runtimeText: miss }),
    });
  }
  const version = await probeVersion(ctx, { prefix: "mi-codex", command: "codex", ...ROOT, provenance });
  return makeAdapterResult({
    status: "ok",
    evidence: makeValidationEvidence({ checks, ...(version === undefined ? {} : { runtimeVersion: version }) }),
    provenance: { ...provenance, ...(version === undefined ? {} : { sourceVersion: version }) },
    observedAt: ctx.now(),
  });
}

/**
 * Render a resolved configuration as structured Codex arguments (ARCH-47).
 *
 * The model becomes `--model` and the reasoning axis becomes a `-c` override whose value is a TOML
 * string. Any other axis is named in `unsupportedAxes` rather than dropped (ARCH-49). Nothing is
 * executed and no shell string is built.
 * @param {{runtimeId: string, axes: Record<string, unknown>}} resolvedConfig
 * @returns {Readonly<import("../evidence.mjs").Invocation>}
 */
export function renderInvocation(resolvedConfig) {
  if (!isPlainObject(resolvedConfig) || /** @type {any} */ (resolvedConfig).runtimeId !== RUNTIME_ID || !isPlainObject(/** @type {any} */ (resolvedConfig).axes)) {
    throw new TypeError("codex renderInvocation: the configuration is not a resolved codex configuration");
  }
  const axes = /** @type {Record<string, unknown>} */ (/** @type {any} */ (resolvedConfig).axes);
  const args = [];
  if (axes.model !== undefined) args.push("--model", assertOpaqueValue("model", axes.model));
  if (axes.reasoning !== undefined) args.push("-c", `model_reasoning_effort=${tomlString(assertOpaqueValue("reasoning", axes.reasoning))}`);
  const unsupportedAxes = Object.keys(axes).filter((name) => name !== "model" && name !== "reasoning").sort();
  return makeInvocation({ runtimeId: RUNTIME_ID, command: "codex", args, unsupportedAxes });
}
