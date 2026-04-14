# ADR-0012 — Structured error contract

**Status**: Accepted (2026-04-14)

## Context

The legacy validator surface (pre-0.2.0) pushed raw strings into
`result.errors`. Consumers who wanted to react programmatically — gate CI
on a specific kind of failure, or route a subset of errors to a
different channel — had two bad options:

1. Regex the stderr prose. Brittle. Any message wording change is
   implicitly a breaking change that CI consumers feel immediately.
2. Read the source and hardcode the call-site line numbers. Worse.

## Decision

Every validator emits `ValidationError` instances, not strings. A single
source of truth lives at `plugins/harness/src/lib/errors.mjs`:

- **`class ValidationError extends Error`** with stable fields: `code`,
  `message`, optional `file`, `pointer`, `line`, `expected`, `got`,
  `hint`, `category`.
- **`ERROR_CODES`**, an `Object.freeze({ SPEC_STATUS_INVALID: ..., ... })`
  enum. Adding codes is safe; renaming is a breaking change.
- **`ValidationError.prototype.toString()`** returns the legacy
  `"<file>: <message>"` format so existing `/regex/.test(err)` CI scripts
  continue to work without migration.
- **`ValidationError.prototype.toJSON()`** returns a plain object
  consumable by `JSON.stringify`. Every bin's `--json` flag emits these
  under `.details`.

## Consequences

- **Backwards-compatible for stderr consumers** — regexing the human
  message still works.
- **Forward-compatible for structured consumers** — `jq -r '.events[] |
select(.kind == "fail") | .details.code'` is the documented pipeline.
- **Stability contract** — `ERROR_CODES` entries are load-bearing strings.
  Renames require a major bump; additions don't.
- **Discoverability** — `ERROR_CODES` is the authoritative index; the
  troubleshooting guide mirrors it one-to-one.
- **Writing cost** — every new error site now lives in a named category and
  comes with a `hint`. Non-trivial overhead vs `errors.push("msg")`, but
  one-time.

## Alternatives considered

- **Zod schema + tagged union.** Overkill for a validator library.
  Introduces a runtime dep (violates the zero-dep guarantee) and a
  schema-definition layer that changes more often than the codes
  themselves.
- **`Result<ok, err>` style (Rust-inspired).** Consumers would have to
  import a `Result` helper. Too much ceremony for Node; `{ok, errors}` is
  idiomatic enough.
- **Keep strings, layer a parser on top.** Rejected — parsers on
  human-readable text are fragile, and "change the prose" becomes a
  hidden breaking change.

## Revisit triggers

- A consumer requests richer structured metadata that doesn't fit the
  flat `StructuredError` shape.
- Internationalization of `hint` messages becomes in-scope.
