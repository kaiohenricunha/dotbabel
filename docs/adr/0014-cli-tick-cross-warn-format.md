# ADR-0014 — CLI ✓/✗/⚠ output format

**Status**: Accepted (2026-04-14)

## Context

The original `validate-settings.sh` prefixed each line with a colored
glyph — `✓` (green) for pass, `✗` (red) for fail, `⚠` (yellow) for warn.
Readable, grep-friendly, widely copied across projects.

When `0.2.0` added Node bins, the question was whether to keep this format
or switch to a structured logger (pino, winston, bunyan). The bins had to
work well interactively (humans reading terminal output) *and* in CI
(machine consumers, usually `jq`).

## Decision

**Keep the gold-standard format.** Every bin + every shell script uses the
same `✓/✗/⚠` prefix, factored into two helpers that stay byte-compatible:

- `plugins/harness/src/lib/output.mjs` — `createOutput({ json, noColor })`
  returns a `{ pass, fail, warn, info, flush, counts }` interface. Mirrors
  the shell helper.
- `plugins/harness/scripts/lib/output.sh` — `pass`/`fail`/`warn`/`out_init`/
  `out_flush`. Consumed via `source "$SCRIPT_DIR/lib/output.sh"`.

`--json` is the machine mode. In that mode, the ✓/✗/⚠ lines are replaced
with a single JSON envelope:

```json
{
  "events": [
    { "kind": "fail", "message": "...", "details": { "code": "...", ... } }
  ],
  "counts": { "pass": 0, "fail": 1, "warn": 0 }
}
```

`--no-color` (or `NO_COLOR=` env) suppresses ANSI. TTY detection falls back
to no-color automatically when stdout isn't a TTY.

## Consequences

- **One format, two audiences.** Terminal users get ✓/✗/⚠; CI consumers
  pipe through `jq`.
- **Cross-language parity.** Shell scripts and Node bins produce identical
  output shapes — a dogfood workflow can run either and parse results the
  same way.
- **ANSI discipline.** Every color escape goes through the helper; no ad-hoc
  `printf '\033[31m'` anywhere in the codebase (enforced by code review +
  shellcheck).
- **The glyph choice is load-bearing.** Changing `✓` to a plain `P` for
  any reason (low-contrast terminals, screen readers) is a breaking
  change — consumers grep for the glyph in dashboards.

## Alternatives considered

- **pino / structured logger.** Overkill for a CLI library. Adds a
  runtime dep (violates zero-dep). JSON mode today serves the same
  structured-consumer use case.
- **Plain `[OK]` / `[FAIL]` / `[WARN]` prefixes.** Less visually scannable.
  Glyphs are the de-facto convention in modern CLIs (npm, pnpm, bun,
  Docker, k8s operators all use similar symbols).
- **Different glyphs per bin** (e.g. spec validator uses `📝`). Rejected —
  consistency across bins is the whole point.

## Revisit triggers

- A credible accessibility complaint (screen reader users, low-contrast
  environments).
- A terminal-ecosystem shift that deprecates Unicode glyphs.
