/**
 * Named exit code enum for every harness bin.
 *
 * Convention:
 * - 0 OK           — success
 * - 1 VALIDATION   — one or more validation rules failed (the expected failure mode)
 * - 2 ENV          — misconfigured environment (missing file, bad git repo, unreadable facts)
 * - 64 USAGE       — bad CLI invocation (unknown flag, missing required positional)
 *
 * 64 mirrors BSD sysexits.h EX_USAGE so operators can distinguish user error
 * from a real validation failure in CI pipelines.
 */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  VALIDATION: 1,
  ENV: 2,
  USAGE: 64,
});
