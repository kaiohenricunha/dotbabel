/**
 * model-intelligence/sources/contract — the one descriptor envelope every runtime and
 * knowledge source implements, the `AdapterResult` helpers, and the registry
 * (docs/specs/model-intelligence, §5 `Source Adapter Contract`, ARCH-12, ARCH-25,
 * ARCH-50).
 *
 * The contract exists to keep three dimensions apart (§5 `Invariant`):
 *
 * 1. **Static support** — what Dotbabel has verified an adapter can do, in
 *    `supported` / `unsupported` / `unverified`.
 * 2. **Current operation outcome** — what happened on one call, in `ok` /
 *    `unsupported` / `unavailable` / `unknown`.
 * 3. **Freshness and refresh** — derived later by `catalog/`, never reported here.
 *
 * No consumer may collapse those into one boolean such as `available`, so this module
 * refuses a descriptor that carries an outcome field and refuses a result that
 * carries a freshness field. A missing binary is not a missing capability, and an
 * unverified capability is not an absent one.
 *
 * This module holds no adapter. It validates descriptors and builds results over
 * supplied data, and `runBounded` owns only the timer and the caller's own callback
 * (ARCH-56). It performs no subprocess, network or filesystem I/O of its own.
 */

import { SUPPORT_STATES, ADAPTER_RESULT_STATUSES, ARTIFACT_KINDS } from "../domain/index.mjs";

/**
 * Kinds of adapter a descriptor may declare.
 *
 * Narrower than `domain`'s `SOURCE_KINDS`, which also includes `artifact`: an
 * artifact's frontmatter is evidence about itself, but an artifact is not a source
 * adapter and can never implement discover, observe or validate. Reusing the wider
 * list would admit a descriptor nothing could satisfy.
 */
export const DESCRIPTOR_KINDS = Object.freeze(["runtime", "knowledge-source"]);

/** Whether an operation may use the network. Replaces a `requiresNetwork` boolean. */
export const NETWORK_MODES = Object.freeze(["never", "optional", "required"]);

/**
 * How an operation relates to existing credentials.
 *
 * Dotbabel may use a runtime's existing credentials without owning them (§2, `Does
 * Not Mutate`), which a boolean cannot express.
 */
export const AUTH_MODES = Object.freeze(["none", "optional-existing", "required-existing"]);

/**
 * Whether an operation is passive.
 *
 * Observation is not always free. An adapter whose only way to observe effective
 * state is to run a model turn declares `may-execute-model`, and callers must not
 * treat it like read-only discovery. Claude Code is the measured case (DOC-2,
 * "Discovery Suitability").
 */
export const EXECUTION_MODES = Object.freeze(["read-only", "may-execute-model"]);

/** Transport channels that carry a default timeout. */
export const TIMEOUT_CHANNELS = Object.freeze(["subprocess", "network"]);

/** REL-1: every source-adapter operation terminates. */
export const OPERATION_TIMEOUTS_MS = Object.freeze({ subprocess: 10_000, network: 20_000 });

/** The five capability blocks every descriptor declares (ARCH-50). */
const CAPABILITY_KEYS = Object.freeze(["discovery", "observation", "binding", "invocation", "validation"]);

/** Operation blocks, as opposed to `binding` and `invocation`. */
const OPERATION_KEYS = Object.freeze(["discovery", "observation", "validation"]);

/** Top-level descriptor keys. Anything else is a validation error. */
const DESCRIPTOR_KEYS = Object.freeze(["id", "kind", "version", "capabilities", "$comment"]);

/** Result keys. A freshness or availability field here collapses the dimensions. */
const RESULT_KEYS = Object.freeze(["status", "evidence", "provenance", "observedAt", "diagnostic"]);

/** Keys that must never be read from or written by name on a parsed document (CWE-1321). */
const UNSAFE_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

/** Longest diagnostic text that may leave an adapter. */
const DIAGNOSTIC_MAX_LENGTH = 1_024;

/**
 * True when `value` is a non-null, non-array object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Describe a value's type without echoing the value (OPS-4).
 * @param {unknown} value
 * @returns {string}
 */
function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Read one own key from a parsed table, or `undefined` when it is absent.
 *
 * A prototype name never counts as present: `table.__proto__` would otherwise resolve
 * to `Object.prototype` and answer for an entry no author wrote (CWE-1321).
 * @param {unknown} table
 * @param {string} key
 * @returns {any}
 */
function safeOwn(table, key) {
  return isPlainObject(table) && Object.hasOwn(/** @type {object} */ (table), key) && !UNSAFE_KEYS.includes(key) ? /** @type {any} */ (table)[key] : undefined;
}

/**
 * @typedef {object} DescriptorError
 * @property {string} path Dotted path to the offending field.
 * @property {string} message What is wrong with it.
 */

/**
 * Collect the own keys of a parsed object, including the unsafe ones.
 *
 * `Object.keys` already returns `__proto__` when `JSON.parse` produced it, so the
 * point here is that callers must never reach the value through `obj[key]`. Reading
 * `binding.__proto__` would resolve to `Object.prototype` and validate as an object
 * that no author wrote.
 * @param {object} obj
 * @returns {string[]}
 */
function ownKeys(obj) {
  return Object.keys(obj);
}

/**
 * Validate one operation capability block.
 * @param {unknown} block
 * @param {string} path
 * @param {DescriptorError[]} errors
 * @returns {void}
 */
function checkOperation(block, path, errors) {
  if (!isPlainObject(block)) {
    errors.push({ path, message: `must be an object, got ${typeOf(block)}` });
    return;
  }
  const operation = /** @type {any} */ (block);
  if (!SUPPORT_STATES.includes(operation.support)) {
    errors.push({ path: `${path}.support`, message: `must be one of ${SUPPORT_STATES.join(", ")}` });
  }
  // An operation declared `unsupported` may omit the operational axes: there is no
  // network, auth or execution story for something that does not happen, and
  // declaring them would be noise a reader could mistake for capability (§5
  // `Knowledge-source adapters`). Any other support state must declare all four.
  if (operation.support === "unsupported") return;

  const enums = [
    ["network", NETWORK_MODES],
    ["auth", AUTH_MODES],
    ["execution", EXECUTION_MODES],
  ];
  for (const [key, allowed] of enums) {
    if (!allowed.includes(operation[key])) {
      errors.push({ path: `${path}.${key}`, message: `must be one of ${allowed.join(", ")}` });
    }
  }
  if (typeof operation.cacheable !== "boolean") {
    errors.push({ path: `${path}.cacheable`, message: "must be a boolean" });
  }
}

/**
 * Validate a `{support, axes}` pair.
 *
 * An axis NAME is deliberately free-form. Axis identifiers belong to the runtime
 * adapter contract and are not a universal Dotbabel enum, so an Antigravity selector
 * that fuses model and effort stays one opaque axis rather than being split into
 * `model` and `reasoning` (§5 `Configuration axes`, ARCH-1, ARCH-17). Only the axis
 * VALUE is constrained.
 * @param {unknown} block
 * @param {string} path
 * @param {DescriptorError[]} errors
 * @returns {void}
 */
function checkSupportAndAxes(block, path, errors) {
  if (!isPlainObject(block)) {
    errors.push({ path, message: `must be an object, got ${typeOf(block)}` });
    return;
  }
  const { support, axes } = /** @type {any} */ (block);
  if (!SUPPORT_STATES.includes(support)) {
    errors.push({ path: `${path}.support`, message: `must be one of ${SUPPORT_STATES.join(", ")}` });
  }
  if (!isPlainObject(axes)) {
    errors.push({ path: `${path}.axes`, message: `must be an object, got ${typeOf(axes)}` });
    return;
  }
  for (const axis of ownKeys(axes)) {
    if (UNSAFE_KEYS.includes(axis)) {
      errors.push({ path: `${path}.axes.${axis}`, message: "must not be used as an axis name" });
      continue;
    }
    if (!SUPPORT_STATES.includes(axes[axis])) {
      errors.push({ path: `${path}.axes.${axis}`, message: `must be one of ${SUPPORT_STATES.join(", ")}` });
    }
  }
}

/**
 * Validate a source adapter descriptor, returning every problem found.
 *
 * Returns all errors rather than throwing on the first, because a descriptor is
 * usually authored or generated in one pass and a caller fixing it wants the whole
 * list.
 * @param {unknown} descriptor
 * @returns {{errors: DescriptorError[]}}
 */
export function validateDescriptor(descriptor) {
  /** @type {DescriptorError[]} */
  const errors = [];
  if (!isPlainObject(descriptor)) {
    return { errors: [{ path: "", message: `descriptor must be an object, got ${typeOf(descriptor)}` }] };
  }

  for (const key of ownKeys(descriptor)) {
    if (!DESCRIPTOR_KEYS.includes(key)) {
      // A descriptor carrying `status`, `availability` or `freshness` has collapsed
      // the three dimensions of §5 into one record, so it is rejected by name rather
      // than ignored.
      errors.push({ path: key, message: `unknown key; a descriptor declares static support only, not an outcome or a freshness state` });
    }
  }

  const { id, kind, capabilities } = /** @type {any} */ (descriptor);
  if (typeof id !== "string" || id === "") {
    errors.push({ path: "id", message: "must be a non-empty string" });
  }
  if (!DESCRIPTOR_KINDS.includes(kind)) {
    errors.push({ path: "kind", message: `must be one of ${DESCRIPTOR_KINDS.join(", ")}` });
  }

  if (!isPlainObject(capabilities)) {
    errors.push({ path: "capabilities", message: `must be an object, got ${typeOf(capabilities)}` });
    return { errors };
  }
  for (const key of CAPABILITY_KEYS) {
    if (!Object.hasOwn(capabilities, key)) {
      errors.push({ path: `capabilities.${key}`, message: "is required; support for one capability never implies support for another (ARCH-50)" });
    }
  }
  for (const key of ownKeys(capabilities)) {
    if (!CAPABILITY_KEYS.includes(key)) errors.push({ path: `capabilities.${key}`, message: "unknown capability" });
  }

  for (const key of OPERATION_KEYS) {
    if (Object.hasOwn(capabilities, key)) checkOperation(capabilities[key], `capabilities.${key}`, errors);
  }

  if (Object.hasOwn(capabilities, "binding")) {
    const binding = capabilities.binding;
    if (!isPlainObject(binding)) {
      errors.push({ path: "capabilities.binding", message: `must be an object, got ${typeOf(binding)}` });
    } else {
      // An empty table is valid and meaningful: a knowledge source binds nothing, and
      // says so explicitly rather than by omission (§5 `Knowledge-source adapters`).
      for (const artifactKind of ownKeys(binding)) {
        const at = `capabilities.binding.${artifactKind}`;
        if (UNSAFE_KEYS.includes(artifactKind)) {
          errors.push({ path: at, message: "must not be used as an artifact kind" });
          continue;
        }
        if (!ARTIFACT_KINDS.includes(artifactKind)) {
          errors.push({ path: at, message: `must be one of the canonical artifact kinds: ${ARTIFACT_KINDS.join(", ")}` });
          continue;
        }
        checkSupportAndAxes(binding[artifactKind], at, errors);
      }
    }
  }

  if (Object.hasOwn(capabilities, "invocation")) {
    checkSupportAndAxes(capabilities.invocation, "capabilities.invocation", errors);
  }

  return { errors };
}

/**
 * Validate a descriptor and throw on the first problem.
 * @param {unknown} descriptor
 * @returns {object} The descriptor, unchanged.
 */
export function assertDescriptor(descriptor) {
  const { errors } = validateDescriptor(descriptor);
  if (errors.length > 0) {
    const detail = errors.map((e) => `${e.path || "<root>"}: ${e.message}`).join("; ");
    throw new TypeError(`invalid source adapter descriptor: ${detail}`);
  }
  return /** @type {object} */ (descriptor);
}

/**
 * Build an `AdapterResult`.
 *
 * Provenance is required for every status, not only for success. A failure a caller
 * cannot attribute to a source is a failure it cannot cache against, retry against,
 * or explain, and `unavailable` is the status most likely to need attribution.
 * @param {object} input
 * @returns {object} A frozen result.
 */
export function makeAdapterResult(input) {
  if (!isPlainObject(input)) throw new TypeError(`adapter result must be an object, got ${typeOf(input)}`);
  for (const key of ownKeys(input)) {
    if (!RESULT_KEYS.includes(key)) {
      throw new TypeError(`adapter result: unknown key "${key}"; freshness and refresh are derived by catalog/, never reported by an adapter`);
    }
  }

  const { status, evidence, provenance, observedAt, diagnostic } = /** @type {any} */ (input);
  if (!ADAPTER_RESULT_STATUSES.includes(status)) {
    throw new TypeError(`adapter result: status must be one of ${ADAPTER_RESULT_STATUSES.join(", ")}`);
  }
  if (!isPlainObject(provenance)) throw new TypeError("adapter result: provenance is required for every status, including unavailable");
  if (typeof provenance.sourceId !== "string" || provenance.sourceId === "") {
    throw new TypeError("adapter result: provenance.sourceId must be a non-empty string");
  }
  if (!DESCRIPTOR_KINDS.includes(provenance.sourceKind)) {
    throw new TypeError(`adapter result: provenance.sourceKind must be one of ${DESCRIPTOR_KINDS.join(", ")}`);
  }
  // `ok` means usable evidence was produced, and any other status means it was not.
  // Allowing either half alone would let a caller read evidence off a failure or
  // treat an empty success as a real answer — the OpenCode exit-0 case (ARCH-30).
  if (status === "ok" && evidence === undefined) throw new TypeError("adapter result: status ok requires evidence");
  if (status !== "ok" && evidence !== undefined) throw new TypeError(`adapter result: status ${status} must carry no evidence`);

  /** @type {Record<string, unknown>} */
  const result = { status, provenance: Object.freeze({ ...provenance }) };
  if (evidence !== undefined) result.evidence = evidence;
  if (observedAt !== undefined) result.observedAt = observedAt;
  if (diagnostic !== undefined) {
    if (!isPlainObject(diagnostic)) throw new TypeError(`adapter result: diagnostic must be an object, got ${typeOf(diagnostic)}`);
    if (typeof diagnostic.code !== "string" || diagnostic.code === "") throw new TypeError("adapter result: diagnostic.code must be a non-empty string");
    result.diagnostic = Object.freeze({ ...diagnostic });
  }
  return Object.freeze(result);
}

/**
 * Build an `unavailable` result, redacting any command line or environment it cites.
 *
 * The redaction happens here rather than at the call sites so that an adapter cannot
 * forget it: a diagnostic assembled from `argv` or `env` is the most likely way a
 * credential reaches a log or a PR comment (OPS-4).
 * @param {object} input
 * @param {object} input.provenance
 * @param {string} input.code
 * @param {string} [input.message]
 * @param {boolean} [input.retryable]
 * @param {string[]} [input.argv]
 * @param {Record<string, string|undefined>} [input.env]
 * @returns {object}
 */
export function unavailable({ provenance, code, message, retryable, argv, env }) {
  // With neither `argv` nor `env`, `redactForDiagnostic` returns "", which the filter drops.
  const text = [message, redactForDiagnostic({ argv, env })].filter(Boolean).join(": ");
  return makeAdapterResult({
    status: "unavailable",
    provenance,
    diagnostic: {
      code,
      message: truncate(text === "" ? code : text),
      ...(retryable === undefined ? {} : { retryable }),
    },
  });
}

/**
 * Environment variable names whose value is always redacted.
 *
 * Matched on the NAME, because a credential is not always shaped like one: a short
 * or low-entropy token would pass a pattern check while still being a secret.
 */
const SECRET_NAME_RE = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|BEARER|ACCOUNT|EMAIL|USERNAME)(?:$|_)/i;

/**
 * Argument flags whose following value is a credential.
 *
 * Includes the two conventional short forms `-k` and `-t`. Other single-letter flags
 * are deliberately absent: `-s` and `-p` mean different things in different CLIs, and
 * masking the argument after an unrelated flag would corrupt the diagnostic without
 * protecting anything. For those, the value-shape rules below are the defence.
 *
 * Over-redaction is the right bias here, because the `argv` a diagnostic reports is
 * one Dotbabel constructed itself, so a masked value costs readability while a leaked
 * one is a security defect that blocks the change (OPS-4).
 */
const SECRET_FLAG_RE = /^(?:--(?:api[-_]?key|key|token|secret|password|auth|bearer|credential)|-[kt])$/i;

/**
 * Token shapes that are credentials wherever they appear.
 *
 * This is the belt to the name matching's braces: an unlabelled token on a command
 * line has no variable name to match, so the shape is all that is left.
 */
const SECRET_VALUE_RES = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
]);

/**
 * Remove control characters and bound the length.
 * @param {string} value
 * @returns {string}
 */
function truncate(value) {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, "\uFFFD");
  return clean.length > DIAGNOSTIC_MAX_LENGTH ? `${clean.slice(0, DIAGNOSTIC_MAX_LENGTH - 1)}\u2026` : clean;
}

/**
 * Mask every credential-shaped token in one string.
 * @param {string} value
 * @returns {string}
 */
function maskValues(value) {
  let out = value;
  for (const re of SECRET_VALUE_RES) out = out.replace(re, "[redacted]");
  return out;
}

/**
 * Render a command line and environment as diagnostic text with credentials removed.
 *
 * Redaction is layered because no single rule is sufficient: a flag tells us the NEXT
 * argument is secret, a variable name tells us its VALUE is secret, and a token shape
 * catches what carries neither. The result still has to be readable, so the command,
 * the subcommands and the non-secret variables survive — a diagnostic redacted into
 * uselessness fails the caller as surely as one that leaks (OPS-4).
 * @param {object} input
 * @param {string[]} [input.argv]
 * @param {Record<string, string|undefined>} [input.env]
 * @returns {string}
 */
export function redactForDiagnostic({ argv, env } = {}) {
  const parts = [];
  if (Array.isArray(argv)) {
    const rendered = [];
    let maskNext = false;
    for (const raw of argv) {
      const arg = String(raw);
      if (maskNext) {
        rendered.push("[redacted]");
        maskNext = false;
        continue;
      }
      if (SECRET_FLAG_RE.test(arg)) {
        rendered.push(arg);
        maskNext = true;
        continue;
      }
      // `--token=value` carries the secret in the same argument.
      const inline = /^(--?[A-Za-z0-9][A-Za-z0-9-]*)=(.*)$/s.exec(arg);
      if (inline !== null) {
        const [, flag, value] = inline;
        rendered.push(SECRET_FLAG_RE.test(flag) ? `${flag}=[redacted]` : `${flag}=${maskValues(value)}`);
        continue;
      }
      rendered.push(maskValues(arg));
    }
    parts.push(rendered.join(" "));
  }
  if (isPlainObject(env)) {
    const rendered = [];
    for (const name of ownKeys(env)) {
      if (UNSAFE_KEYS.includes(name)) continue;
      const value = /** @type {any} */ (env)[name];
      if (typeof value !== "string") continue;
      rendered.push(SECRET_NAME_RE.test(name) ? `${name}=[redacted]` : `${name}=${maskValues(value)}`);
    }
    if (rendered.length > 0) parts.push(rendered.join(" "));
  }
  return truncate(parts.filter((p) => p !== "").join(" | "));
}

/**
 * Resolve the timeout for one operation (REL-1).
 * @param {object} input
 * @param {string} input.channel
 * @param {number} [input.timeoutMs]
 * @returns {number}
 */
export function resolveTimeoutMs({ channel, timeoutMs }) {
  if (!TIMEOUT_CHANNELS.includes(channel)) throw new TypeError(`channel must be one of ${TIMEOUT_CHANNELS.join(", ")}`);
  if (timeoutMs === undefined) return OPERATION_TIMEOUTS_MS[/** @type {"subprocess"|"network"} */ (channel)];
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a finite positive number of milliseconds");
  }
  return timeoutMs;
}

/**
 * Map a thrown error to a diagnostic code.
 * @param {unknown} err
 * @returns {string}
 */
function codeForError(err) {
  const code = isPlainObject(err) ? /** @type {any} */ (err).code : undefined;
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return "binary_missing";
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ENETUNREACH" || code === "EAI_AGAIN") return "network_unavailable";
  if (code === "ETIMEDOUT") return "timeout";
  return "runtime_error";
}

/**
 * Run one adapter operation under a finite timeout (REL-1).
 *
 * A breach returns `unavailable` with code `timeout` and `retryable: true`, never a
 * rejected promise: a timeout is a condition of the moment rather than a capability
 * fact, so the adapter keeps whatever support state it declared and the caller is
 * free to try again. An operation that throws becomes `unavailable` too, with the
 * errno mapped to a real failure mode, so the provenance survives the failure.
 *
 * The timer is unref'd and always cleared, so a slow operation cannot hold the
 * process open after the caller has already received its result.
 * @param {() => Promise<unknown>|unknown} operation
 * @param {object} options
 * @param {string} options.channel
 * @param {number} [options.timeoutMs]
 * @param {object} options.provenance
 * @param {() => string} [options.now] Injected clock: this module does not read time itself.
 * @returns {Promise<object>}
 */
export async function runBounded(operation, { channel, timeoutMs, provenance, now }) {
  const limit = resolveTimeoutMs({ channel, timeoutMs });
  const clock = now ?? (() => new Date().toISOString());
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), limit);
    if (typeof timer.unref === "function") timer.unref();
  });

  try {
    const outcome = await Promise.race([Promise.resolve().then(operation), timeout]);
    if (outcome === TIMED_OUT) {
      return makeAdapterResult({
        status: "unavailable",
        provenance,
        observedAt: clock(),
        diagnostic: { code: "timeout", message: `operation exceeded ${limit} ms on the ${channel} channel`, retryable: true },
      });
    }
    return makeAdapterResult({ status: "ok", evidence: outcome, provenance, observedAt: clock() });
  } catch (err) {
    return makeAdapterResult({
      status: "unavailable",
      provenance,
      observedAt: clock(),
      diagnostic: {
        code: codeForError(err),
        message: truncate(maskValues(String(isPlainObject(err) ? (/** @type {any} */ (err).message ?? err) : err))),
        retryable: true,
      },
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Sentinel for a timed-out race. A unique object cannot collide with a real result. */
const TIMED_OUT = Symbol("model-intelligence/timeout");

/**
 * Build a registry over validated descriptors.
 *
 * Every lookup answers with a support STATE rather than a boolean, and an undeclared
 * capability answers `unverified`. That is the ARCH-44 property: absence of a
 * declaration is absence of evidence, not evidence of absence, and fan-out may emit a
 * concrete runtime-native value only where a binding is verified. A registry that
 * defaulted to `unsupported` would look safe while quietly asserting a fact nobody
 * measured; one that defaulted to `supported` would emit projections on a guess.
 * @param {object[]} descriptors
 * @returns {{get: (id: string) => object, has: (id: string) => boolean, ids: string[], bindingSupport: (id: string, kind: string) => string, axisSupport: (id: string, kind: string, axis: string) => string, invocationAxisSupport: (id: string, axis: string) => string, isVerified: (id: string, kind: string, axis?: string) => boolean}}
 */
export function createRegistry(descriptors) {
  if (!Array.isArray(descriptors)) throw new TypeError(`createRegistry: descriptors must be an array, got ${typeOf(descriptors)}`);
  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const descriptor of descriptors) {
    assertDescriptor(descriptor);
    const id = /** @type {any} */ (descriptor).id;
    if (byId.has(id)) throw new TypeError(`createRegistry: duplicate adapter id "${id}"`);
    byId.set(id, Object.freeze(descriptor));
  }

  /**
   * @param {string} id
   * @returns {object}
   */
  const get = (id) => {
    const found = byId.get(id);
    if (found === undefined) throw new TypeError(`no source adapter registered for "${id}"`);
    return found;
  };

  /**
   * @param {string} id
   * @param {string} kind
   * @returns {object | undefined}
   */
  const bindingFor = (id, kind) => safeOwn(/** @type {any} */ (get(id)).capabilities.binding, kind);

  /**
   * @param {string} id
   * @param {string} kind
   * @returns {string}
   */
  const bindingSupport = (id, kind) => bindingFor(id, kind)?.support ?? "unverified";

  /**
   * @param {string} id
   * @param {string} kind
   * @param {string} axis
   * @returns {string}
   */
  const axisSupport = (id, kind, axis) => safeOwn(bindingFor(id, kind)?.axes, axis) ?? "unverified";

  /**
   * @param {string} id
   * @param {string} axis
   * @returns {string}
   */
  const invocationAxisSupport = (id, axis) => safeOwn(/** @type {any} */ (get(id)).capabilities.invocation.axes, axis) ?? "unverified";

  /**
   * @param {string} id
   * @param {string} kind
   * @param {string} [axis]
   * @returns {boolean}
   */
  const isVerified = (id, kind, axis) => {
    if (bindingSupport(id, kind) !== "supported") return false;
    return axis === undefined ? true : axisSupport(id, kind, axis) === "supported";
  };

  return Object.freeze({
    get,
    has: (id) => byId.has(id),
    get ids() {
      return [...byId.keys()];
    },
    bindingSupport,
    axisSupport,
    invocationAxisSupport,
    isVerified,
  });
}
