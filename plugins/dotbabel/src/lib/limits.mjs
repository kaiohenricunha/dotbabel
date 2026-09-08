/**
 * Maximum stdout a read-only Git subprocess may buffer, in bytes.
 *
 * Bounded on purpose. These calls pass `encoding: "utf8"`, so Node builds a JS
 * string from the output; an unbounded buffer would trade a clean `ENOBUFS` for
 * a V8 string-length crash or an OOM. 64 MiB matches the existing large-output
 * call sites and is roughly 11k changed files of `git diff --unified=0` at the
 * density measured on this repository.
 */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
