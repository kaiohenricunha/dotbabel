/**
 * clone-registry — the machine-level map from a repository key to the clones
 * of that repository on this machine, for cross-repo task references only
 * (KD-1). A task of another clone, `github.com/owner/repo:<slug>`, resolves
 * from that clone's task files, offline (KD-2); this file only says where the
 * clones are.
 *
 *   $XDG_STATE_HOME/dotbabel/graph/clones.json       {schema_version, repos: {key: [path]}}
 *   $XDG_STATE_HOME/dotbabel/graph/clones.json.lock/ held for the milliseconds of a write
 *
 * The key is the normalized `origin` URL, as for the fleet ledger. A path is
 * a clone's main checkout; its linked worktrees are found from there. A path
 * that no longer exists is dropped on read, and the next write prunes it from
 * the file. Every write is a complete temp file renamed into place under the
 * lock, so a reader never sees a half-written registry and two sessions never
 * lose each other's clone.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Version of the registry format. A reader treats a file of another version as empty. */
export const REGISTRY_SCHEMA_VERSION = 1;

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 10;

/**
 * @typedef {object} CloneRegistry
 * @property {number} schema_version
 * @property {Record<string, string[]>} repos  repository key to the sorted paths of its clones
 */

/**
 * The registry file: `$XDG_STATE_HOME/dotbabel/graph/clones.json`, with
 * `~/.local/state` as the default state home.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function registryFile(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "dotbabel", "graph", "clones.json");
}

function empty() {
  return { schema_version: REGISTRY_SCHEMA_VERSION, repos: {} };
}

/**
 * The registry as it stands, with every path that no longer exists dropped and
 * every repository with no clone left removed. A missing, unreadable, or
 * differently versioned file is an empty registry: it is an index, and the
 * task files stay the source of truth.
 *
 * @param {string} file
 * @returns {CloneRegistry}
 */
export function readRegistry(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return empty();
  }
  if (raw?.schema_version !== REGISTRY_SCHEMA_VERSION || !raw.repos || typeof raw.repos !== "object" || Array.isArray(raw.repos)) {
    return empty();
  }
  const registry = empty();
  for (const [key, paths] of Object.entries(raw.repos)) {
    if (!Array.isArray(paths)) continue;
    const alive = paths.filter((p) => typeof p === "string" && fs.existsSync(p)).sort();
    if (alive.length > 0) registry.repos[key] = alive;
  }
  return registry;
}

/**
 * The paths of the clones of `repoKey`, or none.
 *
 * @param {CloneRegistry} registry
 * @param {string} repoKey
 * @returns {string[]}
 */
export function clonesOf(registry, repoKey) {
  return registry.repos[repoKey] ?? [];
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while this process holds the registry lock. A lock older than
 * LOCK_STALE_MS belongs to a process that died inside it and is removed; a
 * live one that does not free up within `waitMs` is an error.
 */
function withLock(file, fn, waitMs) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between mkdir and stat
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`clone registry lock is busy: ${lock}`);
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function writeAtomic(file, value) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * Record `clonePath` as a clone of `repoKey`, once, and prune the paths that
 * no longer exist. The read and the write happen under the registry lock.
 *
 * @param {string} file
 * @param {string} repoKey
 * @param {string} clonePath  the clone's main checkout, as a real path
 * @param {{ waitMs?: number }} [opts]
 * @returns {CloneRegistry} the registry written
 */
export function registerClone(file, repoKey, clonePath, { waitMs = LOCK_WAIT_MS } = {}) {
  return withLock(
    file,
    () => {
      const registry = readRegistry(file);
      registry.repos[repoKey] = [...new Set([...clonesOf(registry, repoKey), clonePath])].sort();
      writeAtomic(file, registry);
      return registry;
    },
    waitMs,
  );
}
