/**
 * hook-registration — which shipped hooks a Claude Code settings file actually runs.
 *
 * `bootstrap.sh` links every hook into `~/.claude/hooks/`, but it never edits
 * `settings.json`, so an installed hook does nothing until someone registers
 * it. `dotbabel doctor` uses this module to make that gap visible.
 *
 * A registration is matched by the basename of the command's script, so
 * `$HOME/.claude/hooks/fleet-guard.sh pre-edit` and a repository's own
 * `.claude/hooks/fleet-guard.sh` both count as `fleet-guard.sh`.
 *
 * @typedef {object} SettingsSource
 * @property {string} path
 * @property {Record<string, unknown>} settings
 *
 * @typedef {object} SettingsReadError
 * @property {string} path
 * @property {string} message
 *
 * @typedef {object} RegisteredHook
 * @property {string} hook
 * @property {string[]} events   Events it is registered for, sorted.
 * @property {string[]} missing  Expected events it is not registered for, in table order.
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
 * The events each shipped hook expects, as the table in `docs/hooks.md` lists
 * them. A test fails when this and `plugins/dotbabel/hooks/*.sh` disagree.
 */
export const SHIPPED_HOOK_EVENTS = Object.freeze({
  "check-on-stop.sh": Object.freeze(["Stop"]),
  "check-on-write.sh": Object.freeze(["PostToolUse"]),
  "fleet-guard.sh": Object.freeze(["PreToolUse", "SessionStart", "PostToolUse", "UserPromptSubmit"]),
  "fleet-shell-prefix.sh": Object.freeze([SHELL_PREFIX_EVENT]),
  "guard-criteria-evidence.sh": Object.freeze(["PreToolUse"]),
  "guard-destructive-git.sh": Object.freeze(["PreToolUse"]),
  "task-context.sh": Object.freeze(["SessionStart"]),
});

const INTERPRETERS = new Set(["bash", "sh", "zsh", "env"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map each hook basename to the set of events it is registered for.
 *
 * @param {SettingsSource[]} sources
 * @param {Record<string, string|undefined>} env
 * @returns {Map<string, Set<string>>}
 */
function collectRegistrations(sources, env) {
  /** @type {Map<string, Set<string>>} */
  const found = new Map();
  const add = (name, event) => {
    if (!name) return;
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(event);
  };

  const prefixes = [env[SHELL_PREFIX_EVENT]];
  for (const { settings } of sources) {
    if (isObject(settings.env)) prefixes.push(/** @type {any} */ (settings.env)[SHELL_PREFIX_EVENT]);
    if (!isObject(settings.hooks)) continue;
    for (const [event, blocks] of Object.entries(settings.hooks)) {
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (!isObject(block) || !Array.isArray(block.hooks)) continue;
        for (const hook of block.hooks) {
          if (isObject(hook) && hook.type === "command") add(commandHookName(hook.command), event);
        }
      }
    }
  }
  for (const prefix of prefixes) add(commandHookName(prefix), SHELL_PREFIX_EVENT);
  return found;
}

/**
 * Sort the shipped hooks into registered and unregistered. A hook registered
 * for some but not all of its expected events is registered, and `missing`
 * names the rest.
 *
 * @param {{shippedHooks: string[], sources: SettingsSource[], env: Record<string, string|undefined>}} input
 * @returns {{registered: RegisteredHook[], unregistered: UnregisteredHook[]}}
 */
export function hookRegistrationReport({ shippedHooks, sources, env }) {
  const found = collectRegistrations(sources, env);
  /** @type {RegisteredHook[]} */
  const registered = [];
  /** @type {UnregisteredHook[]} */
  const unregistered = [];
  for (const hook of shippedHooks) {
    const expected = [...(SHIPPED_HOOK_EVENTS[hook] ?? [])];
    const events = found.get(hook);
    if (!events) {
      unregistered.push({ hook, expected });
      continue;
    }
    registered.push({
      hook,
      events: [...events].sort(),
      missing: expected.filter((event) => !events.has(event)),
    });
  }
  return { registered, unregistered };
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
  const paths = [
    join(userDir, "settings.json"),
    join(repoRoot, ".claude", "settings.json"),
    join(repoRoot, ".claude", "settings.local.json"),
  ];
  /** @type {SettingsSource[]} */
  const sources = [];
  /** @type {SettingsReadError[]} */
  const errors = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    let settings;
    try {
      settings = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      errors.push({ path, message: `does not parse: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!isObject(settings)) {
      errors.push({ path, message: "is not a JSON object" });
      continue;
    }
    sources.push({ path, settings });
  }
  return { sources, errors };
}
