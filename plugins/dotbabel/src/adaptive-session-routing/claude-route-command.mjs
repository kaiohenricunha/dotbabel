/** `dotbabel models route`: the persistent Claude plugin's one-shot local transport. */
import { handleRoutingInput } from "./claude-bridge.mjs";
import { openClaudeSessionCache } from "./claude-session-cache.mjs";
import { createClaudeSessionInputLoader } from "../model-intelligence/cli/claude-session-input.mjs";

const maximum = 1048576;
const invalid = { ok: false, body: { diagnostics: [{ code: "session_input_invalid" }] } };

/**
 * Answer one Claude routing request read from a stream (adaptive-session-routing §5). The request never
 * travels in argv, so a prompt is not visible in the process list. The answer is the one the launcher's
 * private socket gives. A valid native session id selects that session's verified catalog cache, so
 * later turns need no new runtime probes.
 * @param {AsyncIterable<Buffer>} stdin Request stream; at most 1 MiB of UTF-8 JSON.
 * @param {{env?:NodeJS.ProcessEnv, loaderOptions?:object}} [options] Cache location and trusted loader seams.
 * @returns {Promise<{ok:boolean, body:object}>} `ok: false` is a usage error.
 */
export async function runClaudeRoute(stdin, { env = process.env, loaderOptions = {} } = {}) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stdin) { bytes += chunk.length; if (bytes > maximum) return invalid; chunks.push(chunk); }
  let input;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return invalid; }
  const store = openClaudeSessionCache({ session: input?.session, claudeVersion: input?.request?.runtimeVersion, env });
  const handled = await handleRoutingInput(input, { load: createClaudeSessionInputLoader({ ...loaderOptions, store }).load });
  return handled.code === 200 ? { ok: true, body: handled.body } : invalid;
}
