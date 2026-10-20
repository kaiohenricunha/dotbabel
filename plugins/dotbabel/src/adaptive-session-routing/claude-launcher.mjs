/** Session-only native Claude UI launcher. No global configuration, permission or agent edit. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, constants as osConstants } from "node:os";
import { join } from "node:path";
import { readProjectActivation } from "../model-intelligence/activation/index.mjs";
import { checkOpaqueValue } from "../model-intelligence/domain/index.mjs";
import { openClaudeRoutingBridge } from "./claude-bridge.mjs";

const fail = code => Object.assign(Error(code), { code });
const executeFile = promisify(execFile);
/** Read bounded native metadata only. @param {Function} [execute] Trusted execFile seam. @returns {Promise<string|undefined>} Exact release or unknown. */
export async function readClaudeVersion(execute = executeFile) {
  try { const result = await execute("claude", ["--version"], { timeout: 5000, maxBuffer: 4096 }); return /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(result.stdout.trim())?.[1]; }
  catch { throw fail("native_runtime_unavailable"); }
}
async function pluginFor(socketPath, manual) {
  const directory = await mkdtemp(join(tmpdir(), "dotbabel-cl-plugin-"));
  try {
    await mkdir(join(directory, ".claude-plugin")); await mkdir(join(directory, "hooks"));
    await writeFile(join(directory, ".claude-plugin/plugin.json"), JSON.stringify({ name: "dotbabel-adaptive-session-routing", version: "0.1.0", description: "Project opt-in MAIN model and effort routing", author: { name: "dotbabel" } }), { mode: 0o600 });
    await writeFile(join(directory, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.js"] }), { mode: 0o600 });
    for (const name of ["claude-mod.mjs", "claude-mod-prepare.mjs"]) await writeFile(join(directory, "hooks", name), await readFile(new URL(name, import.meta.url)), { mode: 0o600 });
    const entry = `import { registerClaudeRouting } from "./claude-mod.mjs";\nexport function register(on) { registerClaudeRouting(on, ${JSON.stringify({ socketPath, manual, freshSession: true })}); }\n`;
    await writeFile(join(directory, "hooks/register.js"), entry, { mode: 0o600 });
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
/**
 * Own one native terminal process without replay, shell interpretation or a second Ctrl-C.
 * @param {{args:string[],cwd:string}} options Trusted native arguments and project directory.
 * @param {Function} [spawnProcess] Trusted process seam; never selected by project configuration.
 * @returns {Promise<number>} Native exit code or conventional signal exit code.
 */
export async function startClaudeNative({ args, cwd }, spawnProcess = spawn) {
  const child = spawnProcess("claude", args, { cwd, stdio: "inherit", shell: false });
  // The terminal already delivers Ctrl-C to the child. Do not send a second interrupt.
  const interrupt = () => {};
  const terminate = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  try { return await new Promise((resolve, reject) => { child.once("error", () => reject(fail("native_runtime_unavailable"))); child.once("close", (code, signal) => resolve(code ?? 128 + (osConstants.signals[signal] ?? 15))); }); }
  finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
}

/**
 * Launch the native interactive CLI with one private, session-only Mods plugin. Standard input,
 * attachments, history, approvals, sandbox and existing subagents stay with native Claude Code.
 * Auto releases each axis explicitly; omitted values preserve native initial provenance. Only the
 * measured 2.1.302 contract is enabled. Temporary plugin and IPC are removed after native exit.
 * @param {{repoRoot:string,model?:string,effort?:string}} options Explicit project and optional axes.
 * @param {{readActivation?:Function,runtimeVersion?:Function,startNative?:Function}} [dependencies] Trusted test seams.
 * @returns {Promise<number>} Native process exit code, without an automatic restart or replay.
 */
export async function runClaudeTerminal(options, dependencies = {}) {
  const activation = await (dependencies.readActivation ?? readProjectActivation)(options.repoRoot);
  if (activation.enabled !== true || activation.routingEnabled !== true) throw fail("routing_disabled");
  const args = []; const manual = {};
  for (const [axis, flag, value] of [["model", "--model", options.model], ["reasoning", "--effort", options.effort]]) {
    if (value !== undefined && (typeof value !== "string" || !checkOpaqueValue(axis, value))) throw fail("session_axis_invalid");
    manual[axis] = value === "auto" ? { source: "inherited" } : value === undefined ? { source: "native-initial" } : { source: "manual", value };
    if (value !== undefined && value !== "auto") args.push(flag, value);
  }
  if (await (dependencies.runtimeVersion ?? readClaudeVersion)() !== "2.1.302") throw fail("routing_unverified");
  const bridge = await openClaudeRoutingBridge(); let plugin;
  try {
    plugin = await pluginFor(bridge.socketPath, manual);
    return await (dependencies.startNative ?? startClaudeNative)({ args: ["--plugin-dir", plugin, ...args], cwd: options.repoRoot, socketPath: bridge.socketPath });
  } finally { if (plugin) await rm(plugin, { recursive: true, force: true }); await bridge.close(); }
}
