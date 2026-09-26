/**
 * model-intelligence/sources/evidence — the evidence shapes a source adapter returns
 * (docs/specs/model-intelligence, §5 `Source Adapter Contract`, ARCH-13, ARCH-14, ARCH-17,
 * ARCH-28, ARCH-47, ARCH-49).
 *
 * §5 names `ObservedEffectiveConfiguration`, `DiscoveryEvidence`, `ValidationEvidence` and an
 * invocation result, but defines none of their fields. The first two adapters define them here, so
 * P-8 (catalog) and P-10 (resolver) consume one shape instead of one per runtime.
 *
 * Four rules run through every constructor:
 *
 * - **Opaque and separate.** Each configuration value sits under its own runtime-owned axis name, and
 *   the provider is a separate field. Every value is an opaque string taken from a named surface of the
 *   runtime. None is parsed for meaning and none is derived from another (ARCH-1, ARCH-2, ARCH-17).
 *   Handoff's extractor once stored the provider in the model field; nothing here can.
 * - **Absent is not empty.** An optional field exists only when the runtime reported it, so a caller
 *   can tell "not reported" from "reported as nothing".
 * - **Recognised is not available.** Validation says what a runtime recognises, never what an
 *   account may invoke (ARCH-14). There is no availability field to misread.
 * - **Closed.** An unknown field is an error, so no identifier or credential can ride along by accident
 *   (OPS-4).
 *
 * OPS-4 masking boundary: only free runtime text -- `ValidationEvidence check.runtimeText` and a
 * reasoning level's `description` -- passes through `boundText`. A model id, provider, effort and
 * `ModelFact` field go through `identifier()`, which bounds length and rejects control characters but
 * does not mask. These are the surfaces `contract.mjs` names as safe to carry unmasked (the runtime
 * id, its version, the evidence kind, timestamps, and model identifiers); a runtime that puts a
 * credential-shaped string where an identifier is expected is not caught here.
 *
 * The module is pure: it validates data it is given and performs no I/O.
 */

import { RUNTIME_IDS, isRuntimeId } from "../domain/index.mjs";
import { boundText, isVersionString } from "./contract.mjs";

/** What a runtime can say about one value. Never `available`: see the module header. */
export const VERDICTS = Object.freeze(["recognized", "unrecognized", "unverifiable"]);

/** Whether the runtime checked a configuration KEY or the VALUE given for it. */
export const VERDICT_SCOPES = Object.freeze(["key", "value"]);

/** Longest identifier, provider or label accepted. Runtime identifiers are short; a long one is noise or an attack. */
const MAX_IDENTIFIER = 200;

/**
 * Freeze a value and everything reachable from it.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(/** @type {any} */ (value)[key]);
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Require an object and reject every key that is not listed.
 * @param {string} shape
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @returns {Record<string, unknown>}
 */
function knownFields(shape, value, allowed) {
  if (!isPlainObject(value)) throw new TypeError(`${shape} must be an object`);
  for (const key of Object.keys(/** @type {object} */ (value))) {
    if (!allowed.includes(key)) throw new TypeError(`${shape}: unknown field "${key}"`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * A short, printable string, or `undefined` when the value is anything else.
 *
 * The lenient form, for an adapter reading a runtime's output: a field of the wrong shape is
 * dropped instead of invented or fatal.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function optionalIdentifier(value) {
  return typeof value === "string" && value !== "" && value.length <= MAX_IDENTIFIER && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : undefined;
}

/**
 * A finite, non-negative number, or `undefined` when the value is anything else.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function optionalCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Require a short, printable string.
 * @param {string} name
 * @param {unknown} value
 * @returns {string}
 */
function identifier(name, value) {
  const checked = optionalIdentifier(value);
  if (checked === undefined) throw new TypeError(`${name} must be a non-empty printable string of at most ${MAX_IDENTIFIER} characters`);
  return checked;
}

/**
 * Require a finite, non-negative number.
 * @param {string} name
 * @param {unknown} value
 * @returns {number}
 */
function count(name, value) {
  const checked = optionalCount(value);
  if (checked === undefined) throw new TypeError(`${name} must be a finite non-negative number`);
  return checked;
}

/**
 * Copy `keys` from `source` into `target`, validating each one that is present.
 * @param {Record<string, unknown>} target
 * @param {Record<string, unknown>} source
 * @param {string} shape
 * @param {Record<string, (name: string, value: unknown) => unknown>} checks
 * @returns {void}
 */
function copyOptional(target, source, shape, checks) {
  for (const [key, check] of Object.entries(checks)) {
    if (source[key] !== undefined) target[key] = check(`${shape}.${key}`, source[key]);
  }
}

const USAGE_FIELDS = Object.freeze(["model", "canonicalModel", "provider", "contextWindow", "maxOutputTokens", "thinkingTokens"]);

/**
 * @param {unknown} entry
 * @returns {Readonly<Record<string, unknown>>}
 */
function usageEntry(entry) {
  const fields = knownFields("ObservedEffectiveConfiguration.usage entry", entry, USAGE_FIELDS);
  /** @type {Record<string, unknown>} */
  const out = { model: identifier("ObservedEffectiveConfiguration.usage.model", fields.model) };
  copyOptional(out, fields, "ObservedEffectiveConfiguration.usage", {
    canonicalModel: identifier,
    provider: identifier,
    contextWindow: count,
    maxOutputTokens: count,
    thinkingTokens: count,
  });
  return Object.freeze(out);
}

const OBSERVED_FIELDS = Object.freeze(["runtimeId", "turnExecuted", "axes", "provider", "usage", "fieldSources", "runtimeVersion"]);

/**
 * An axis name: a plain identifier. The set of names is open (§5 `Configuration axes`), but each
 * name is a short word, so it can never be `__proto__`, a path, or free text.
 */
const AXIS_NAME_RE = /^[a-z][A-Za-z0-9]{0,63}$/;

/**
 * @typedef {object} ObservedEffectiveConfiguration
 * @property {string} runtimeId A `RUNTIMES` id.
 * @property {boolean} turnExecuted Whether a model turn ran to produce this. Absence of usage means no turn, not zero usage.
 * @property {Readonly<Record<string, string>>} axes Each configuration value the runtime reported, under the runtime-owned axis name the adapter uses (`model`, `reasoning`, a fused `selector`, ...). Opaque, and present only when reported; the map itself is always present.
 * @property {string} [provider] Opaque, and only when the runtime reported one. Never derived from the model.
 * @property {ReadonlyArray<{model: string, canonicalModel?: string, provider?: string, contextWindow?: number, maxOutputTokens?: number, thinkingTokens?: number}>} usage Per-model usage, empty when no turn ran.
 * @property {Readonly<Record<string, string>>} fieldSources For each reported value, keyed `axes.<name>` or `provider`, the surface of the runtime that supplied it (ARCH-28).
 * @property {string} [runtimeVersion]
 */

/**
 * @param {unknown} axes
 * @returns {Readonly<Record<string, string>>}
 */
function observedAxes(axes) {
  if (axes === undefined) return Object.freeze({});
  if (!isPlainObject(axes)) throw new TypeError("ObservedEffectiveConfiguration.axes must be an object");
  return Object.freeze(
    Object.fromEntries(
      Object.entries(/** @type {object} */ (axes)).map(([name, value]) => {
        if (!AXIS_NAME_RE.test(name)) throw new TypeError(`ObservedEffectiveConfiguration: axis name ${JSON.stringify(name.slice(0, 70))} must be a plain identifier`);
        return [name, identifier(`ObservedEffectiveConfiguration.axes.${name}`, value)];
      }),
    ),
  );
}

/**
 * Build the configuration a runtime reports as currently in effect.
 *
 * Only the provider is a named field. Every configurable value sits in `axes` under the name the
 * runtime adapter contract gives it, because §5 makes axis names runtime-owned: a runtime whose
 * selector fuses model and effort reports one `selector` axis, not a synthetic `model` plus `reasoning`.
 * @param {object} input
 * @returns {Readonly<ObservedEffectiveConfiguration>}
 */
export function makeObservedConfiguration(input) {
  const fields = knownFields("ObservedEffectiveConfiguration", input, OBSERVED_FIELDS);
  if (!isRuntimeId(fields.runtimeId)) throw new TypeError(`ObservedEffectiveConfiguration.runtimeId must be one of ${RUNTIME_IDS.join(", ")}`);
  if (typeof fields.turnExecuted !== "boolean") throw new TypeError("ObservedEffectiveConfiguration.turnExecuted must be a boolean");
  /** @type {Record<string, unknown>} */
  const out = { runtimeId: fields.runtimeId, turnExecuted: fields.turnExecuted, axes: observedAxes(fields.axes) };
  copyOptional(out, fields, "ObservedEffectiveConfiguration", { provider: identifier });
  if (fields.usage !== undefined && !Array.isArray(fields.usage)) throw new TypeError("ObservedEffectiveConfiguration.usage must be an array");
  out.usage = Object.freeze((/** @type {unknown[]} */ (fields.usage) ?? []).map(usageEntry));

  // Every reported value needs a source (ARCH-28), and every source must describe a reported value.
  const reported = [...Object.keys(/** @type {object} */ (out.axes)).map((name) => `axes.${name}`), ...(out.provider === undefined ? [] : ["provider"])];
  const given = fields.fieldSources ?? {};
  if (!isPlainObject(given)) throw new TypeError("ObservedEffectiveConfiguration.fieldSources must be an object");
  for (const key of reported) {
    if (/** @type {any} */ (given)[key] === undefined) {
      throw new TypeError(`ObservedEffectiveConfiguration.fieldSources[${JSON.stringify(key)}] is required when ${key} is reported`);
    }
  }
  for (const key of Object.keys(/** @type {object} */ (given))) {
    if (!reported.includes(key)) throw new TypeError(`ObservedEffectiveConfiguration.fieldSources[${JSON.stringify(key)}] names a field that was not reported`);
  }
  out.fieldSources = Object.freeze(Object.fromEntries(reported.map((k) => [k, identifier(`ObservedEffectiveConfiguration.fieldSources[${JSON.stringify(k)}]`, /** @type {any} */ (given)[k])])));
  if (fields.runtimeVersion !== undefined) {
    if (!isVersionString(fields.runtimeVersion)) throw new TypeError("ObservedEffectiveConfiguration.runtimeVersion must be a version string");
    out.runtimeVersion = fields.runtimeVersion;
  }
  return /** @type {any} */ (Object.freeze(out));
}

const LEVEL_FIELDS = Object.freeze(["effort", "description"]);
const MODEL_FACT_FIELDS = Object.freeze(["id", "displayName", "visibility", "defaultReasoningLevel", "supportedReasoningLevels", "contextWindow", "maxContextWindow", "supportVerbosity", "defaultVerbosity"]);

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {boolean}
 */
function flag(name, value) {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

/**
 * Every fact `makeModelFact` has returned. Freezing is not proof of provenance, because anyone can
 * freeze a forged object, so `makeDiscoveryEvidence` checks membership here instead.
 * @type {WeakSet<object>}
 */
const BUILT_FACTS = new WeakSet();

/**
 * @param {unknown} level
 * @returns {Readonly<{effort: string, description?: string}>}
 */
function reasoningLevel(level) {
  const fields = knownFields("ModelFact.supportedReasoningLevels entry", level, LEVEL_FIELDS);
  /** @type {Record<string, unknown>} */
  const out = { effort: identifier("ModelFact.supportedReasoningLevels.effort", fields.effort) };
  if (fields.description !== undefined) out.description = boundText(fields.description);
  return /** @type {any} */ (Object.freeze(out));
}

/**
 * @typedef {object} ModelFact
 * @property {string} id Opaque model identifier, verbatim.
 * @property {string} [displayName]
 * @property {string} [visibility]
 * @property {string} [defaultReasoningLevel]
 * @property {ReadonlyArray<{effort: string, description?: string}>} supportedReasoningLevels Effort values THIS model accepts. Effort support is per model, never per runtime (ARCH-1).
 * @property {number} [contextWindow]
 * @property {number} [maxContextWindow]
 * @property {boolean} [supportVerbosity]
 * @property {string} [defaultVerbosity]
 */

/**
 * Build one model's facts. There is no provider field: a runtime's model catalog carries none, and
 * deriving one from the id would be exactly the inference ARCH-2 and ARCH-17 forbid.
 * @param {object} input
 * @returns {Readonly<ModelFact>}
 */
export function makeModelFact(input) {
  const fields = knownFields("ModelFact", input, MODEL_FACT_FIELDS);
  /** @type {Record<string, unknown>} */
  const out = { id: identifier("ModelFact.id", fields.id) };
  copyOptional(out, fields, "ModelFact", {
    displayName: identifier,
    visibility: identifier,
    defaultReasoningLevel: identifier,
    contextWindow: count,
    maxContextWindow: count,
    supportVerbosity: flag,
    defaultVerbosity: identifier,
  });
  if (!Array.isArray(fields.supportedReasoningLevels)) throw new TypeError("ModelFact.supportedReasoningLevels must be an array");
  out.supportedReasoningLevels = Object.freeze(fields.supportedReasoningLevels.map(reasoningLevel));
  const fact = /** @type {any} */ (Object.freeze(out));
  BUILT_FACTS.add(fact);
  return fact;
}

/**
 * Which models accept each effort value that any of them accepts.
 * @param {ReadonlyArray<ModelFact>} models
 * @returns {Readonly<Record<string, Readonly<{supportedBy: string[], notSupportedBy: string[]}>>>}
 */
function effortSupport(models) {
  const efforts = [...new Set(models.flatMap((m) => m.supportedReasoningLevels.map((l) => l.effort)))];
  return Object.freeze(
    Object.fromEntries(
      efforts.map((effort) => {
        const supportedBy = models.filter((m) => m.supportedReasoningLevels.some((l) => l.effort === effort)).map((m) => m.id);
        const notSupportedBy = models.filter((m) => !supportedBy.includes(m.id)).map((m) => m.id);
        return [effort, Object.freeze({ supportedBy: Object.freeze(supportedBy), notSupportedBy: Object.freeze(notSupportedBy) })];
      }),
    ),
  );
}

/**
 * @typedef {object} DiscoveryEvidence
 * @property {ReadonlyArray<ModelFact>} models
 * @property {Readonly<Record<string, {supportedBy: string[], notSupportedBy: string[]}>>} effortSupport For each effort any model accepts, the models that do and do not. It lets a requirement for an effort be refused for the models that lack it.
 * @property {number} skipped Catalog entries that could not be used, counted instead of hidden.
 */

/**
 * Build what a runtime's discovery surface reported.
 * @param {object} input
 * @param {ReadonlyArray<ModelFact>} input.models Each already built by `makeModelFact`.
 * @param {number} [input.skipped]
 * @returns {Readonly<DiscoveryEvidence>}
 */
export function makeDiscoveryEvidence(input) {
  const fields = knownFields("DiscoveryEvidence", input, ["models", "skipped"]);
  if (!Array.isArray(fields.models)) throw new TypeError("DiscoveryEvidence.models must be an array");
  const models = fields.models.map((model) => {
    // A raw object could carry an unchecked field, so only a fact `makeModelFact` built is accepted.
    if (typeof model !== "object" || model === null || !BUILT_FACTS.has(model)) {
      throw new TypeError("DiscoveryEvidence.models must contain built model facts");
    }
    return model;
  });
  const skipped = fields.skipped === undefined ? 0 : count("DiscoveryEvidence.skipped", fields.skipped);
  return Object.freeze({ models: Object.freeze(models), effortSupport: effortSupport(models), skipped });
}

const CHECK_FIELDS = Object.freeze(["axis", "value", "verdict", "scope", "runtimeText", "validValues"]);

/**
 * @param {unknown} check
 * @returns {Readonly<Record<string, unknown>>}
 */
function validationCheck(check) {
  const fields = knownFields("ValidationEvidence check", check, CHECK_FIELDS);
  if (!VERDICTS.includes(/** @type {any} */ (fields.verdict))) throw new TypeError(`ValidationEvidence check.verdict must be one of ${VERDICTS.join(", ")}`);
  if (!VERDICT_SCOPES.includes(/** @type {any} */ (fields.scope))) throw new TypeError(`ValidationEvidence check.scope must be one of ${VERDICT_SCOPES.join(", ")}`);
  /** @type {Record<string, unknown>} */
  const out = {
    axis: identifier("ValidationEvidence check.axis", fields.axis),
    value: identifier("ValidationEvidence check.value", fields.value),
    verdict: fields.verdict,
    scope: fields.scope,
  };
  if (fields.runtimeText !== undefined) {
    if (typeof fields.runtimeText !== "string") throw new TypeError("ValidationEvidence check.runtimeText must be a string");
    // Runtime output is the text most likely to echo a credential, so it is masked and bounded here.
    out.runtimeText = boundText(fields.runtimeText);
  }
  if (fields.validValues !== undefined) {
    if (!Array.isArray(fields.validValues)) throw new TypeError("ValidationEvidence check.validValues must be an array");
    out.validValues = Object.freeze(fields.validValues.map((v) => identifier("ValidationEvidence check.validValues entry", v)));
  }
  return Object.freeze(out);
}

/**
 * @typedef {object} ValidationEvidence
 * @property {ReadonlyArray<{axis: string, value: string, verdict: "recognized"|"unrecognized"|"unverifiable", scope: "key"|"value", runtimeText?: string, validValues?: string[]}>} checks
 * @property {string} [runtimeVersion]
 */

/**
 * Build what a runtime recognised of a proposed configuration.
 *
 * `recognized` means the runtime got past its own handling of the value. It does not mean the value
 * exists for the account, and no field here can be read that way (ARCH-14).
 * @param {object} input
 * @returns {Readonly<ValidationEvidence>}
 */
export function makeValidationEvidence(input) {
  const fields = knownFields("ValidationEvidence", input, ["checks", "runtimeVersion"]);
  if (!Array.isArray(fields.checks)) throw new TypeError("ValidationEvidence.checks must be an array");
  /** @type {Record<string, unknown>} */
  const out = { checks: Object.freeze(fields.checks.map(validationCheck)) };
  if (fields.runtimeVersion !== undefined) {
    if (!isVersionString(fields.runtimeVersion)) throw new TypeError("ValidationEvidence.runtimeVersion must be a version string");
    out.runtimeVersion = fields.runtimeVersion;
  }
  return /** @type {any} */ (Object.freeze(out));
}

/**
 * @typedef {object} Invocation
 * @property {string} runtimeId
 * @property {string} command The program name only. It is data, and nothing here executes it (ARCH-47).
 * @property {ReadonlyArray<string>} args The arguments, one array element each, so no value is ever parsed by a shell.
 * @property {ReadonlyArray<string>} unsupportedAxes Axes of the configuration this runtime cannot express. Named, never dropped (ARCH-49).
 */

/**
 * Build the structured invocation for a runtime.
 * @param {object} input
 * @returns {Readonly<Invocation>}
 */
export function makeInvocation(input) {
  const fields = knownFields("Invocation", input, ["runtimeId", "command", "args", "unsupportedAxes"]);
  if (!isRuntimeId(fields.runtimeId)) throw new TypeError(`Invocation.runtimeId must be one of ${RUNTIME_IDS.join(", ")}`);
  const command = identifier("Invocation.command", fields.command);
  if (!Array.isArray(fields.args) || fields.args.some((a) => typeof a !== "string")) throw new TypeError("Invocation.args must be an array of strings");
  if (!Array.isArray(fields.unsupportedAxes) || fields.unsupportedAxes.some((a) => typeof a !== "string" || a === "")) {
    throw new TypeError("Invocation.unsupportedAxes must be an array of axis names");
  }
  return Object.freeze({
    runtimeId: fields.runtimeId,
    command,
    args: Object.freeze([...fields.args]),
    unsupportedAxes: Object.freeze([...fields.unsupportedAxes]),
  });
}
