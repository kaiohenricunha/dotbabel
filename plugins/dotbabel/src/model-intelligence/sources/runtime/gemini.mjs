/**
 * model-intelligence/sources/runtime/gemini — the Gemini CLI runtime source adapter (P-22a,
 * docs/specs/model-intelligence §5 `Source Adapter Contract`).
 *
 * Gemini CLI offers almost nothing a credential-free adapter can measure, and this adapter claims
 * only what was measured (DOC-2, re-checked on 0.64.0):
 *
 * - No command enumerates models, so discovery is unsupported rather than an empty list.
 * - Authentication comes before any model handling: an unknown model is not rejected client-side,
 *   so neither observation nor validation can run without a credential, which this adapter never uses.
 * - `-m/--model` selects the model. There is no user-facing effort flag; thinking budgets are internal
 *   configuration, so the reasoning axis is unsupported for invocation.
 * - Skill `model` and `effort` frontmatter is IGNORED: the skill listing exposes neither field.
 *
 * Every operation is pure: the adapter starts no process, so it cannot write under the runtime
 * configuration root (SEC-1). Even `gemini --help` writes under `~/.gemini`, which is why nothing here
 * runs it; the Tier 2 integration test measures the CLI under a scratch home instead.
 */

import { assertDescriptor, deepFreeze, isPlainObject, makeAdapterResult } from "../contract.mjs";
import { renderInvocationFor, runtimeProvenance } from "./adapter-kit.mjs";
import { resolveContext } from "./process.mjs";

/** The `RUNTIMES` id this adapter serves, and the `sourceId` of every result it returns. */
export const RUNTIME_ID = "gemini";

/** Stamped into provenance as `adapterVersion`. Bump it when the adapter's behavior or evidence shape changes. */
export const ADAPTER_VERSION = "1";

const ROOT = Object.freeze({ rootEnvVar: "GEMINI_HOME", rootDirName: ".gemini" });

/** The adapter's declared capabilities. An unsupported operation omits every operational key. */
export const descriptor = deepFreeze(
  assertDescriptor({
    id: RUNTIME_ID,
    kind: "runtime",
    capabilities: {
      discovery: { support: "unsupported" },
      observation: { support: "unsupported" },
      binding: {
        skill: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } },
      },
      invocation: { support: "supported", axes: { model: "supported", reasoning: "unsupported" } },
      validation: { support: "unsupported" },
    },
  }),
);

/** The provenance every result from this adapter starts from. */
const baseProvenance = () => runtimeProvenance(RUNTIME_ID, ADAPTER_VERSION);

/**
 * Build an unsupported result without starting a process.
 * @param {object} context
 * @param {string} code
 * @param {string} message
 * @returns {object}
 */
function unsupported(context, code, message) {
  const ctx = resolveContext(context, ROOT);
  return makeAdapterResult({ status: "unsupported", provenance: baseProvenance(), observedAt: ctx.now(), diagnostic: { code, message } });
}

/**
 * Gemini CLI exposes no command that enumerates models.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function discover(context) {
  return unsupported(context, "no_enumeration", "Gemini CLI exposes no command that enumerates models");
}

/**
 * The effective model is reported only after an authenticated turn, which this adapter never runs.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function observe(context) {
  return unsupported(context, "credential_required", "Gemini CLI reports the effective model only after an authenticated turn");
}

/**
 * Gemini CLI reaches authentication before it handles a model value, so a credential-free probe cannot
 * tell a known model from an unknown one.
 * @param {{model?: string, reasoning?: string}} input
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function validate(input, context) {
  const value = /** @type {any} */ (input);
  if (!isPlainObject(value) || (value.model === undefined && value.reasoning === undefined)) {
    throw new TypeError("gemini validate: input must name a model or a reasoning value");
  }
  return unsupported(context, "credential_required", "Gemini CLI authenticates before it validates a model value");
}

/** Emitted in this order. The reasoning axis has no CLI flag, so `renderInvocationFor` reports it unsupported. */
const INVOCATION_AXIS_ARGS = Object.freeze({
  model: (value) => ["-m", value],
});

/**
 * Render a resolved configuration as structured Gemini CLI arguments (ARCH-47). The model becomes `-m`.
 * Any other axis is named in `unsupportedAxes` rather than dropped (ARCH-49). Nothing is executed and no
 * shell string is built. Throws on an invalid axis value, a caller error to fix before rendering.
 * @param {{runtimeId: string, axes: Record<string, unknown>}} resolvedConfig
 * @returns {Readonly<import("../evidence.mjs").Invocation>}
 */
export function renderInvocation(resolvedConfig) {
  return renderInvocationFor({ runtimeId: RUNTIME_ID, command: "gemini", resolvedConfig, axisArgs: INVOCATION_AXIS_ARGS });
}
