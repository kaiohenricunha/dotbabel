# Handoff redaction — patterns and semantics

The `push` sub-command pipes the rendered digest through a
redaction pass before uploading. This file is the authoritative list
of patterns. The reusable implementation lives at
`plugins/dotbabel/scripts/handoff-scrub.sh`.

## Contract

- **Input:** arbitrary text on stdin.
- **Output:** the same text on stdout, with each matched pattern
  replaced by `<redacted:<pattern-name>>`.
- **Stderr:** a single `scrubbed:<N>` line (0 is valid).
- **Exit code:** 0 on success, non-zero only on I/O errors.

## Patterns (v1)

Each row: the regex (Perl-compatible, PCRE — the implementation uses
`perl -e` to support inline flags like `(?i)` and `\S+`),
the pattern name used in the replacement marker, and a one-line
rationale.

| Name              | Regex                                                                                                  | Rationale                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `github-token`    | `gh[pso]_[A-Za-z0-9]{20,}`                                                                             | GitHub PAT / OAuth / server / refresh tokens.                          |
| `openai-or-sk`    | `sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}`                                                                     | Anthropic / OpenAI user keys; tight enough to avoid `sk-learn`.        |
| `aws-access-key`  | `AKIA[0-9A-Z]{16}`                                                                                     | AWS access key ID canonical shape.                                     |
| `google-api-key`  | `AIza[0-9A-Za-z_-]{35}`                                                                                | Google Cloud / Maps API keys.                                          |
| `slack-token`     | `xox[baprs]-[0-9A-Za-z-]{10,}`                                                                         | Slack bot / user / refresh tokens.                                     |
| `auth-bearer`     | `(?i)^authorization:[[:space:]]*bearer[[:space:]]+\S+`                                                 | Raw HTTP auth headers pasted into sessions.                            |
| `env-secret`      | `(?i)^[[:space:]]*(export[[:space:]]+)?[A-Z0-9_]*(TOKEN\|KEY\|SECRET\|PASSWORD\|PASSWD)[A-Z0-9_]*=\S+` | `FOO_TOKEN=...`, `API_KEY=...`, `export PASSWORD=...` lines.           |
| `pem-private-key` | `-----BEGIN (RSA \|EC \|OPENSSH \|ENCRYPTED \|)PRIVATE KEY-----`                                       | PEM private-key blocks (line 1 only; block framing is enough to flag). |

## Semantics

- Patterns are applied in the order listed. Earlier matches win; later
  patterns do not re-scan redacted spans.
- Case sensitivity is baked into the regex — patterns that are
  case-insensitive use the `(?i)` inline flag.
- Line-anchored patterns (`auth-bearer`, `env-secret`) require the
  marker at the start of a line (after optional whitespace). Inline
  occurrences inside quoted strings are not caught; this is a known
  limitation that the scrubber does not try to fix heuristically.
- Empty input → empty output, `scrubbed:0` on stderr.

## Intentionally NOT scrubbed

- Short numeric PINs and per-user IDs — too many false positives.
- Email addresses — sometimes the user is legitimately talking about
  an address; scrubbing it breaks summaries.
- Absolute file paths — used for navigation in the digest; they are
  not sensitive by themselves.

## Extending

Add a new row to the table AND to `handoff-scrub.sh`'s Perl `s///g`
substitutions in the same commit. Update `handoff-scrub.bats` with one
positive case and one false-friend case. The reference doc and the script
must agree — the unit test cross-checks by parsing this table and
grepping the script.

## User responsibility

Scrubbing is best-effort. It does not catch:

- Custom enterprise secret formats.
- Secrets broken across lines (copy/paste from IDEs sometimes wraps).
- Secrets inside base64/URL-encoded blobs.
- Anything the user consciously wrote in prose ("my password is …").

Before pushing sensitive sessions, review the digest locally with
`dotbabel handoff pull <uuid>` first.
