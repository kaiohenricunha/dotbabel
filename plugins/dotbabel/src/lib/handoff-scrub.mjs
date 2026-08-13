import { spawnSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the shell script. Resolved once at module load. */
export const DEFAULT_SCRUB_SCRIPT = resolvePath(
  __dirname,
  "..",
  "..",
  "scripts",
  "handoff-scrub.sh",
);

/**
 * Environment variable that redirects the scrubber path.
 *
 * `opts.scriptPath` covers in-process callers, but an integration test drives
 * the CLI as a child process and cannot pass options through it. Without this
 * seam such a test has to rename the real script inside the repo, which makes
 * the whole bats suite unsafe to run in parallel — every concurrent test that
 * needs the scrubber fails while it is moved aside.
 *
 * This does not widen the trust boundary: anyone who can set the environment
 * of this process can already edit the script the default path points at. The
 * override is still fail-closed — a path that does not resolve throws exactly
 * as a missing default would.
 */
export const SCRUB_SCRIPT_ENV_VAR = "DOTBABEL_HANDOFF_SCRUB_SCRIPT";

/**
 * Message prefix on every throw from this module. Callers (and tests) match
 * on it to recognise fail-closed failures before surfacing them to the user.
 */
export const SCRUB_ERROR_PREFIX = "scrub not applied";

const COUNT_LINE_RE = /^scrubbed:(\d+)$/m;

/**
 * @typedef {object} ScrubResult
 * @property {string} scrubbed   The redacted text. Equal to input when count is 0.
 * @property {number} count      Number of redactions the scrubber applied.
 */

/**
 * Pipe `text` through handoff-scrub.sh and return the scrubbed output plus
 * redaction count. Throws if the script is missing, exits non-zero, or
 * violates the stderr contract — callers must treat those as push-blocking.
 *
 * Path precedence: `opts.scriptPath`, then {@link SCRUB_SCRIPT_ENV_VAR}, then
 * {@link DEFAULT_SCRUB_SCRIPT}. The env var is read per call rather than at
 * module load so a test can set and clear it around a single assertion.
 *
 * @param {string} text
 * @param {{ scriptPath?: string }} [opts]
 * @returns {ScrubResult}
 */
export function scrubDigest(text, opts = {}) {
  const fromEnv = (process.env[SCRUB_SCRIPT_ENV_VAR] ?? "").trim();
  const scriptPath = opts.scriptPath ?? (fromEnv || DEFAULT_SCRUB_SCRIPT);

  const res = spawnSync(scriptPath, [], {
    input: text,
    encoding: "utf8",
    // No shell: direct exec avoids quoting hazards with the stdin payload.
    shell: false,
  });

  if (res.error) {
    throw new Error(`${SCRUB_ERROR_PREFIX}: ${res.error.message}`);
  }
  if (typeof res.status !== "number" || res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    throw new Error(
      `${SCRUB_ERROR_PREFIX}: handoff-scrub.sh exited ${res.status}${stderr ? `: ${stderr}` : ""}`,
    );
  }

  const match = (res.stderr ?? "").match(COUNT_LINE_RE);
  if (!match) {
    throw new Error(
      `${SCRUB_ERROR_PREFIX}: handoff-scrub.sh did not report a \`scrubbed:N\` count on stderr`,
    );
  }

  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `${SCRUB_ERROR_PREFIX}: unparseable scrubbed count ${JSON.stringify(match[1])}`,
    );
  }

  return { scrubbed: res.stdout ?? "", count };
}
