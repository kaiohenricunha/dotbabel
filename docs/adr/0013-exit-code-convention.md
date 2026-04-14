# ADR-0013 — Exit-code convention

**Status**: Accepted (2026-04-14)

## Context

Each bin originally exited `0` on success and `1` on any other outcome.
Operators running these in CI couldn't distinguish "a validation rule
failed" (an expected outcome; the pipeline should fail the PR check) from
"the CLI was invoked with a bad flag" (a workflow-author bug; the pipeline
should fail the _workflow_ author's attention, not the PR author's).

## Decision

A single named enum, exported as `EXIT_CODES`, consumed by every bin:

| Name         | Value | Meaning                                                                  |
| ------------ | ----- | ------------------------------------------------------------------------ |
| `OK`         | 0     | Success                                                                  |
| `VALIDATION` | 1     | One or more validation rules failed (expected failure mode)              |
| `ENV`        | 2     | Misconfigured environment — missing file, bad git repo, unreadable facts |
| `USAGE`      | 64    | Bad CLI invocation — unknown flag, missing required positional           |

`64` is chosen deliberately: it matches BSD `sysexits.h EX_USAGE`. Pipeline
authors can then write:

```yaml
- run: npx harness-validate-specs
- if: failure()
  run: |
    case $? in
      1)  echo "validation failed — review the PR"; exit 1 ;;
      2)  echo "environment issue — check workflow setup"; exit 2 ;;
      64) echo "bad CLI invocation — the workflow needs editing"; exit 64 ;;
    esac
```

## Consequences

- **Actionable CI output.** `ENV` vs `USAGE` vs `VALIDATION` route to
  different humans.
- **`sysexits.h` alignment.** Future codes (e.g. `EX_NOPERM`=77 for "hook
  blocked") have a standard vocabulary to pick from.
- **The `guard-destructive-git.sh` hook's `exit 2` stays** — it's the
  Claude Code PreToolUse protocol (block the tool call), not the harness
  validator `ENV` code. Documented explicitly in the hook header comment.
- **Test harness** — every bin's exit code is asserted in the integration
  test; drift fails CI.

## Alternatives considered

- **0/1 only, encode category in stderr.** Rejected — requires parsing,
  which the structured-error contract already handles elsewhere.
- **Custom codes in the 100-150 range.** Rejected — `64` is recognized,
  invented codes aren't.
- **Match `rustc`'s exit codes.** Rejected — not a convention operators
  expect from a CLI.

## Revisit triggers

- A failure mode surfaces that doesn't fit any of `{OK, VALIDATION, ENV,
USAGE}`. Most likely a "blocked by policy" (hook) case, which would
  adopt 77.
