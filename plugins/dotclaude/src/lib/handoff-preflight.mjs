/**
 * Auto-preflight caching for handoff push/pull.
 *
 * Wraps the existing `plugins/dotclaude/scripts/handoff-doctor.sh` script with
 * a 5-minute TTL cache so users don't pay the preflight cost on every push and
 * so `push`/`pull` fail early with the doctor's structured remediation block
 * on misconfiguration, instead of emitting a cryptic `gh` / `git` error.
 *
 * Cache file: `$XDG_CACHE_HOME/dotclaude/handoff-doctor.json` (fallback
 * `$HOME/.cache/dotclaude/handoff-doctor.json`). Invalidated when the recorded
 * `repo` no longer matches `process.env.DOTCLAUDE_HANDOFF_REPO`, when the TTL
 * has expired, when the cache schema version differs, when the file is
 * corrupt or missing, or when the caller passes `verify: true`.
 *
 * The `doctor` verb still invokes the shell script directly for on-demand
 * diagnostics — it does not read or write this cache.
 */

import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { runScript } from "./handoff-remote.mjs";

/** Schema version for the handoff-doctor cache entry. Bumped on breaking changes. */
export const CACHE_SCHEMA_VERSION = 1;

/** Cache time-to-live in milliseconds. 5 minutes per rollout-doc acceptance. */
export const DOCTOR_CACHE_TTL_MS = 5 * 60 * 1000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolvePath(__dirname, "..", "..", "scripts");
/** Absolute path to the handoff-doctor.sh shell script. */
export const DOCTOR_SH = join(SCRIPTS, "handoff-doctor.sh");

/**
 * Resolve the doctor script to run. Honors `DOTCLAUDE_DOCTOR_SH` so the bats
 * suite can swap in a counter-shim without patching the shipped script. Any
 * production path leaves this unset and gets the bundled `handoff-doctor.sh`.
 */
function resolveDoctorScript() {
  const override = process.env.DOTCLAUDE_DOCTOR_SH;
  return override && override.length > 0 ? override : DOCTOR_SH;
}

/** Resolve the active cache directory (honors XDG_CACHE_HOME, falls back to $HOME/.cache). */
export function currentCacheDir() {
  return join(
    process.env.XDG_CACHE_HOME || join(process.env.HOME || "", ".cache"),
    "dotclaude",
  );
}

/** Resolve the active cache file path. */
export function currentCacheFile() {
  return join(currentCacheDir(), "handoff-doctor.json");
}

/** Read and parse the preflight cache entry, returning `null` on any failure (treated as miss). */
export function readCache() {
  const file = currentCacheFile();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Return true if a cache entry is usable for `repo` at time `now`. */
export function isFresh(entry, repo, now) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.version !== CACHE_SCHEMA_VERSION) return false;
  if (entry.repo !== repo) return false;
  if (entry.status !== "ok") return false;
  const ts = Date.parse(entry.timestamp);
  if (!Number.isFinite(ts)) return false;
  return now - ts <= DOCTOR_CACHE_TTL_MS;
}

/**
 * Atomically write a cache entry. Writes to a sibling tmp file and renames
 * into place so a concurrent reader never sees a half-written JSON blob.
 */
export function writeCacheAtomic(entry) {
  const dir = currentCacheDir();
  mkdirSync(dir, { recursive: true });
  const final = currentCacheFile();
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(entry) + "\n", "utf8");
    renameSync(tmp, final);
  } catch (err) {
    // Best-effort cleanup of the stray tmp file. A failure here is not fatal:
    // the next successful preflight will overwrite it.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Auto-preflight before a push/pull. Returns silently when the cache is warm
 * (one informational line to stderr under `verbose`). Runs `handoff-doctor.sh`
 * otherwise; on failure, streams the doctor's remediation block to stderr
 * and throws. Throwing lets the bin's existing catch map it to exit 2.
 *
 * @param {{ repo: string, verify?: boolean, verbose?: boolean }} opts
 */
export function autoPreflight({ repo, verify = false, verbose = false }) {
  if (!verify) {
    const entry = readCache();
    const now = Date.now();
    if (isFresh(entry, repo, now)) {
      if (verbose) {
        const ageSec = Math.floor((now - Date.parse(entry.timestamp)) / 1000);
        process.stderr.write(`preflight: cache hit (age ${ageSec}s)\n`);
      }
      return;
    }
  }

  if (verbose) process.stderr.write("preflight: running handoff-doctor.sh\n");
  const r = runScript(resolveDoctorScript(), []);

  if (r.status !== 0) {
    // Always surface the remediation block — that's the whole point of doctor.
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    throw new Error("preflight failed");
  }

  if (verbose) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }

  writeCacheAtomic({
    version: CACHE_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    repo,
    status: "ok",
  });
}
