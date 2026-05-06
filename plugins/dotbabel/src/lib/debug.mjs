import { env } from "./legacy-compat.mjs";

/**
 * Debug logger gated on `DOTBABEL_DEBUG=1` (legacy `DOTCLAUDE_DEBUG=1` honored
 * via legacy-compat fallback through 2.x).
 *
 * Replaces silent `catch` blocks in `spec-harness-lib.mjs:28-29` and `:184-186`
 * (legacy behavior) with opt-in diagnostic output. When the env flag is unset,
 * `debug()` is a no-op — zero runtime cost in normal operation.
 *
 * Usage:
 *   } catch (err) {
 *     debug('git:rev-parse', err.message);
 *     return null;
 *   }
 *
 * @param {string} tag
 * @param {...unknown} args
 * @returns {void}
 */
export function debug(tag, ...args) {
  if (env("DEBUG") !== "1") return;
  process.stderr.write(`[harness:${tag}] ${args.map(stringify).join(" ")}\n`);
}

/** @returns {boolean} */
export function isDebug() {
  return env("DEBUG") === "1";
}

/** @param {unknown} v */
function stringify(v) {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
