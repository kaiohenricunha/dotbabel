/**
 * model-intelligence/sources/runtime/copilot — the GitHub Copilot CLI runtime source adapter (P-22b,
 * docs/specs/model-intelligence §5 `Source Adapter Contract`).
 *
 * Measured on Copilot CLI 1.0.98 (2026-10-22), in DOC-2 and in Phase 0 (RQ-3):
 *
 * - `copilot help config` lists accepted `model` values as quoted items in human help text. It needs
 *   no credential, but the text is documentation for people, not a machine contract, so discovery is
 *   `unverified`, and the list proves neither availability nor entitlement.
 * - `--model <model>` and `--reasoning-effort <none|minimal|low|medium|high|xhigh|max>` are CLI flags.
 * - Phase 0: a custom-agent `model` key exists in the schema with no run-time test (unverified); agents
 *   have no effort key; skills and instructions ignore model/effort; the CLI does not read `.prompt.md`.
 * - Observation and validation need a signed-in account, which this adapter never uses. Even `help`
 *   writes hundreds of files under the Copilot home, so every run uses a scratch home.
 */

import { checkOpaqueValue } from "../../domain/index.mjs";
import { assertDescriptor, deepFreeze, isPlainObject, makeAdapterResult } from "../contract.mjs";
import { makeDiscoveryEvidence, makeModelFact } from "../evidence.mjs";
import { renderInvocationFor, runtimeProvenance, unknownResult, withSourceVersion } from "./adapter-kit.mjs";
import { firstLine, probeVersion, resolveContext, runIsolated } from "./process.mjs";

/** The `RUNTIMES` id this adapter serves, and the `sourceId` of every result it returns. */
export const RUNTIME_ID = "copilot";

/** Stamped into provenance as `adapterVersion`. Bump it when the adapter's behavior or evidence shape changes. */
export const ADAPTER_VERSION = "1";

const ROOT = Object.freeze({ rootEnvVar: "COPILOT_HOME", rootDirName: ".copilot" });

/** The `model` key line of `copilot help config`, and one quoted item under it. */
const MODEL_KEY_RE = /^ {2}`model`:/;
const ITEM_RE = /^ {4}- "([^"]*)"$/;

/** The adapter's declared capabilities. An unsupported operation omits every operational key. */
export const descriptor = deepFreeze(
  assertDescriptor({
    id: RUNTIME_ID,
    kind: "runtime",
    capabilities: {
      discovery: { support: "unverified", network: "never", auth: "none", cacheable: true, execution: "read-only" },
      observation: { support: "unsupported" },
      binding: {
        agent: { support: "unverified", axes: { model: "unverified", reasoning: "unsupported" } },
        skill: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } },
        command: { support: "unsupported", axes: { model: "unsupported", reasoning: "unsupported" } },
      },
      invocation: { support: "supported", axes: { model: "supported", reasoning: "supported" } },
      validation: { support: "unsupported" },
    },
  }),
);

/** The provenance every result from this adapter starts from. */
const baseProvenance = () => runtimeProvenance(RUNTIME_ID, ADAPTER_VERSION);

/**
 * Read the quoted items directly under the `model` key of `copilot help config`. The list ends at the
 * first line that is not a quoted item. A duplicate or an unsafe id is skipped and counted.
 * @param {string} text
 * @returns {{ids: string[], skipped: number}}
 */
export function parseHelpModels(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => MODEL_KEY_RE.test(line));
  if (start === -1) return { ids: [], skipped: 0 };
  const ids = [];
  let skipped = 0;
  for (const line of lines.slice(start + 1)) {
    const item = ITEM_RE.exec(line);
    if (item === null) break;
    if (!checkOpaqueValue("model", item[1]) || ids.includes(item[1])) { skipped += 1; continue; }
    ids.push(item[1]);
  }
  return { ids, skipped };
}

/**
 * Discover the model values `copilot help config` documents, in a scratch home with no credential.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function discover(context) {
  const ctx = resolveContext(context, ROOT);
  const provenance = baseProvenance();
  const ran = /** @type {any} */ (await runIsolated(ctx, { prefix: "mi-copilot", command: "copilot", args: ["help", "config"], ...ROOT, provenance }));
  if (ran.status !== "ok") return ran;
  const outcome = ran.evidence;
  if (outcome.exitCode !== 0 && !outcome.stoppedEarly) {
    return makeAdapterResult({ status: "unavailable", provenance, observedAt: ctx.now(), diagnostic: { code: "nonzero_exit", message: firstLine(outcome.stderr) || `copilot help config exited ${outcome.exitCode}` } });
  }
  if (outcome.truncated) return unknownResult(ctx, provenance, "malformed_output", "the help text exceeded the size limit and was cut off");
  const parsed = parseHelpModels(outcome.stdout);
  if (parsed.ids.length === 0) return unknownResult(ctx, provenance, "model_list_absent", "copilot help config documents no model values, so support cannot be determined");
  const models = parsed.ids.map((id) => makeModelFact({ id, selectionVisibility: "listed", supportedReasoningLevels: [] }));
  const version = await probeVersion(ctx, { prefix: "mi-copilot", command: "copilot", ...ROOT, provenance });
  return makeAdapterResult({ status: "ok", evidence: makeDiscoveryEvidence({ models, skipped: parsed.skipped }), provenance: withSourceVersion(provenance, version), observedAt: ctx.now() });
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
 * The effective model is reported only in a signed-in session, which this adapter never starts.
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function observe(context) {
  return unsupported(context, "Copilot CLI reports the effective model only in a signed-in session");
}

/**
 * Copilot CLI reaches authentication before it validates a model value (DOC-2).
 * @param {{model?: string, reasoning?: string}} input
 * @param {object} [context]
 * @returns {Promise<object>}
 */
export async function validate(input, context) {
  const value = /** @type {any} */ (input);
  if (!isPlainObject(value) || (value.model === undefined && value.reasoning === undefined)) {
    throw new TypeError("copilot validate: input must name a model or a reasoning value");
  }
  return unsupported(context, "Copilot CLI authenticates before it validates a model value");
}

/** Emitted in this order; both are CLI flags of `copilot`. */
const INVOCATION_AXIS_ARGS = Object.freeze({
  model: (value) => ["--model", value],
  reasoning: (value) => ["--reasoning-effort", value],
});

/**
 * Render a resolved configuration as structured Copilot CLI arguments (ARCH-47). Any other axis is named
 * in `unsupportedAxes` (ARCH-49). Nothing is executed and no shell string is built. Throws on an invalid
 * axis value, a caller error to fix before rendering.
 * @param {{runtimeId: string, axes: Record<string, unknown>}} resolvedConfig
 * @returns {Readonly<import("../evidence.mjs").Invocation>}
 */
export function renderInvocation(resolvedConfig) {
  return renderInvocationFor({ runtimeId: RUNTIME_ID, command: "copilot", resolvedConfig, axisArgs: INVOCATION_AXIS_ARGS });
}
