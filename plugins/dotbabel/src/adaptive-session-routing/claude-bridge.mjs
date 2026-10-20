/** Private session-local IPC. The native mod retains authorization and performs provider metadata GETs. */
import http from "node:http";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { prepareRoute } from "./prepare.mjs";
import { createClaudeSessionInputLoader, VERIFIED_CLAUDE_MAIN_VERSIONS } from "../model-intelligence/cli/claude-session-input.mjs";
import { readProjectActivation } from "../model-intelligence/activation/index.mjs";
import { route } from "./route.mjs";

const maximum = 1048576;
const answer = (response, code, body) => { response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
const errorBody = { diagnostics: [{ code: "session_input_invalid" }] };
function valid(input) {
  const request = input?.request;
  return request && typeof request.repoRoot === "string" && request.repoRoot.length <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(request.repoRoot) && isAbsolute(request.repoRoot) && typeof request.prompt === "string" && request.prompt.length <= 16384 && typeof request.runtimeVersion === "string";
}

/**
 * Open an owner-only Unix socket in a newly created private directory. Accept only a bounded
 * preparation request, never a command, file path to execute, credential, native approval or turn.
 * Every request rechecks project activation before classification or capability work. Policies are
 * loaded per project. No prompt, policy or result is persisted or logged. Closing is idempotent.
 * @param {{readActivation?:Function,classify?:Function,loadResolverInput?:Function}} [dependencies] Trusted test seams.
 * @returns {Promise<{socketPath:string,close:Function}>} Private local endpoint and cleanup.
 */
export async function openClaudeRoutingBridge(dependencies = {}) {
  if (process.platform === "win32") throw Object.assign(Error("routing_unsupported"), { code: "routing_unsupported" });
  const directory = await mkdtemp(join(tmpdir(), "dotbabel-cl-"));
  const socketPath = join(directory, "bridge.sock");
  const loader = dependencies.loadResolverInput ? undefined : createClaudeSessionInputLoader();
  const load = dependencies.loadResolverInput ?? loader.load;
  let closed = false;
  const server = http.createServer((request, response) => {
    response.on("error", () => { /* A disconnected local caller receives no retry. */ });
    if (request.method !== "POST" || request.url !== "/prepare") { answer(response, 404, errorBody); request.resume(); return; }
    const chunks = []; let bytes = 0; let invalid = false;
    request.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maximum) { invalid = true; chunks.length = 0; }
      else if (!invalid) chunks.push(chunk);
    });
    request.on("error", () => { if (!response.headersSent) answer(response, 400, errorBody); });
    request.on("end", async () => {
      let input;
      try {
        if (invalid) throw Error();
        input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!valid(input) || ![undefined, "activation", "prepare"].includes(input.action)) throw Error();
      } catch { answer(response, 400, errorBody); return; }
      let sourceFailure;
      try {
        const { runtimeVersion, ...routingRequest } = input.request;
        const support = VERIFIED_CLAUDE_MAIN_VERSIONS.includes(runtimeVersion) ? "supported" : "unverified";
        if (input.action === "activation") {
          const activation = await (dependencies.readActivation ?? readProjectActivation)(routingRequest.repoRoot);
          if (activation.enabled !== true || activation.routingEnabled !== true || support !== "supported") answer(response, 200, { decision: route({ activation, runtimeCapability: { support } }) });
          else answer(response, 200, { ready: true });
          return;
        }
        const decision = await prepareRoute({ ...routingRequest, runtimeCapability: { support, axes: { model: support, reasoning: support } } }, {
          readActivation: dependencies.readActivation,
          classify: dependencies.classify,
          loadResolverInput: async root => {
            try { return await load(root, input.native); }
            catch (error) { sourceFailure = error.code; throw error; }
          },
        });
        if (sourceFailure === "native_catalog_required") answer(response, 200, { needsEvidence: true });
        else {
          if (["routing_unverified", "native_catalog_invalid", "native_catalog_unavailable", "session_project_limit"].includes(sourceFailure)) decision.diagnostics.push({ code: sourceFailure });
          answer(response, 200, { decision });
        }
      } catch { answer(response, 200, { decision: { status: "preserved", diagnostics: [{ code: "routing_preparation_failed" }] } }); }
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.timeout = 15000;
  server.maxConnections = 4;
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return { socketPath, async close() {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  } };
}
