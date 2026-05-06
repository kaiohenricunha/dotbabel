# §7 — Non-Functional Requirements

> Performance, reliability, operational, security constraints.

## Performance

PERF-1: `dotbabel bootstrap` must complete in under 2 seconds on a cold run
(first-time setup, ~30 symlink operations). The only I/O is filesystem
symlink creation and a single `readdir` per source directory.

PERF-2: `dotbabel sync status` (npm mode) must not block for more than
5 seconds. The npm registry version check is a single HTTP GET to
`registry.npmjs.org`; implement with a 3-second timeout and degrade
gracefully (show current version + `⚠ registry unreachable`).

## Reliability

REL-1: All filesystem operations must be atomic at the individual file level.
Write backup before overwriting; never leave `~/.claude/` in a half-written
state. If the process is interrupted mid-bootstrap, the next run
(`ARCH-1` idempotency) must be able to complete cleanly.

REL-2: `sync pull` (clone mode) must not run bootstrap if the git
fetch/rebase fails. Abort and report the git error; do not partially apply.

REL-3: `sync pull` (npm mode) must not re-run bootstrap if `npm update -g`
exits non-zero. Report the npm error and exit 1.

## Operational

OPS-1: On `win32` platform, `dotbabel bootstrap` and `dotbabel sync` must
exit with code 2 and emit a clear message:

```
✗ bootstrap is not supported on Windows (symlinks require elevated permissions).
  Use WSL or run bootstrap.sh from Git Bash.
```

No silent failure; no partial execution.

OPS-2: `DOTBABEL_DIR` environment variable must be documented in
`--help` output for both `dotbabel-bootstrap` and `dotbabel-sync`.
Undocumented env vars are a maintenance hazard.

OPS-3: `dotbabel-doctor` must report bootstrap state so that CI-based
onboarding checks can verify a developer machine is set up without running
bootstrap again. The check should be non-fatal (warn, not fail) when `~/.claude/`
has never been bootstrapped — doctor is a diagnostic, not a gate.

## Security

SEC-1: `sync push` (clone mode) must perform secret-scanning before staging
any files. The regex is ported verbatim from `sync.sh` (`SECRET_RX`). The
scan reads file contents via `git show ":$file"` so only staged content is
inspected (not the working tree). The escape hatch `HARNESS_SYNC_SKIP_SECRET_SCAN=1`
is preserved for parity with `sync.sh`.

SEC-2: `--source` and `DOTBABEL_DIR` paths must be validated as existing
directories before any filesystem operation. A non-existent source exits 2
with a clear error; it must not silently create an empty `~/.claude/` or
produce broken symlinks.

SEC-3: The npm package tarball now includes `commands/`, `skills/`, and
`CLAUDE.md`. None of these files should contain secrets. The existing
`sync push` secret-scan and `.gitignore` cover the source; a `dotbabel-doctor`
check should verify no `.env` or credential files are present in `commands/`
or `skills/` at publish time (enforced via `prepublishOnly` npm script).
