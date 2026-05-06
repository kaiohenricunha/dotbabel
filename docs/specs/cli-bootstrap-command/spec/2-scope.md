# §2 — Scope

> What's in, what's out, and where are the boundaries?

## In Scope

- New `dotbabel-bootstrap.mjs` bin and `bootstrap-global.mjs` src module
- New `dotbabel-sync.mjs` bin and `sync-global.mjs` src module
- `dotbabel.mjs` dispatcher updated to recognise `bootstrap` and `sync` subcommands
- `package.json` `files` array extended to ship `commands/`, `skills/`, `CLAUDE.md`
- `package.json` `bin` map extended with `dotbabel-bootstrap` and `dotbabel-sync`
- `index.mjs` barrel extended with `bootstrapGlobal` and `syncGlobal` exports
- Unit + integration tests for both new modules
- README and CLI reference docs updated
- `dotbabel-doctor` updated to check bootstrap state (symlinks present + valid)

## Out of Scope

- Removing or modifying `bootstrap.sh` / `sync.sh` — they remain the zero-npm
  fallback path and keep working unchanged
- A `sync push` equivalent in npm mode — secret-scanning and auto-committing
  the dotbabel repo is a clone-mode-only concern
- Windows support — `~/.claude/` symlinking on Windows requires elevated
  permissions and is deferred; the bins will emit a clear `OPS-1` error on
  `win32` platform
- GUI / TUI — the commands follow the existing ✓/✗/⚠ output convention
- `dotbabel update` as an alias — subcommand naming stays consistent with
  existing conventions (`sync pull` mirrors `sync.sh pull`)

## Boundaries

| Touches                                                        | Does Not Touch                                        |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| `plugins/dotbabel/bin/` — two new bins                        | `bootstrap.sh`, `sync.sh`                             |
| `plugins/dotbabel/src/` — two new modules                     | `validate-specs.mjs`, `check-spec-coverage.mjs`       |
| `plugins/dotbabel/src/index.mjs` — two new exports            | `spec-harness-lib.mjs`                                |
| `plugins/dotbabel/bin/dotbabel.mjs` — SUBCOMMANDS array      | Per-repo `.claude/` scaffold logic                    |
| `package.json` — `files`, `bin`                                | `docs/repo-facts.json` protected paths (no new paths) |
| `plugins/dotbabel/bin/dotbabel-doctor.mjs` — bootstrap check | Any downstream consumer repos                         |

## Urgency

No hard deadline. This is a developer-experience improvement, not a bug fix.
Blocking on merging any in-flight spec work (`dotbabel-agents`, PR #28)
that also touches `index.mjs` and the bin list would reduce merge friction.
