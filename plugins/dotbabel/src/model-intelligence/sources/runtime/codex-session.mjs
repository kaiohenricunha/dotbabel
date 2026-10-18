/** Bounded Codex transcript configuration observation; no inference outcome is invented. */
import { isPlainObject, makeAdapterResult } from "../contract.mjs";
import { makeObservedConfiguration, optionalIdentifier, toProviderId } from "../evidence.mjs";
import { runtimeVersionField, withSourceVersion } from "./adapter-kit.mjs";
import { MAX_OUTPUT_BYTES } from "./process.mjs";

/**
 * Observe explicit session metadata through the runtime adapter's stream contract.
 * Turn-context axes are requested configuration, so their basis remains reconstructed.
 * @param {unknown} text Caller-supplied bounded JSONL, never a path or command.
 * @param {{observedAt:string,provenance:object}} context Caller-owned clock and adapter provenance.
 * @returns {object} Adapter result containing only typed configuration metadata.
 */
export function observeCodexSession(text, { observedAt, provenance }) {
  const unknown = code => makeAdapterResult({ status: "unknown", provenance, observedAt, diagnostic: { code, message: "The transcript does not contain a usable bounded configuration observation." } });
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) return unknown("malformed_output");
  let meta = {}, turn = {}, executed = false, malformed = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { malformed = true; continue; }
    if (!isPlainObject(event)) { malformed = true; continue; }
    if (event.type === "session_meta") { meta = isPlainObject(event.payload) ? event.payload : {}; turn = {}; executed = false; }
    if (event.type === "turn_context") { turn = isPlainObject(event.payload) ? event.payload : {}; executed = false; }
    if (event.type === "response_item" && event.payload?.type === "message" && event.payload.role === "assistant") executed = true;
  }
  const model = optionalIdentifier(turn.model), reasoning = optionalIdentifier(turn.effort);
  const provider = toProviderId("codex", optionalIdentifier(meta.model_provider));
  const axes = { ...(model === undefined ? {} : { model }), ...(reasoning === undefined ? {} : { reasoning }) };
  const fieldSources = { ...(model === undefined ? {} : { "axes.model": "turn_context.model" }), ...(reasoning === undefined ? {} : { "axes.reasoning": "turn_context.effort" }), ...(provider === undefined ? {} : { provider: "session_meta.model_provider" }) };
  if (Object.keys(fieldSources).length === 0) return unknown(malformed ? "malformed_output" : text.trim() ? "insufficient_evidence" : "empty_output");
  const version = runtimeVersionField(meta.cli_version);
  const evidence = makeObservedConfiguration({ runtimeId: "codex", turnExecuted: executed, configurationBasis: "reconstructed", reconstructedFrom: Object.keys(fieldSources), axes, ...(provider === undefined ? {} : { provider }), fieldSources, ...version });
  return makeAdapterResult({ status: "ok", evidence, observedAt, provenance: withSourceVersion(provenance, version.runtimeVersion) });
}
