/**
 * model-intelligence/policy — Dotbabel's own decision framework, and the merge of
 * the four layers that may contribute to it (docs/specs/model-intelligence, §3
 * component 4, ARCH-23).
 *
 * `loadPolicyLayers` owns the only I/O in this module and never writes: resolution
 * is read-only over user and project configuration (ARCH-63). `mergePolicy` is
 * pure and records, for every effective value, the layer it came from, so the
 * resolver can explain a decision rather than assert one (ARCH-56, §5 "Policy").
 *
 * The module holds Dotbabel judgement and nothing else: it names no provider model
 * (ARCH-15) and it neither discovers models nor performs runtime I/O
 * (ARCH-57 rule 6).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { configDir } from "../../lib/paths.mjs";
import { WORKLOAD_CLASSES, RUNTIME_IDS, isRuntimeId, compareWorkloadClass } from "../domain/index.mjs";

const require = createRequire(import.meta.url);

/**
 * Freeze an object and everything reachable from it.
 *
 * `Object.freeze` is shallow, and `createRequire` caches the parsed document, so a
 * shallow freeze would leave `SHIPPED_POLICY.classes` and `.preferences` mutable on
 * a process-wide singleton. The baseline is the one layer nothing may weaken, so it
 * is the object that most needs to be tamper-proof: a single assignment anywhere in
 * the process would otherwise weaken every later merge while provenance still
 * reported `shipped`.
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
  return value;
}

/** The shipped decision framework, in precedence order's weakest position. */
export const SHIPPED_POLICY = /** @type {any} */ (deepFreeze(require("./shipped.json")));

/**
 * Policy layers, weakest first. The order is the precedence chain of ARCH-23, and
 * it is the order `mergePolicy` walks, so a later layer overrides an earlier one
 * for a preference and shadows it for a pin.
 */
export const POLICY_LAYERS = Object.freeze(["shipped", "user", "project", "artifact"]);

/** Basename of the user-scope policy file inside the dotbabel config directory. */
const USER_POLICY_FILE = "model-intelligence.json";

/** Key that carries project policy inside `.dotbabel.json` (§5). */
const PROJECT_POLICY_KEY = "model_intelligence";

/**
 * @typedef {object} PolicyDeclaration
 * @property {"floor"|"pin"} mode
 * @property {string} [requirement] A workload class, for `mode: "floor"`.
 * @property {string} [runtime] A runtime id, for `mode: "pin"`.
 * @property {Record<string, unknown>} [config] Opaque runtime-native values, for `mode: "pin"`.
 */

/**
 * @typedef {object} PolicyLayers
 * @property {object} shipped
 * @property {object} user
 * @property {object} project
 * @property {object} [artifact]
 * @property {{user: string, project: string}} sources Paths the layers were read from.
 */

/**
 * Keys that must never be written by name onto a merged object.
 *
 * `JSON.parse` gives `__proto__` as an OWN enumerable key, so `Object.entries`
 * yields it and a later `target[key] = value` invokes the `Object.prototype`
 * setter instead of defining a property (CWE-1321). The polluted value is then
 * readable through the merged object, absent from `Object.keys` and
 * `JSON.stringify`, and carries no provenance — which defeats the one guarantee
 * this module exists to provide (ARCH-56). A `null` value makes the object
 * prototype-less, so a caller's `hasOwnProperty` throws.
 *
 * A policy file has no legitimate reason to carry these names, so the merge
 * refuses the layer rather than dropping the key: an ignored declaration is the
 * invisible policy this module is built to prevent.
 */
const UNSAFE_KEYS = Object.freeze(["__proto__", "constructor", "prototype"]);

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
 * Read one JSON file, returning `null` when it does not exist.
 *
 * A missing layer is an empty layer, not a failure: most repositories declare no
 * Model Intelligence policy at all. A file that exists and does not parse is a
 * failure, because silently ignoring it would apply a policy the author cannot see.
 * A file that parses to something other than an object is the same failure: `?? {}`
 * catches only `null`, so an array or a string would otherwise merge as an empty
 * layer and silently drop the author's floor.
 *
 * The parse error does not forward V8's message. That message embeds a snippet of
 * the input, and this path reads a file inside a possibly untrusted repository, so
 * the snippet could carry another file's bytes — or raw control characters — into a
 * log or a PR comment (CWE-117, CWE-209, OPS-4).
 * @param {string} file
 * @returns {object | null}
 */
function readJsonOrNull(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw new Error(`cannot read ${file}: ${/** @type {NodeJS.ErrnoException} */ (err).code ?? "unknown error"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`cannot parse ${file}: the file is not valid JSON`);
  }
  if (!isPlainObject(parsed)) throw new TypeError(`cannot use ${file}: expected a JSON object, got ${typeOf(parsed)}`);
  return parsed;
}

/**
 * Load the shipped, user, and project policy layers.
 *
 * The artifact layer is not read here: it comes from the artifact's own
 * `dotbabel.compute` declaration, which `requirement/` parses.
 * @param {{repoRoot?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {PolicyLayers}
 */
export function loadPolicyLayers(options = {}) {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? process.cwd();
  const userPath = join(configDir(env), USER_POLICY_FILE);
  const projectPath = join(repoRoot, ".dotbabel.json");
  const user = readJsonOrNull(userPath) ?? {};
  const projectDocument = readJsonOrNull(projectPath) ?? {};
  const project = projectDocument[PROJECT_POLICY_KEY] ?? {};
  return {
    shipped: SHIPPED_POLICY,
    user,
    project,
    sources: { user: userPath, project: projectPath },
  };
}

/**
 * Compare two floor declarations, returning the one in force.
 *
 * A floor only ever strengthens (§5 `floor`), so the stronger class wins. A TIE goes
 * to `b`, the more specific layer, which matters only for the explanation: the
 * effective class is identical either way, but returning the broader declaration
 * would attribute an artifact author's deliberate floor to shipped policy and
 * discard the rationale that artifact carried. It also makes the floor rule and the
 * pin rule agree — when nothing else decides, the most specific layer wins.
 * @param {PolicyDeclaration | undefined} a
 * @param {PolicyDeclaration | undefined} b
 * @returns {PolicyDeclaration | undefined}
 */
function strongerFloor(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareWorkloadClass(b.requirement, a.requirement) >= 0 ? b : a;
}

/**
 * Validate one layer's declarations.
 *
 * Every rejection names the layer, because an unnamed shape error in a merge over
 * four files tells the author nothing about which file to open.
 * @param {string} layer
 * @param {object} declarations
 * @returns {void}
 */
function assertLayer(layer, declarations) {
  const { floor, pin } = declarations;
  if (floor !== undefined) {
    if (!isPlainObject(floor)) throw new TypeError(`${layer} policy: floor must be an object, got ${typeOf(floor)}`);
    if (floor.mode !== "floor") throw new TypeError(`${layer} policy: floor.mode must be "floor"`);
    if (!WORKLOAD_CLASSES.includes(floor.requirement)) {
      throw new TypeError(`${layer} policy: floor.requirement must be one of ${WORKLOAD_CLASSES.join(", ")}`);
    }
  }
  if (pin !== undefined) {
    // ARCH-15. A shipped pin would put a runtime-native configuration into the
    // stable framework, which is what the release snapshot exists for instead.
    if (layer === "shipped") throw new TypeError("shipped policy must not declare a pin: a concrete configuration belongs to the release snapshot");
    if (!isPlainObject(pin)) throw new TypeError(`${layer} policy: pin must be an object, got ${typeOf(pin)}`);
    if (pin.mode !== "pin") throw new TypeError(`${layer} policy: pin.mode must be "pin"`);
    // The runtime registry is authoritative and Model Intelligence does not keep a
    // second enum (§5 `pin`), so this validates against `RUNTIME_IDS` rather than
    // accepting any non-empty string. `assertLayer` is the ONLY ingest-time gate for
    // both files: the user file has no schema, and nothing applies
    // `dotbabel.config.schema.json` at load time, so a check missing here is a check
    // that never runs.
    if (!isRuntimeId(pin.runtime)) throw new TypeError(`${layer} policy: pin.runtime must be one of ${RUNTIME_IDS.join(", ")}`);
    if (!isPlainObject(pin.config) || Object.keys(pin.config).length === 0) {
      throw new TypeError(`${layer} policy: pin.config must be a non-empty object of runtime-native values`);
    }
  }
}

/**
 * Scope named by the spec's pin precedence chain but not merged by this module.
 *
 * §5 orders pins `shipped < user < project < artifact < explicit invocation`, and
 * ARCH-66 makes an invocation pin "more specific again". An invocation pin is not a
 * configuration layer, though: it arrives with a single resolve call rather than from
 * a file, so the resolver applies it. Naming it here means a caller that passes it
 * gets told where it belongs, instead of having it silently dropped and watching the
 * artifact pin win — the precedence inversion ARCH-66 forbids.
 */
const RESOLVER_OWNED_SCOPES = Object.freeze(["invocation"]);

/**
 * Reject any key that is not a merged policy layer.
 *
 * Silence here is the failure this module exists to prevent. A misspelled
 * `artifacts:` would otherwise discard a safety floor with no diagnostic, which is
 * the inert-policy failure §5 argues against for `dotbabel.compute`.
 * @param {Partial<Record<string, object>>} layers
 * @returns {void}
 */
function assertKnownLayers(layers) {
  if (!isPlainObject(layers)) throw new TypeError(`mergePolicy: layers must be an object, got ${typeOf(layers)}`);
  for (const key of Object.keys(layers)) {
    if (POLICY_LAYERS.includes(key)) continue;
    if (RESOLVER_OWNED_SCOPES.includes(key)) {
      throw new TypeError(`mergePolicy: "${key}" is not a policy layer; an invocation pin is supplied to the resolver, not merged here`);
    }
    throw new TypeError(`mergePolicy: unknown policy layer "${key}"; expected one of ${POLICY_LAYERS.join(", ")}`);
  }
}

/**
 * Copy own string-keyed entries onto a prototype-less target, refusing unsafe keys.
 * @param {Record<string, unknown>} target
 * @param {unknown} source
 * @param {string} layer
 * @param {string} where
 * @param {(key: string) => void} [onWrite]
 * @returns {void}
 */
function copyEntries(target, source, layer, where, onWrite) {
  if (source === undefined) return;
  if (!isPlainObject(source)) throw new TypeError(`${layer} policy: ${where} must be an object, got ${typeOf(source)}`);
  for (const [key, value] of Object.entries(/** @type {object} */ (source))) {
    // The `$` prefix is the JSON comment convention this repository's policy files
    // use (`shipped.json` carries `$comment`), so those keys are documentation and
    // never policy.
    if (key.startsWith("$")) continue;
    if (UNSAFE_KEYS.includes(key)) throw new TypeError(`${layer} policy: ${where} must not contain the key "${key}"`);
    target[key] = value;
    if (onWrite !== undefined) onWrite(key);
  }
}

/**
 * Merge the policy layers into one effective policy.
 *
 * A floor composes monotonically: the strongest applicable minimum wins, whichever
 * layer declared it, so a broader layer may strengthen a floor and no layer may
 * weaken a more specific one (§5, `floor`). A pin does not compose: the most
 * specific one wins, and every shadowed pin is recorded rather than dropped, so
 * the resolver can explain why it did not apply (ARCH-66).
 * @param {Partial<Record<string, object>>} layers Keyed by `POLICY_LAYERS` name.
 * @returns {{floor?: PolicyDeclaration, pin?: PolicyDeclaration, preferences: object, shadowed: object[], provenance: Record<string, string>}}
 */
export function mergePolicy(layers) {
  assertKnownLayers(layers);

  /** @type {PolicyDeclaration | undefined} */
  let floor;
  /** @type {PolicyDeclaration | undefined} */
  let pin;
  /** @type {object[]} */
  const shadowed = [];
  // Prototype-less containers. `copyEntries` already refuses the unsafe keys, so
  // this is defence in depth: with no prototype to reach, a future caller that
  // writes a key by name cannot reach a setter either.
  /** @type {Record<string, unknown>} */
  const preferences = Object.create(null);
  /** @type {Record<string, string>} */
  const provenance = Object.create(null);
  /** @type {Record<string, unknown> | undefined} */
  let classes;
  /** @type {string | undefined} */
  let pinLayer;

  for (const layer of POLICY_LAYERS) {
    const declarations = layers[layer];
    if (declarations === undefined || declarations === null) continue;
    if (!isPlainObject(declarations)) throw new TypeError(`${layer} policy: expected an object, got ${typeOf(declarations)}`);
    assertLayer(layer, declarations);

    if (declarations.floor !== undefined) {
      const winner = strongerFloor(floor, declarations.floor);
      // Record the layer only when this one actually put its own value in force, so
      // the provenance names the layer whose floor is effective.
      if (winner === declarations.floor && winner !== floor) provenance.floor = layer;
      floor = winner;
    }

    if (declarations.pin !== undefined) {
      if (pin !== undefined) {
        shadowed.push({
          layer: pinLayer,
          // `pin.config` is opaque runtime-native configuration that may legitimately
          // hold an endpoint or a credential, and `shadowed` exists to be rendered as
          // a diagnostic. Record the runtime and the config's shape, never its values
          // (OPS-4) — the shadowed pin is most often the USER's, surfaced because a
          // repository shadowed it, so the value at risk is not the repository's.
          declaration: { runtime: pin.runtime, configKeys: Object.keys(pin.config ?? {}).sort() },
          reason: `superseded by the ${layer} pin, which is the more specific declaration`,
        });
      }
      pin = declarations.pin;
      pinLayer = layer;
      provenance.pin = layer;
    }

    // The class table is the substance of Dotbabel's judgement: it says which
    // capabilities satisfy which workload class. Carrying it through means the
    // resolver reads one effective policy instead of importing `SHIPPED_POLICY`
    // directly and reaching around this layering. The schema lets no other layer
    // declare it today, so in practice `shipped` always wins.
    if (declarations.classes !== undefined) {
      if (!isPlainObject(declarations.classes)) throw new TypeError(`${layer} policy: classes must be an object, got ${typeOf(declarations.classes)}`);
      classes = declarations.classes;
      provenance.classes = layer;
    }

    copyEntries(preferences, declarations.preferences, layer, "preferences", (key) => {
      provenance[`preferences.${key}`] = layer;
    });
  }

  /** @type {Record<string, unknown>} */
  const merged = { preferences, shadowed, provenance };
  if (classes !== undefined) merged.classes = classes;
  if (floor !== undefined) merged.floor = floor;
  if (pin !== undefined) merged.pin = pin;
  // ARCH-67 — "a pin is usable only if it satisfies every effective floor" — is
  // deliberately NOT decided here. Judging whether a runtime-native configuration
  // satisfies a semantic floor needs catalog evidence, which P-4 excludes. This
  // function therefore reports both declarations with their layers and leaves the
  // conflict to `resolver/` (P-10, P-11), which owns the `pin_floor_conflict`
  // diagnostic. A test pins that contract so the absence stays deliberate.
  return Object.freeze(merged);
}
