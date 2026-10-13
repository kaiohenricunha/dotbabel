/**
 * hook-registration — which shipped hooks a Claude Code settings file actually runs.
 *
 * `bootstrap.sh` links every hook into `~/.claude/hooks/`, but it never edits
 * `settings.json`, so an installed hook does nothing until someone registers
 * it. `dotbabel doctor` uses this module to make that gap visible.
 *
 * A registration is matched by the basename of a shipped script anywhere in
 * the command, so `$HOME/.claude/hooks/fleet-guard.sh pre-edit`, a
 * repository's own `.claude/hooks/fleet-guard.sh`, and
 * `timeout 10 ~/.claude/hooks/check-on-write.sh` all count. The check reads
 * three settings files only; it does not read managed settings, plugin hooks,
 * or `--settings`, and it does not check matchers.
 *
 * @typedef {"user"|"project"|"local"} SettingsScope
 *
 * @typedef {object} SettingsSource
 * @property {string} path
 * @property {SettingsScope} [scope]
 * @property {Record<string, unknown>} settings
 *
 * @typedef {object} SettingsReadError
 * @property {string} path
 * @property {string} message
 *
 * @typedef {object} RegisteredHook
 * @property {string} hook
 * @property {string[]} events   Events it is registered for, sorted.
 * @property {string[]} missing  Expected entries it is not registered for, in table order.
 * @property {SettingsScope[]} scopes  The scopes that register it, sorted.
 *
 * @typedef {object} UnregisteredHook
 * @property {string} hook
 * @property {string[]} expected
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The pseudo-event under which the shell prefix hook is registered. */
export const SHELL_PREFIX_EVENT = "CLAUDE_CODE_SHELL_PREFIX";

/**
 * The entries each shipped hook expects. An entry is an event, or
 * `Event:argument` when one script takes several entries that differ by the
 * argument after it: `fleet-guard.sh` needs two `PreToolUse` entries, and a
 * missing `pre-bash` must not hide behind a present `pre-edit`. Tests hold the
 * keys equal to `plugins/dotbabel/hooks/*.sh` and the events equal to the
 * table in `docs/hooks.md`.
 */
export const SHIPPED_HOOK_EVENTS = Object.freeze({
  "check-on-stop.sh": Object.freeze(["Stop"]),
  "check-on-write.sh": Object.freeze(["PostToolUse"]),
  "fleet-guard.sh": Object.freeze([
    "PreToolUse:pre-edit",
    "PreToolUse:pre-bash",
    "SessionStart:session-start",
    "PostToolUse:post-tool",
    "UserPromptSubmit:prompt",
  ]),
  "fleet-shell-prefix.sh": Object.freeze([SHELL_PREFIX_EVENT]),
  "guard-criteria-evidence.sh": Object.freeze(["PreToolUse"]),
  "guard-destructive-git.sh": Object.freeze(["PreToolUse"]),
  "task-context.sh": Object.freeze(["SessionStart"]),
  "yolo.sh": Object.freeze([
    "UserPromptExpansion:grant",
    "PermissionRequest:permission",
    "SessionEnd:session-end",
  ]),
});

const INTERPRETERS = new Set(["bash", "sh", "zsh", "env"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Claude Code event names are letters only. Any other key in `hooks` came from
// a file someone else may control, and is reported escaped, never printed raw.
const EVENT_NAME = /^[A-Za-z]+$/;
// Control and format characters, which can rewrite a terminal.
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/**
 * `text` with control and format characters replaced, safe to print.
 *
 * @param {string} text
 * @returns {string}
 */
export function printable(text) {
  return String(text).replace(CONTROL, "?");
}

/**
 * A human form of an expected entry: `PreToolUse:pre-bash` is
 * `PreToolUse (pre-bash)`.
 *
 * @param {string} entry
 * @returns {string}
 */
export function describeEntry(entry) {
  const [event, arg] = entry.split(":");
  return arg ? `${event} (${arg})` : event;
}

/**
 * The `.sh` files in a hooks directory, sorted. A missing directory is empty.
 *
 * @param {string} hooksDir
 * @returns {string[]}
 */
export function listShippedHooks(hooksDir) {
  if (!existsSync(hooksDir)) return [];
  return readdirSync(hooksDir)
    .filter((name) => name.endsWith(".sh"))
    .sort();
}

/**
 * The basename of the script a hook command runs. It looks past leading
 * `VAR=value` assignments, a shell interpreter, and the interpreter's flags,
 * and it drops quote characters, so `"$DIR"/hooks/x.sh` is `x.sh`.
 *
 * @param {unknown} command
 * @returns {string|null}
 */
export function commandHookName(command) {
  if (typeof command !== "string") return null;
  let afterInterpreter = false;
  for (const raw of command.trim().split(/\s+/)) {
    const token = raw.replace(/["']/g, "");
    if (token === "" || ASSIGNMENT.test(token)) continue;
    if (afterInterpreter && token.startsWith("-")) continue;
    const name = basename(token);
    if (INTERPRETERS.has(name)) {
      afterInterpreter = true;
      continue;
    }
    return name;
  }
  return null;
}

/**
 * The first shipped hook a command runs, with the argument after it. Looking
 * for a known name, rather than taking the first word, finds the hook behind
 * `timeout 10 …`, `test -x … && …`, `cd … && …`, or an interpreter flag that
 * takes a value.
 *
 * @param {unknown} command
 * @param {Set<string>} known Shipped hook basenames.
 * @returns {{ name: string, arg: string|null }|null}
 */
function findHookCall(command, known) {
  if (typeof command !== "string") return null;
  const tokens = command
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, ""));
  for (let i = 0; i < tokens.length; i += 1) {
    const name = basename(tokens[i]);
    if (!known.has(name)) continue;
    const next = tokens[i + 1];
    return { name, arg: next && /^[a-z][a-z-]*$/.test(next) ? next : null };
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Each shipped hook's registered entries (`Event` and `Event:argument`) and
 * scopes, the keys that are not event names, and the effective shell prefix.
 *
 * @param {SettingsSource[]} sources In precedence order: user, project, local.
 * @param {Record<string, string|undefined>} env
 * @param {Set<string>} known
 */
function collectRegistrations(sources, env, known) {
  /** @type {Map<string, {entries: Set<string>, scopes: Set<string>}>} */
  const found = new Map();
  const add = (call, event, scope) => {
    if (!call) return;
    if (!found.has(call.name)) found.set(call.name, { entries: new Set(), scopes: new Set() });
    const hit = found.get(call.name);
    hit.entries.add(event);
    if (call.arg) hit.entries.add(`${event}:${call.arg}`);
    if (scope) hit.scopes.add(scope);
  };
  /** @type {{path: string, key: string}[]} */
  const badKeys = [];
  // The shell prefix is one slot: the highest-precedence file that sets it
  // wins over the others and over the process environment.
  let prefix = { value: env[SHELL_PREFIX_EVENT], scope: undefined, path: undefined };
  for (const { path, scope, settings } of sources) {
    if (isObject(settings.env) && /** @type {any} */ (settings.env)[SHELL_PREFIX_EVENT] !== undefined) {
      prefix = { value: /** @type {any} */ (settings.env)[SHELL_PREFIX_EVENT], scope, path };
    }
    if (!isObject(settings.hooks)) continue;
    for (const [event, blocks] of Object.entries(settings.hooks)) {
      if (!EVENT_NAME.test(event)) {
        badKeys.push({ path, key: JSON.stringify(event) });
        continue;
      }
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (!isObject(block) || !Array.isArray(block.hooks)) continue;
        for (const hook of block.hooks) {
          if (isObject(hook) && hook.type === "command") add(findHookCall(hook.command, known), event, scope);
        }
      }
    }
  }
  add(findHookCall(prefix.value, known), SHELL_PREFIX_EVENT, prefix.scope);
  const shellPrefix = prefix.path === undefined ? null : { scope: prefix.scope, path: prefix.path };
  return { found, badKeys, shellPrefix };
}

/**
 * Sort the shipped hooks into registered and unregistered. A hook registered
 * for some but not all of its expected entries is registered, and `missing`
 * names the rest. `badKeys` lists `hooks` keys that are not event names,
 * JSON-escaped; `shellPrefix` names the file that sets the shell prefix, or
 * null when only the process environment does.
 *
 * @param {{shippedHooks: string[], sources: SettingsSource[], env: Record<string, string|undefined>}} input
 * @returns {{registered: RegisteredHook[], unregistered: UnregisteredHook[],
 *   badKeys: {path: string, key: string}[], shellPrefix: {scope: SettingsScope|undefined, path: string}|null}}
 */
export function hookRegistrationReport({ shippedHooks, sources, env }) {
  const { found, badKeys, shellPrefix } = collectRegistrations(sources, env, new Set(shippedHooks));
  /** @type {RegisteredHook[]} */
  const registered = [];
  /** @type {UnregisteredHook[]} */
  const unregistered = [];
  for (const hook of shippedHooks) {
    const expected = [...(SHIPPED_HOOK_EVENTS[hook] ?? [])];
    const hit = found.get(hook);
    if (!hit) {
      unregistered.push({ hook, expected });
      continue;
    }
    registered.push({
      hook,
      events: [...hit.entries].filter((e) => !e.includes(":")).sort(),
      missing: expected.filter((entry) => !hit.entries.has(entry)),
      scopes: /** @type {SettingsScope[]} */ ([...hit.scopes].sort()),
    });
  }
  return { registered, unregistered, badKeys, shellPrefix };
}

/**
 * Read the Claude Code settings files that can register a hook: the user's
 * (`$CLAUDE_CONFIG_DIR/settings.json`, default `~/.claude/settings.json`), the
 * repository's, and the repository's local file. Each is optional. A file that
 * does not parse, or is not a JSON object, is reported and skipped.
 *
 * @param {{home: string, repoRoot: string, env: Record<string, string|undefined>}} input
 * @returns {{sources: SettingsSource[], errors: SettingsReadError[]}}
 */
export function readSettingsSources({ home, repoRoot, env }) {
  const userDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  /** @type {[SettingsScope, string][]} */
  const paths = [
    ["user", join(userDir, "settings.json")],
    ["project", join(repoRoot, ".claude", "settings.json")],
    ["local", join(repoRoot, ".claude", "settings.local.json")],
  ];
  /** @type {SettingsSource[]} */
  const sources = [];
  /** @type {SettingsReadError[]} */
  const errors = [];
  for (const [scope, path] of paths) {
    if (!existsSync(path)) continue;
    let settings;
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      // V8 quotes source bytes in a parse error, and this file may come from a
      // cloned repository: strip anything that could rewrite the terminal.
      errors.push({ path, message: `does not parse: ${printable(err instanceof Error ? err.message : String(err))}` });
      continue;
    }
    if (!isObject(settings)) {
      errors.push({ path, message: "is not a JSON object" });
      continue;
    }
    sources.push({ path, scope, settings });
  }
  return { sources, errors };
}
