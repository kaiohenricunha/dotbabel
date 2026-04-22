/**
 * Node-side wrapper around `plugins/dotclaude/scripts/handoff-scrub.sh`.
 *
 * The shell script is a stdin→stdout filter that prints `scrubbed:N` to
 * stderr and exits 0 on success. This wrapper feeds a digest string to it,
 * captures the redacted output, parses the count, and fails closed on any
 * deviation from that contract. Callers on a push path must propagate the
 * throw so the remote upload does not proceed with unscrubbed content.
 *
 * The three-state signal the remote binary emits (`[scrubbed N secrets]`,
 * `[scrubbed 0 secrets]`, `[scrub not applied]`) lives in the caller —
 * this module only distinguishes "scrubbed with count N" from "throw".
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
 * @param {string} text
 * @param {{ scriptPath?: string }} [opts]
 * @returns {ScrubResult}
 */
export function scrubDigest(text, opts = {}) {
  const scriptPath = opts.scriptPath ?? DEFAULT_SCRUB_SCRIPT;

  if (!existsSync(scriptPath)) {
    throw new Error(
      `scrub not applied: handoff-scrub.sh missing at ${scriptPath}`,
    );
  }

  const res = spawnSync(scriptPath, [], {
    input: text,
    encoding: "utf8",
    // No shell: direct exec avoids quoting hazards with the stdin payload.
    shell: false,
  });

  if (res.error) {
    throw new Error(`scrub not applied: ${res.error.message}`);
  }
  if (typeof res.status !== "number" || res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    throw new Error(
      `scrub not applied: handoff-scrub.sh exited ${res.status}${stderr ? `: ${stderr}` : ""}`,
    );
  }

  const match = (res.stderr ?? "").match(COUNT_LINE_RE);
  if (!match) {
    throw new Error(
      "scrub not applied: handoff-scrub.sh did not report a `scrubbed:N` count on stderr",
    );
  }

  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `scrub not applied: unparseable scrubbed count ${JSON.stringify(match[1])}`,
    );
  }

  return { scrubbed: res.stdout ?? "", count };
}
