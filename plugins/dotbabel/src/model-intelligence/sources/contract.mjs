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
 * ARCH-12 lists `stale` among the states an adapter may report. Section 5 supersedes
 * that: freshness is derived by `catalog/` from `observedAt`, and a flat `status: stale`
 * is the ambiguous form the spec names as the thing to avoid. So `stale` is absent from
 * the result vocabulary on purpose, and a test pins that.
 *
 * This module holds no adapter. It validates descriptors and builds results over
 * supplied data, and `runBounded` owns only the timer and the caller's own callback
 * (ARCH-56). It performs no subprocess, network or filesystem I/O of its own. The one
 * thing it reads is the wall clock, and only as `runBounded`'s default: `sources/` is a
 * boundary module where that is allowed, and a caller can inject a clock to make a
 * result deterministic.
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

/**
 * REL-1 default bounds: 10 seconds for a subprocess and 20 for a network call.
 *
 * These are the bounds `runBounded` applies to an operation that runs through it. The
 * second half of REL-1, that an adapter may not declare an operation `supported` until
 * its termination is bounded, is NOT enforced by this module: nothing here can tell
 * whether an adapter routed its operation through `runBounded`. That eligibility rule
 * belongs to the adapter tests of P-6 onward.
 */
export const OPERATION_TIMEOUTS_MS = Object.freeze({ subprocess: 10_000, network: 20_000 });

/**
 * The largest delay `setTimeout` honours. Node clamps anything above it to 1 ms, which
 * would turn a generous timeout into an immediate one.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The five capability blocks every descriptor declares (ARCH-50).
 *
 * ARCH-25 also asks whether a descriptor "can authoritatively answer local
 * availability". No field here answers that on purpose. Section 5 `Authority` decides
 * that a descriptor never declares itself authoritative: authority is field-specific and
 * is applied by `catalog/` under ARCH-28.
 */
const CAPABILITY_KEYS = Object.freeze(["discovery", "observation", "binding", "invocation", "validation"]);

/** Keys an operation block may carry. `$comment` is the documented annotation key. */
const OPERATION_BLOCK_KEYS = Object.freeze(["support", "network", "auth", "cacheable", "execution", "$comment"]);

/** The operational keys an operation declared `unsupported` must omit. */
const OPERATIONAL_KEYS = Object.freeze(["network", "auth", "cacheable", "execution"]);

/** Keys a binding entry or the invocation block may carry. */
const SUPPORT_AXES_KEYS = Object.freeze(["support", "axes", "$comment"]);

/** Operation blocks, as opposed to `binding` and `invocation`. */
const OPERATION_KEYS = Object.freeze(["discovery", "observation", "validation"]);

/** Top-level descriptor keys. Anything else is a validation error. */
const DESCRIPTOR_KEYS = Object.freeze(["id", "kind", "capabilities", "$comment"]);

/** Result keys. A freshness or availability field here collapses the dimensions. */
const RESULT_KEYS = Object.freeze(["status", "evidence", "provenance", "observedAt", "diagnostic"]);

/**
 * Provenance keys. Provenance names the source and nothing else: OPS-4 keeps account
 * identifiers out of it, and the section 5 invariant keeps freshness out of it.
 */
const PROVENANCE_KEYS = Object.freeze(["sourceId", "sourceKind", "sourceVersion", "adapterVersion"]);

/** Diagnostic keys, as section 5 declares them. */
const DIAGNOSTIC_KEYS = Object.freeze(["code", "message", "retryable"]);

/** A source or adapter id: it enters results, logs and cache keys, so it has the shape of an identifier. */
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A version string. Deliberately narrower than "any non-empty text": a runtime's
 * `--version` output can carry more than a version, such as an account, and this is the
 * only check standing between that text and a persisted provenance record.
 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+~:-]{0,63}$/;

/** A diagnostic code: machine-readable, so lowercase snake_case, never free text. */
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** An ISO-8601 timestamp with an explicit offset. `Date.parse` then rejects impossible dates. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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
 * True when `value` is a string with at least one character.
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value !== "";
}

/**
 * Freeze an object and everything reachable from it.
 * @param {any} value
 * @returns {any}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
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
 * Report every key of a block that is not in the allowed list.
 *
 * The top level of a descriptor already refuses a key by name, and a block inside it
 * must too. A typo or a stale key would otherwise become inert: the author believes it,
 * the validator ignores it, and no consumer reads it. That includes a resurrected
 * `requiresNetwork` boolean or an `availability` field, which would collapse the three
 * dimensions one level down from where the top-level guard looks.
 * @param {object} block
 * @param {readonly string[]} allowed
 * @param {string} path
 * @param {DescriptorError[]} errors
 * @returns {void}
 */
function rejectUnknownKeys(block, allowed, path, errors) {
  for (const key of ownKeys(block)) {
    if (!allowed.includes(key)) {
      errors.push({ path: `${path}.${key}`, message: `unknown key; expected only ${allowed.join(", ")}` });
    }
  }
  checkComment(block, path, errors);
}

/**
 * Require `$comment`, when present, to be a string.
 *
 * It is allowed at every level and is otherwise unchecked, so a function or a deeply
 * nested object placed there would pass validation and then crash the registry's
 * snapshot with an opaque error instead of a `DescriptorError`.
 * @param {object} block
 * @param {string} path
 * @param {DescriptorError[]} errors
 * @returns {void}
 */
function checkComment(block, path, errors) {
  if (Object.hasOwn(block, "$comment") && typeof (/** @type {any} */ (block).$comment) !== "string") {
    errors.push({ path: path === "" ? "$comment" : `${path}.$comment`, message: "must be a string" });
  }
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
  rejectUnknownKeys(operation, OPERATION_BLOCK_KEYS, path, errors);
  if (!SUPPORT_STATES.includes(operation.support)) {
    errors.push({ path: `${path}.support`, message: `must be one of ${SUPPORT_STATES.join(", ")}` });
  }
  // An operation declared `unsupported` must OMIT the operational axes: there is no
  // network, auth or execution story for something that does not happen (§5
  // `Knowledge-source adapters`). "May omit" is not "may contradict", so a present one
  // is an error, because it is the reader confusion the omission exists to prevent.
  // Any other support state must declare all four.
  if (operation.support === "unsupported") {
    for (const key of OPERATIONAL_KEYS) {
      if (Object.hasOwn(operation, key)) {
        errors.push({ path: `${path}.${key}`, message: "must be omitted when the operation is unsupported" });
      }
    }
    return;
  }

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
  rejectUnknownKeys(block, SUPPORT_AXES_KEYS, path, errors);
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

  checkComment(descriptor, "", errors);
  const { id, kind, capabilities } = /** @type {any} */ (descriptor);
  if (typeof id !== "string" || id === "") {
    errors.push({ path: "id", message: "must be a non-empty string" });
  } else if (!IDENTIFIER_RE.test(id)) {
    errors.push({ path: "id", message: "must be an identifier: letters, digits, dot, underscore or hyphen, at most 64" });
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
 *
 * Every field that can carry text into a log or a PR comment is constrained. The
 * diagnostic message is masked and bounded. The source id, the two versions and the
 * diagnostic code must have the shape of an identifier, because a CLI's `--version`
 * output can carry more than a version, such as an account, and nothing else stops it.
 * `evidence` is structured data for `catalog/` rather than diagnostic text, so it is
 * neither masked nor copied.
 * @param {object} input
 * @returns {object} A result frozen at the top level. Its provenance and diagnostic are frozen too, and `evidence` is passed by reference.
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
  for (const key of ownKeys(provenance)) {
    if (!PROVENANCE_KEYS.includes(key)) {
      throw new TypeError(`adapter result: provenance has unknown key "${key}"; provenance names the source and nothing else (OPS-4)`);
    }
  }
  // Read by OWN key, so the fields that are checked are exactly the fields that are copied.
  // A dotted read resolves through the prototype chain and would validate a value the copy
  // below then drops, leaving a frozen empty provenance.
  const sourceId = safeOwn(provenance, "sourceId");
  const sourceKind = safeOwn(provenance, "sourceKind");
  const sourceVersion = safeOwn(provenance, "sourceVersion");
  const adapterVersion = safeOwn(provenance, "adapterVersion");
  if (!isNonEmptyString(sourceId)) throw new TypeError("adapter result: provenance.sourceId must be a non-empty string");
  if (!IDENTIFIER_RE.test(sourceId)) throw new TypeError("adapter result: provenance.sourceId must be an identifier: letters, digits, dot, underscore or hyphen, at most 64");
  if (!DESCRIPTOR_KINDS.includes(sourceKind)) {
    throw new TypeError(`adapter result: provenance.sourceKind must be one of ${DESCRIPTOR_KINDS.join(", ")}`);
  }
  for (const [key, value] of [["sourceVersion", sourceVersion], ["adapterVersion", adapterVersion]]) {
    if (value !== undefined && !(typeof value === "string" && VERSION_RE.test(value))) {
      throw new TypeError(`adapter result: provenance.${key} must be a version string: letters, digits and . _ + ~ : -, at most 64`);
    }
  }
  // observedAt is the one input catalog/ derives freshness from, so a value it cannot
  // parse would surface as a freshness bug in a module that cannot defend itself.
  if (observedAt !== undefined && !(typeof observedAt === "string" && ISO_TIMESTAMP_RE.test(observedAt) && !Number.isNaN(Date.parse(observedAt)))) {
    throw new TypeError("adapter result: observedAt must be an ISO-8601 timestamp string when present");
  }
  // `ok` means usable evidence was produced, and any other status means it was not.
  // Allowing either half alone would let a caller read evidence off a failure or
  // treat an empty success as a real answer — the OpenCode exit-0 case (ARCH-30).
  if (status === "ok" && evidence === undefined) throw new TypeError("adapter result: status ok requires evidence");
  if (status !== "ok" && evidence !== undefined) throw new TypeError(`adapter result: status ${status} must carry no evidence`);

  /** @type {Record<string, unknown>} */
  const result = {
    status,
    provenance: Object.freeze({
      sourceId,
      sourceKind,
      ...(sourceVersion === undefined ? {} : { sourceVersion }),
      ...(adapterVersion === undefined ? {} : { adapterVersion }),
    }),
  };
  if (evidence !== undefined) result.evidence = evidence;
  if (observedAt !== undefined) result.observedAt = observedAt;
  if (diagnostic !== undefined) {
    if (!isPlainObject(diagnostic)) throw new TypeError(`adapter result: diagnostic must be an object, got ${typeOf(diagnostic)}`);
    for (const key of ownKeys(diagnostic)) {
      if (!DIAGNOSTIC_KEYS.includes(key)) throw new TypeError(`adapter result: diagnostic has unknown key "${key}"`);
    }
    const code = safeOwn(diagnostic, "code");
    const message = safeOwn(diagnostic, "message");
    const retryable = safeOwn(diagnostic, "retryable");
    if (!isNonEmptyString(code)) throw new TypeError("adapter result: diagnostic.code must be a non-empty string");
    if (!CODE_RE.test(code)) throw new TypeError("adapter result: diagnostic.code must be lowercase snake_case: a-z, 0-9 and underscore, at most 64");
    if (!isNonEmptyString(message)) throw new TypeError("adapter result: diagnostic.message must be a non-empty string; section 5 declares it required");
    if (retryable !== undefined && typeof retryable !== "boolean") {
      throw new TypeError("adapter result: diagnostic.retryable must be a boolean when present");
    }
    // The message is masked and bounded HERE, in the one function every result passes
    // through, so an adapter that builds its own unsupported or unknown result cannot
    // forget it (OPS-4). Masking only in `unavailable()` left a hand-built diagnostic
    // able to carry a token straight into a log or a PR comment.
    result.diagnostic = Object.freeze({
      code,
      message: truncate(maskText(message)),
      ...(retryable === undefined ? {} : { retryable }),
    });
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
  // `message` is masked and bounded by `makeAdapterResult`, like every diagnostic.
  const text = [message, redactForDiagnostic({ argv, env })].filter(Boolean).join(": ");
  return makeAdapterResult({
    status: "unavailable",
    provenance,
    diagnostic: { code, message: text === "" ? code : text, ...(retryable === undefined ? {} : { retryable }) },
  });
}

/** Stands in for a control or format character when text is bounded for output. */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** Marks a truncation, so a reader does not assume the text really ended there. */
const ELLIPSIS = String.fromCharCode(0x2026);

/**
 * Words that mark a variable, flag or header NAME as holding a credential.
 *
 * A name is split on `-` and `_`, and a segment matches when it ENDS in one of these
 * words, optionally plural. Ending is deliberate and equalling is not enough:
 * `PGPASSWORD`, `APIKEY`, `AUTHTOKEN` and `CLIENT_SECRETS` are all real spellings that an
 * exact-word rule misses, and a credential is often too short or too plain for any
 * shape rule to notice, so the name is the only signal. `KEYBOARD_LAYOUT` and `PATH`
 * still pass, because `KEYBOARD` does not END in a secret word and `PATH` ends in `H`.
 *
 * Over-redaction is the right bias. The text a diagnostic reports is text Dotbabel built
 * itself, so a masked value costs readability while a leaked one is a security defect
 * that blocks the change (OPS-4).
 */
const SECRET_WORDS = Object.freeze([
  "KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "AUTHORIZATION",
  "AUTH",
  "BEARER",
  "COOKIE",
  "SESSION",
  "ACCOUNT",
  "EMAIL",
  "USERNAME",
]);

/**
 * Short words that mark a secret only as a WHOLE segment.
 *
 * `MYSQL_PASS`, `GITHUB_PAT` and `APP_PWD` are real names, but as a suffix these three
 * words also end `BYPASS`, `COMPASS` and `COMPAT`, so `COMPAT_LEVEL=2` would be redacted
 * for nothing.
 */
const SECRET_WHOLE_WORDS = Object.freeze(["PASS", "PWD", "PAT"]);

/** One name segment that ends in a secret word, or is one of the short whole words. */
const SECRET_SEGMENT_RE = new RegExp(`(?:${SECRET_WORDS.join("|")})S?$|^(?:${SECRET_WHOLE_WORDS.join("|")})S?$`, "i");

/**
 * Whether a variable, flag or header name marks its value as a credential.
 * @param {string} name
 * @returns {boolean}
 */
function isSecretName(name) {
  return name.split(/[-_]+/).some((segment) => SECRET_SEGMENT_RE.test(segment));
}

/**
 * The two conventional short flags that introduce a credential.
 *
 * Other single-letter flags are deliberately absent: `-s` and `-p` mean different
 * things in different CLIs, and masking the argument after an unrelated flag would
 * corrupt the diagnostic without protecting anything. For those, the value-shape rules
 * are the defence.
 */
const SECRET_SHORT_FLAG_RE = /^-[kt]$/i;

/**
 * Whether one argument is a flag whose following value is a credential.
 *
 * A flag cannot say how many arguments it takes, so a boolean flag such as
 * `--no-auth` also masks the argument after it. That costs one word of readability and
 * is the same bias as above.
 * @param {string} arg
 * @returns {boolean}
 */
function isSecretFlag(arg) {
  if (SECRET_SHORT_FLAG_RE.test(arg)) return true;
  const named = /^--([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(arg);
  return named !== null && isSecretName(named[1]);
}

/**
 * Token shapes that are credentials wherever they appear.
 *
 * This is the last layer, for text that carries neither a flag nor a name: an unlabelled
 * token has nothing to match but its shape.
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

/*
 * Every pattern below that scans a run of name characters starts with a lookbehind that
 * forbids one before the match. Without it the pattern could begin at EVERY position
 * inside one long token, consume the rest of the token greedily, fail to find its
 * separator, and backtrack: quadratic, 80,000 characters of `-a` took 5 seconds. With it
 * a token is scanned from its first character only, so the work is linear (CWE-1333).
 */

/** Credentials carried in the userinfo part of a URL: `scheme://user:secret@host`. */
const URL_USERINFO_RE = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+@/g;

/** A header whose whole value is a credential, matched to the end of its line. */
const SECRET_HEADER_RE = /\b((?:proxy-)?authorization|cookie|set-cookie)(\s*:\s*)[^\r\n]*/gi;

/**
 * A bearer credential, or a base64 blob after `Basic`, appearing outside a header.
 *
 * `Basic` needs eight base64 characters after it, so ordinary prose such as "Basic
 * auth" survives. A short blob that slips under the floor is still caught by the
 * header rule when it travels in a header, which is where it normally does.
 */
const BEARER_RE = /\b(Bearer\s+[A-Za-z0-9._~+/=-]+|Basic\s+[A-Za-z0-9+/]{8,}={0,2})/gi;

/** `--flag value` or `--flag=value`, so a labelled flag inside free text is found. */
const FLAG_VALUE_RE = /(?<![A-Za-z0-9_-])(--?[A-Za-z0-9][A-Za-z0-9_-]*)(=|\s+)(?!-)("[^"]*"|'[^']*'|\S+)/g;

/**
 * The LABEL of `name=value`, `name: value` or a JSON-style `"name": "value"`: a name and
 * its separator, without the value. The optional quote after the name is what lets a JSON
 * key, whose closing quote sits between the name and the colon, reach its separator.
 */
const LABEL_RE = /(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)/g;

/** The value that follows a label. Sticky, so it matches exactly where the label ended. */
const LABEL_VALUE_RE = /"[^"]*"|'[^']*'|[^\s,;)&]+/y;

/**
 * Mask the value of every secret-named label in free text.
 *
 * The label is matched alone and the value is consumed only when the name is a secret.
 * Matching name and value together would swallow the value of a NON-secret name, so in
 * `https://host/cb?token=abc` the label `https:` would consume the whole URL and the
 * `token=` inside it would never be examined. Skipping a value instead leaves the scan
 * free to resume inside it.
 * @param {string} text
 * @returns {string}
 */
function maskLabelled(text) {
  let out = "";
  let copied = 0;
  LABEL_RE.lastIndex = 0;
  for (let label = LABEL_RE.exec(text); label !== null; label = LABEL_RE.exec(text)) {
    if (!isSecretName(label[1])) continue;
    const valueStart = label.index + label[0].length;
    LABEL_VALUE_RE.lastIndex = valueStart;
    const value = LABEL_VALUE_RE.exec(text);
    if (value === null) continue;
    out += `${text.slice(copied, valueStart)}[redacted]`;
    copied = valueStart + value[0].length;
    LABEL_RE.lastIndex = copied;
  }
  return out + text.slice(copied);
}

/**
 * Largest text `maskText` will examine. A diagnostic is cut to a kilobyte, and masking
 * can shrink text by at most a factor of four (a 40-character token becomes ten), so
 * 32 KiB of input cannot put more than eight kilobytes of masked text in front of
 * a cut, and a token this bound splits lands far beyond anything that can reach output.
 */
const MASK_INPUT_LIMIT = 32_768;

/**
 * Remove control and format characters, keeping tab, newline and carriage return.
 *
 * This runs BEFORE the header rule and every other pattern. A zero-width character
 * inside a header NAME or inside a token would otherwise break the match first and only
 * turn into visible noise afterwards, leaving the value readable. Whitespace controls
 * stay for now because the header rule matches to the end of a line.
 * @param {string} value
 * @returns {string}
 */
function stripInvisible(value) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (/[\t\n\r]/.test(ch) ? ch : ""));
}

/**
 * Bound text for output: replace control characters and cut it at the diagnostic limit.
 *
 * A cut between the two halves of a surrogate pair would leave a lone surrogate, which
 * is not valid text and corrupts JSON output and PR comments, so the cut backs off one
 * unit when it lands there.
 * @param {string} value
 * @returns {string}
 */
function truncate(value) {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, REPLACEMENT_CHAR);
  if (clean.length <= DIAGNOSTIC_MAX_LENGTH) return clean;
  let head = clean.slice(0, DIAGNOSTIC_MAX_LENGTH - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return head + ELLIPSIS;
}

/**
 * Mask every credential in free text: a message, an error, or one argument.
 *
 * This is the one guard behind every path that can put text into a diagnostic. The
 * layers are ordered because no single rule is sufficient: URL userinfo and credential
 * headers first, then a secret flag or a secret NAME, and last the shape of a token.
 * The command and its non-secret words survive, because a diagnostic redacted into
 * uselessness fails its caller as surely as one that leaks (OPS-4).
 *
 * The input is bounded to 32 KiB before any pattern runs, so the cost is bounded too.
 * That is safe here because a diagnostic keeps only its first kilobyte.
 * @param {unknown} value
 * @returns {string}
 */
export function maskText(value) {
  let out = stripInvisible(String(value).slice(0, MASK_INPUT_LIMIT)).replace(SECRET_HEADER_RE, "$1$2[redacted]");
  out = out.replace(/[\t\n\r]/g, " ").replace(URL_USERINFO_RE, "$1[redacted]@").replace(BEARER_RE, (match) => `${match.split(/\s/)[0]} [redacted]`);
  out = out.replace(FLAG_VALUE_RE, (match, flag, sep) => (isSecretFlag(flag) ? `${flag}${sep}[redacted]` : match));
  out = maskLabelled(out);
  for (const re of SECRET_VALUE_RES) out = out.replace(re, "[redacted]");
  return out;
}

/**
 * Mask and bound free text that came from a runtime, so it can be carried in evidence.
 *
 * A runtime's own output is the text most likely to echo a credential back, and it can be
 * arbitrarily long. This is the guard for any such text that is not a diagnostic message:
 * a diagnostic already passes through it inside `makeAdapterResult`.
 * @param {unknown} value
 * @returns {string} Masked, free of control characters, and at most 1,024 characters.
 */
export function boundText(value) {
  return truncate(maskText(value));
}

/**
 * Whether `value` has the shape of a version string (the same shape provenance requires).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isVersionString(value) {
  return typeof value === "string" && VERSION_RE.test(value);
}

/**
 * Render a command line and environment as diagnostic text with credentials removed.
 *
 * Each argument is masked as text, and an argument that is itself a secret flag also
 * masks the one after it. Each variable is masked by NAME first and by value second.
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
      rendered.push(maskText(arg));
      maskNext = isSecretFlag(arg);
    }
    parts.push(rendered.join(" "));
  }
  if (isPlainObject(env)) {
    const rendered = [];
    for (const name of ownKeys(env)) {
      if (UNSAFE_KEYS.includes(name)) continue;
      const value = /** @type {any} */ (env)[name];
      if (typeof value !== "string") continue;
      rendered.push(isSecretName(name) ? `${name}=[redacted]` : `${name}=${maskText(value)}`);
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
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new TypeError(`timeoutMs must be a positive whole number of milliseconds no greater than ${MAX_TIMER_MS}`);
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
 * This module's own timer is unref'd and always cleared. Promise.race abandons the
 * loser but cannot stop it, so the operation receives an `AbortSignal` and the runner
 * aborts it when the timeout wins. Only an operation that honours the signal, for
 * example by killing its child process, releases its own handles: without it the
 * guarantee is that the PROMISE settles, not that the work stops.
 *
 * An operation that resolves nothing is reported as `unknown` with code
 * `insufficient_evidence`. Treating it as `ok` would invent evidence, and letting it
 * fall into the catch below would report a programming error as a transient failure.
 * @param {(context: {signal: AbortSignal}) => Promise<unknown>|unknown} operation
 * @param {object} options
 * @param {string} options.channel
 * @param {number} [options.timeoutMs]
 * @param {object} options.provenance
 * @param {() => string} [options.now] Clock for `observedAt`. Injectable so a caller can make a result deterministic; the default reads real time, which a `sources/` module may do.
 * @returns {Promise<object>}
 */
export async function runBounded(operation, { channel, timeoutMs, provenance, now }) {
  const limit = resolveTimeoutMs({ channel, timeoutMs });
  const clock = now ?? (() => new Date().toISOString());
  const controller = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, limit);
    if (typeof timer.unref === "function") timer.unref();
  });

  try {
    const outcome = await Promise.race([Promise.resolve().then(() => operation({ signal: controller.signal })), timeout]);
    if (outcome === TIMED_OUT) {
      return makeAdapterResult({
        status: "unavailable",
        provenance,
        observedAt: clock(),
        diagnostic: { code: "timeout", message: `operation exceeded ${limit} ms on the ${channel} channel`, retryable: true },
      });
    }
    if (outcome === undefined) {
      return makeAdapterResult({
        status: "unknown",
        provenance,
        observedAt: clock(),
        diagnostic: { code: "insufficient_evidence", message: "the operation resolved no evidence" },
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
        // Masked and bounded by makeAdapterResult, like every diagnostic message.
        message: String(isPlainObject(err) ? (/** @type {any} */ (err).message ?? err) : err) || codeForError(err),
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
    // Snapshot FIRST and validate the snapshot. Validating the caller's object and then
    // cloning it reads every property twice, and a getter can answer differently the
    // second time, so the registry would store something that never passed validation
    // (a time-of-check to time-of-use gap on the ARCH-44 property this registry exists
    // for). The snapshot is also frozen all the way down: freezing the caller's own
    // object would be a side effect on state the registry does not own, and a shallow
    // freeze would let a caller who kept a handle on a nested table change what
    // `isVerified` reports.
    let snapshot;
    try {
      snapshot = structuredClone(descriptor);
    } catch {
      throw new TypeError("createRegistry: a descriptor must be plain data: no functions, symbols or other values that cannot be cloned");
    }
    assertDescriptor(snapshot);
    const id = /** @type {any} */ (snapshot).id;
    if (byId.has(id)) throw new TypeError(`createRegistry: duplicate adapter id "${id}"`);
    byId.set(id, deepFreeze(snapshot));
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
