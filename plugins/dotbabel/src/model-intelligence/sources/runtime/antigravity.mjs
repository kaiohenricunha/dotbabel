/**
 * model-intelligence/sources/runtime/antigravity — the Antigravity CLI (`agy`) runtime source adapter
 * (P-22c, docs/specs/model-intelligence §5 `Source Adapter Contract`).
 *
 * Measured on agy 1.4.2 (2026-10-22) and in DOC-2 (1.2.5):
 *
 * - `agy models` printed `id<TAB>label` rows on 1.2.5, with no machine-readable option. On 1.4.2 a
 *   credential-free run exits 1 with "Please sign in to view available models", so discovery is
 *   `unverified`: the parser follows DOC-2's recorded grammar, and a refusal is `unavailable`, never an
 *   empty catalog. The id suffix is not an effort field (DOC-2), so no per-model effort is inferred.
 * - `--model` and `--effort (low|medium|high|xhigh|max)` are session flags in `agy --help`.
 * - Skill and agent model/effort binding stay `unverified` (Phase 0: binary strings only; live tests
 *   need a credential, which this adapter never uses).
 * - One `agy models` run writes dozens of files under `~/.gemini`, so every run uses a scratch home.
 */

import { checkOpaqueValue } from "../../domain/index.mjs";
import { assertDescriptor, deepFreeze, isPlainObject, makeAdapterResult } from "../contract.mjs";
import { makeDiscoveryEvidence, makeModelFact } from "../evidence.mjs";
import { renderInvocationFor, runtimeProvenance, unknownResult, withSourceVersion } from "./adapter-kit.mjs";
import { firstLine, probeVersion, resolveContext, runIsolated } from "./process.mjs";

/** The `RUNTIMES` id this adapter serves, and the `sourceId` of every result it returns. */
export const RUNTIME_ID = "antigravity";

/** Stamped into provenance as `adapterVersion`. Bump it when the adapter's behavior or evidence shape changes. */
export const ADAPTER_VERSION = "1";

const ROOT = Object.freeze({ rootEnvVar: "GEMINI_HOME", rootDirName: ".gemini" });

/** The 1.4.2 refusal when no account is signed in. */
const SIGN_IN_RE = /please sign in/i;

/** The adapter's declared capabilities. An unsupported operation omits every operational key. */
export const descriptor = deepFreeze(
  assertDescriptor({
    id: RUNTIME_ID,
    kind: "runtime",
    capabilities: {
      discovery: { support: "unverified", network: "required", auth: "none", cacheable: true, execution: "read-only" },
      observation: { support: "unsupported" },
      binding: {
        skill: { support: "unverified", axes: { model: "unverified", reasoning: "unverified" } },
        agent: { support: "unverified", axes: { model: "unverified", reasoning: "unverified" } },
      },
      invocation: { support: "supported", axes: { model: "supported", reasoning: "supported" } },
      validation: { support: "unsupported" },
    },
  }),
);

/** The provenance every result from this adapter starts from. */
const baseProvenance = () => runtimeProvenance(RUNTIME_ID, ADAPTER_VERSION);

/**
 * Parse `agy models` output by DOC-2's grammar: one TAB between an opaque id and a human label.
 * Blank lines are ignored; a row without exactly one TAB, with a blank or unsafe id, or a duplicate is
 * skipped and counted, never repaired.
 * @param {string} text
 * @returns {{models: object[], skipped: number}}
 */
export function parseModels(text) {
  const seen = new Set();
  const models = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    const id = fields[0]?.trim();
    const label = fields[1]?.trim();
    if (fields.length !== 2 || !id || !label || !checkOpaqueValue("model", id) || seen.has(id)) { skipped += 1; continue; }
    seen.add(id);
    models.push(makeModelFact({ id, displayName: label, selectionVisibility: "listed", supportedReasoningLevels: [] }));
  }
  return { models, skipped };
}

/**
 * Discover the models `agy models` lists, in a scratch home with no credential.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function discover(context) {
  const ctx = resolveContext(context, ROOT);
  const provenance = baseProvenance();
  const ran = /** @type {any} */ (await runIsolated(ctx, { prefix: "mi-agy", command: "agy", args: ["models"], ...ROOT, provenance }));
  if (ran.status !== "ok") return ran;
  const outcome = ran.evidence;
  if (outcome.exitCode !== 0 && !outcome.stoppedEarly) {
    const signIn = SIGN_IN_RE.test(outcome.stderr);
    return makeAdapterResult({ status: "unavailable", provenance, observedAt: ctx.now(), diagnostic: signIn
      ? { code: "sign_in_required", message: "agy lists models only for a signed-in account, and this adapter never uses a credential" }
      : { code: "nonzero_exit", message: firstLine(outcome.stderr) || `agy models exited ${outcome.exitCode}` } });
  }
  if (outcome.truncated) return unknownResult(ctx, provenance, "malformed_output", "the model list exceeded the size limit and was cut off");
  const parsed = parseModels(outcome.stdout);
  if (parsed.models.length === 0) return unknownResult(ctx, provenance, "empty_output", "agy models printed no usable rows, so support cannot be determined");
  const version = await probeVersion(ctx, { prefix: "mi-agy", command: "agy", ...ROOT, provenance });
  return makeAdapterResult({ status: "ok", evidence: makeDiscoveryEvidence(parsed), provenance: withSourceVersion(provenance, version), observedAt: ctx.now() });
}

/**
 * Build an unsupported result without starting a process.
 * @param {object} context
 * @param {string} message
 * @returns {object}
 */
function unsupported(context, message) {
  const ctx = resolveContext(context, ROOT);
  return makeAdapterResult({ status: "unsupported", provenance: baseProvenance(), observedAt: ctx.now(), diagnostic: { code: "credential_required", message } });
}

/**
 * The effective model is reported only after a signed-in turn, which this adapter never runs.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function observe(context) {
  return unsupported(context, "agy reports the effective model only after a signed-in turn");
}

/**
 * agy reaches authentication before it validates a model value (DOC-2).
 * @param {{model?: string, reasoning?: string}} input
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function validate(input, context) {
  const value = /** @type {any} */ (input);
  if (!isPlainObject(value) || (value.model === undefined && value.reasoning === undefined)) {
    throw new TypeError("antigravity validate: input must name a model or a reasoning value");
  }
  return unsupported(context, "agy authenticates before it validates a model value");
}

/** Emitted in this order; both are session flags of `agy`. */
const INVOCATION_AXIS_ARGS = Object.freeze({
  model: (value) => ["--model", value],
  reasoning: (value) => ["--effort", value],
});

/**
 * Render a resolved configuration as structured agy arguments (ARCH-47). Any other axis is named in
 * `unsupportedAxes` (ARCH-49). Nothing is executed and no shell string is built. Throws on an invalid
 * axis value, a caller error to fix before rendering.
 * @param {{runtimeId: string, axes: Record<string, unknown>}} resolvedConfig
 * @returns {Readonly<import("../evidence.mjs").Invocation>}
 */
export function renderInvocation(resolvedConfig) {
  return renderInvocationFor({ runtimeId: RUNTIME_ID, command: "agy", resolvedConfig, axisArgs: INVOCATION_AXIS_ARGS });
}
