/**
 * host-adapter — the seam between `dotbabel fleet` and the CLI that hosts a
 * session. The fleet needs six things from a host: who runs this process
 * (`identity`), whether a session is still alive (`liveness`), and four hook
 * points (`preEdit`, `preBash`, `postTool`, `sessionStart`). Each host
 * declares every one as `supported`, `unsupported`, or `unverified`, and
 * `unverified` never counts as `supported` (ARCH-4). A fleet feature that
 * needs an unsupported capability is off for that host.
 *
 * Each capability uses the operation-capability shape of the Model
 * Intelligence spec (`docs/specs/model-intelligence/spec/5-interfaces-apis.md`,
 * "Operation capability"): the support state, whether it needs the network
 * or existing credentials, whether its answer can be cached, and whether it
 * may execute a model. Here every capability is local, needs no credentials,
 * is never cached, and executes no model.
 *
 * Claude Code is the one adapter today; its implementation is
 * `registry.mjs`, which this module imports and which never imports this one.
 * Every other CLI that `agents.mjs` knows reports every capability as
 * unsupported until the Phase 2 research verifies it. The fleet bin selects
 * identity and liveness through this seam. Lower-level process readers keep
 * the Claude registry backend until another identity store is verified.
 */

import { RUNTIMES } from "../agents.mjs";
import { findSelf, isOwnerAlive, readRegistry, sessionsDir } from "./registry.mjs";

/** The capabilities a host adapter declares, in the order the doctor prints them. */
export const HOST_CAPABILITIES = Object.freeze(["identity", "liveness", "preEdit", "preBash", "postTool", "sessionStart"]);

/** The support states, as the Model Intelligence descriptor defines them. */
export const SUPPORT_STATES = Object.freeze(["supported", "unsupported", "unverified"]);

/**
 * @typedef {"supported"|"unsupported"|"unverified"} SupportState
 *
 * @typedef {object} HostCapability
 * @property {SupportState} support
 * @property {"never"|"optional"|"required"} network
 * @property {"none"|"optional-existing"|"required-existing"} auth
 * @property {boolean} cacheable
 * @property {"read-only"|"may-execute-model"} execution
 * @property {string} evidence  where the state comes from
 *
 * @typedef {object} HostAdapter
 * @property {string} host   the runtime id, as `agents.mjs` names it
 * @property {string} label
 * @property {boolean} adapter  whether an implementation exists
 * @property {Record<string, HostCapability>} capabilities  one entry per HOST_CAPABILITIES name
 * @property {((args: { sessionId?: string, startPid?: number, env?: NodeJS.ProcessEnv, procRoot?: string }) => object|null)|null} identity
 *   the live session entry this process runs in, or null; null when unsupported
 * @property {((owner: { pid: number, procStart?: string|null }, opts?: { procRoot?: string }) => boolean)|null} isAlive
 *   whether a session still runs; null when unsupported
 */

/**
 * Only `supported` counts; `unverified` is evidence of nothing (ARCH-4).
 *
 * @param {unknown} state
 * @returns {boolean}
 */
export function isSupported(state) {
  return state === "supported";
}

/** @param {SupportState} support @param {string} evidence @returns {HostCapability} */
function local(support, evidence) {
  return { support, network: "never", auth: "none", cacheable: false, execution: "read-only", evidence };
}

const HOOKS = "docs/hooks.md: fleet-guard.sh";

/** @type {HostAdapter} */
const CLAUDE = Object.freeze({
  host: "claude",
  label: RUNTIMES.claude.label,
  adapter: true,
  capabilities: Object.freeze({
    identity: local("supported", "the session registry, ~/.claude/sessions/<pid>.json (registry.mjs findSelf)"),
    liveness: local("supported", "/proc on Linux, signal 0 elsewhere (registry.mjs isOwnerAlive)"),
    preEdit: local("supported", `${HOOKS} on PreToolUse for Edit, Write, MultiEdit, NotebookEdit`),
    preBash: local("supported", `${HOOKS} on PreToolUse for Bash, and fleet-shell-prefix.sh`),
    postTool: local("supported", `${HOOKS} on PostToolUse`),
    sessionStart: local("supported", `${HOOKS} on SessionStart`),
  }),
  identity: ({ sessionId, startPid = process.ppid, env = process.env, procRoot } = {}) =>
    findSelf({ entries: readRegistry(sessionsDir(env)).entries, sessionId, startPid, procRoot }),
  isAlive: (owner, opts = {}) => isOwnerAlive(owner, opts),
});

/**
 * The descriptor of a host with no adapter: every capability unsupported.
 *
 * @param {string} host
 * @param {string} label
 * @returns {HostAdapter}
 */
function withoutAdapter(host, label) {
  const evidence = "no host adapter yet; the Phase 2 research verifies this CLI";
  return {
    host,
    label,
    adapter: false,
    capabilities: Object.fromEntries(HOST_CAPABILITIES.map((name) => [name, local("unsupported", evidence)])),
    identity: null,
    isAlive: null,
  };
}

/**
 * The host adapter of a runtime id. Always a descriptor: a CLI without an
 * adapter, or an id `agents.mjs` does not know, reports every capability as
 * unsupported, so a caller never mistakes "no adapter" for "supported".
 *
 * @param {string} host
 * @returns {HostAdapter}
 */
export function hostAdapter(host) {
  if (host === "claude") return CLAUDE;
  const runtime = Object.values(RUNTIMES).find((r) => r.id === host);
  return withoutAdapter(host, runtime === undefined ? host : runtime.label);
}

/**
 * One descriptor per CLI that `agents.mjs` knows, in its order.
 *
 * @returns {HostAdapter[]}
 */
export function listHostAdapters() {
  return Object.values(RUNTIMES).map((runtime) => hostAdapter(runtime.id));
}

/**
 * The one-line report `dotbabel doctor` prints for a host.
 *
 * @param {HostAdapter} host
 * @returns {string}
 */
export function describeHostAdapter(host) {
  const head = `host ${host.host} (${host.label}): `;
  if (!host.adapter) return `${head}every capability unsupported — no host adapter yet, so the fleet is off for this host`;
  return head + HOST_CAPABILITIES.map((name) => `${name} ${host.capabilities[name].support}`).join(", ");
}
