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
import { WORKLOAD_CLASSES, compareWorkloadClass } from "../domain/index.mjs";

const require = createRequire(import.meta.url);

/** The shipped decision framework, in precedence order's weakest position. */
export const SHIPPED_POLICY = Object.freeze(require("./shipped.json"));

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
 * Read one JSON file, returning `null` when it does not exist.
 *
 * A missing layer is an empty layer, not a failure: most repositories declare no
 * Model Intelligence policy at all. A file that exists and does not parse is a
 * failure, because silently ignoring it would apply a policy the author cannot see.
 * @param {string} file
 * @returns {object | null}
 */
function readJsonOrNull(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw new Error(`cannot read ${file}: ${/** @type {Error} */ (err).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${/** @type {Error} */ (err).message}`);
  }
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
 * Compare two floor declarations, returning the stronger.
 * @param {PolicyDeclaration | undefined} a
 * @param {PolicyDeclaration | undefined} b
 * @returns {PolicyDeclaration | undefined}
 */
function strongerFloor(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return compareWorkloadClass(b.requirement, a.requirement) > 0 ? b : a;
}

/**
 * Validate one layer's declarations.
 * @param {string} layer
 * @param {object} declarations
 * @returns {void}
 */
function assertLayer(layer, declarations) {
  const { floor, pin } = declarations;
  if (floor !== undefined) {
    if (floor.mode !== "floor") throw new TypeError(`${layer} policy: floor.mode must be "floor"`);
    if (!WORKLOAD_CLASSES.includes(floor.requirement)) {
      throw new TypeError(`${layer} policy: floor.requirement must be one of ${WORKLOAD_CLASSES.join(", ")}`);
    }
  }
  if (pin !== undefined) {
    // ARCH-15. A shipped pin would put a runtime-native configuration into the
    // stable framework, which is what the release snapshot exists for instead.
    if (layer === "shipped") throw new TypeError("shipped policy must not declare a pin: a concrete configuration belongs to the release snapshot");
    if (pin.mode !== "pin") throw new TypeError(`${layer} policy: pin.mode must be "pin"`);
    if (typeof pin.runtime !== "string" || pin.runtime === "") throw new TypeError(`${layer} policy: pin.runtime is required`);
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
  /** @type {PolicyDeclaration | undefined} */
  let floor;
  /** @type {PolicyDeclaration | undefined} */
  let pin;
  /** @type {object[]} */
  const shadowed = [];
  /** @type {Record<string, unknown>} */
  const preferences = {};
  /** @type {Record<string, string>} */
  const provenance = {};
  /** @type {string | undefined} */
  let pinLayer;

  for (const layer of POLICY_LAYERS) {
    const declarations = layers[layer];
    if (declarations === undefined || declarations === null) continue;
    assertLayer(layer, declarations);

    if (declarations.floor !== undefined) {
      const winner = strongerFloor(floor, declarations.floor);
      // Record the layer only when this one actually raised the floor, so the
      // provenance names the layer whose value is in force.
      if (winner === declarations.floor && winner !== floor) provenance.floor = layer;
      floor = winner;
    }

    if (declarations.pin !== undefined) {
      if (pin !== undefined) {
        shadowed.push({
          layer: pinLayer,
          declaration: pin,
          reason: `superseded by the ${layer} pin, which is the more specific declaration`,
        });
      }
      pin = declarations.pin;
      pinLayer = layer;
      provenance.pin = layer;
    }

    for (const [key, value] of Object.entries(declarations.preferences ?? {})) {
      if (key.startsWith("$")) continue;
      preferences[key] = value;
      provenance[`preferences.${key}`] = layer;
    }
  }

  /** @type {Record<string, unknown>} */
  const merged = { preferences, shadowed, provenance };
  if (floor !== undefined) merged.floor = floor;
  if (pin !== undefined) merged.pin = pin;
  return merged;
}
