/**
 * model-intelligence/sources/runtime/opencode — the OpenCode runtime source adapter (P-22d,
 * docs/specs/model-intelligence §5 `Source Adapter Contract`).
 *
 * Measured on OpenCode 2.0.5 (DOC-2, re-checked 2026-10-22):
 *
 * - `opencode models` prints newline-separated `provider/model` rows, exits 0 in every case, and is
 *   config- and account-scoped. Under an isolated home it prints ZERO lines with exit 0, so an empty
 *   result is `unknown`, never an empty catalog (ARCH-30). Discovery is therefore `unverified`: the
 *   parser follows DOC-2's recorded grammar, but a credential-free run cannot produce rows.
 * - Without a flag the command waits for the background service; `--standalone` starts a private
 *   server on loopback, so the run exempts loopback (and nothing else) from the dead proxy.
 * - `run --model provider/model#variant` selects the model. No flag sets effort; `--thinking` only
 *   shows thinking blocks. Skills ignore model/effort (Phase 0); an agent `model` key exists in the
 *   schema but has no run-time test, so it stays unverified.
 * - Observation and validation need a configured provider, which an isolated run never has.
 */

import { assertDescriptor, deepFreeze, isPlainObject, makeAdapterResult } from "../contract.mjs";
import { makeDiscoveryEvidence, makeModelFact } from "../evidence.mjs";
import { renderInvocationFor, runtimeProvenance, unknownResult, withSourceVersion } from "./adapter-kit.mjs";
import { firstLine, probeVersion, resolveContext, runIsolated } from "./process.mjs";

/** The `RUNTIMES` id this adapter serves, and the `sourceId` of every result it returns. */
export const RUNTIME_ID = "opencode";

/** Stamped into provenance as `adapterVersion`. Bump it when the adapter's behavior or evidence shape changes. */
export const ADAPTER_VERSION = "1";

const ROOT = Object.freeze({ rootEnvVar: "OPENCODE_CONFIG_DIR", rootDirName: ".config/opencode" });

/** One DOC-2 row: a provider id, exactly one slash, and a model id without a `#variant`. */
const ROW_RE = /^[a-z0-9][a-z0-9._-]*\/[^\s/#]+$/;

/** The adapter's declared capabilities. An unsupported operation omits every operational key. */
export const descriptor = deepFreeze(
  assertDescriptor({
    id: RUNTIME_ID,
    kind: "runtime",
    capabilities: {
      discovery: { support: "unverified", network: "never", auth: "none", cacheable: true, execution: "read-only" },
      observation: { support: "unsupported" },
      binding: {
        skill: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } },
        agent: { support: "unverified", axes: { model: "unverified", reasoning: "unsupported" } },
      },
      invocation: { support: "supported", axes: { model: "supported", reasoning: "unsupported" } },
      validation: { support: "unsupported" },
    },
  }),
);

/** The provenance every result from this adapter starts from. */
const baseProvenance = () => runtimeProvenance(RUNTIME_ID, ADAPTER_VERSION);

/**
 * Parse `opencode models` output by DOC-2's defensive rules. Blank lines are ignored; a malformed,
 * duplicated, or `#variant` row is skipped and counted, never repaired.
 * @param {string} text
 * @returns {{models: object[], skipped: number}}
 */
export function parseModels(text) {
  const seen = new Set();
  const models = [];
  let skipped = 0;
  for (const line of text.split("\n").map((row) => row.trim()).filter(Boolean)) {
    if (!ROW_RE.test(line) || seen.has(line)) { skipped += 1; continue; }
    seen.add(line);
    models.push(makeModelFact({ id: line, selectionVisibility: "listed", supportedReasoningLevels: [] }));
  }
  return { models, skipped };
}

/**
 * Discover the models an isolated OpenCode lists, through its private standalone server.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function discover(context) {
  const ctx = resolveContext(context, ROOT);
  const provenance = baseProvenance();
  const ran = /** @type {any} */ (await runIsolated(ctx, { prefix: "mi-opencode", command: "opencode", args: ["models", "--standalone"], ...ROOT, provenance, loopback: true }));
  if (ran.status !== "ok") return ran;
  const outcome = ran.evidence;
  if (outcome.exitCode !== 0 && !outcome.stoppedEarly) {
    return makeAdapterResult({ status: "unavailable", provenance, observedAt: ctx.now(), diagnostic: { code: "nonzero_exit", message: firstLine(outcome.stderr) || `opencode models exited ${outcome.exitCode}` } });
  }
  if (outcome.truncated) return unknownResult(ctx, provenance, "malformed_output", "the model list exceeded the size limit and was cut off");
  const parsed = parseModels(outcome.stdout);
  if (parsed.models.length === 0) {
    return unknownResult(ctx, provenance, "empty_output", "opencode models printed no usable rows; it exits 0 when no provider is configured, so support cannot be determined");
  }
  const version = await probeVersion(ctx, { prefix: "mi-opencode", command: "opencode", ...ROOT, provenance });
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
  return makeAdapterResult({ status: "unsupported", provenance: baseProvenance(), observedAt: ctx.now(), diagnostic: { code: "provider_required", message } });
}

/**
 * The effective model is known only after a turn against a configured provider.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function observe(context) {
  return unsupported(context, "OpenCode reports the effective model only after a turn against a configured provider");
}

/**
 * An isolated OpenCode has no provider, so it cannot tell a known model from an unknown one.
 * @param {{model?: string, reasoning?: string}} input
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function validate(input, context) {
  const value = /** @type {any} */ (input);
  if (!isPlainObject(value) || (value.model === undefined && value.reasoning === undefined)) {
    throw new TypeError("opencode validate: input must name a model or a reasoning value");
  }
  return unsupported(context, "OpenCode validates a model only against a configured provider");
}

/** `run` carries the model flag; the reasoning axis has no flag, so it is reported unsupported. */
const INVOCATION_AXIS_ARGS = Object.freeze({
  model: (value) => ["run", "--model", value],
});

/**
 * Render a resolved configuration as structured OpenCode arguments (ARCH-47): `opencode run --model
 * <provider/model>`. Any other axis is named in `unsupportedAxes` (ARCH-49). Nothing is executed and no
 * shell string is built. Throws on an invalid axis value, a caller error to fix before rendering.
 * @param {{runtimeId: string, axes: Record<string, unknown>}} resolvedConfig
 * @returns {Readonly<import("../evidence.mjs").Invocation>}
 */
export function renderInvocation(resolvedConfig) {
  return renderInvocationFor({ runtimeId: RUNTIME_ID, command: "opencode", resolvedConfig, axisArgs: INVOCATION_AXIS_ARGS });
}
