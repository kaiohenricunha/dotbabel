/** `dotbabel models route`: the persistent Claude plugin's one-shot local transport. */
import { handleRoutingInput, ROUTING_INPUT_INVALID, ROUTING_INPUT_MAXIMUM } from "./claude-bridge.mjs";
import { openClaudeSessionCache } from "./claude-session-cache.mjs";
import { createClaudeSessionInputLoader } from "../model-intelligence/cli/claude-session-input.mjs";

const invalid = { ok: false, body: ROUTING_INPUT_INVALID };

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
  for await (const chunk of stdin) { bytes += chunk.length; if (bytes > ROUTING_INPUT_MAXIMUM) return invalid; chunks.push(chunk); }
  let input;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { return invalid; }
  const store = openClaudeSessionCache({ session: input?.session, claudeVersion: input?.request?.runtimeVersion, env });
  // Built on first use, so an activation check never reads the release snapshot.
  let loader;
  const load = (root, native) => (loader ??= createClaudeSessionInputLoader({ ...loaderOptions, store })).load(root, native);
  const handled = await handleRoutingInput(input, { load });
  return handled.code === 200 ? { ok: true, body: handled.body } : invalid;
}
