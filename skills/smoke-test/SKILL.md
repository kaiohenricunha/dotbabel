---
id: smoke-test
name: smoke-test
type: skill
version: 1.0.0
domain: [infra, devex]
platform: [vercel, flyio, aws]
task: [diagnostics, runtime-ops]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-09-18
updated: 2026-09-18
description: >
  Run the smoke checks a repository declares for its deploy targets and report
  whether production actually answers after a release. Use after a deploy, during
  release verification, and when confirming a rollback landed. Triggers on:
  "smoke test", "run smoke checks", "is production healthy", "did the deploy work",
  "verify the release is live".
argument-hint: "[--dry-run] [--json]"
tools: Bash, Read, Grep, Glob
allowed-tools: Read Grep Glob Bash
model: sonnet
effort: medium
disable-model-invocation: true
user-invocable: true
---

# Smoke Test

Run the `smoke` checks declared per target in `.claude/deploy-targets.json` and
report whether the deployed thing actually answers.

`disable-model-invocation: true` is deliberate. These checks execute commands
the repository declares and send requests to production, so this skill runs
when a person asks for it, not when a model infers it might be useful.

## Workflow

1. Resolve the helper script — the same two-step resolution `deploy-status`
   uses, because it is the same helper and a skill that found only one of the
   two locations would work for exactly one install shape:

   ```bash
   if [ -f "$HOME/.claude/skills/deploy-status/scripts/deploy-ops.mjs" ]; then
     DEPLOY_OPS="$HOME/.claude/skills/deploy-status/scripts/deploy-ops.mjs"
   elif [ -f "skills/deploy-status/scripts/deploy-ops.mjs" ]; then
     DEPLOY_OPS="skills/deploy-status/scripts/deploy-ops.mjs"
   else
     echo "deploy-status helper not found; re-run dotbabel bootstrap or dotbabel init" >&2
     exit 2
   fi
   ```

2. Run the smoke command from the consuming project root, forwarding **only**
   the flags this skill documents:

   ```bash
   node "$DEPLOY_OPS" smoke $ARGUMENTS
   ```

   `$ARGUMENTS` is raw caller text spliced into a command that reaches
   production, so pass only `--dry-run` and `--json` — drop anything else
   rather than forwarding it. A value carrying `;`, `|`, `&`, a backtick,
   `$(`, or a newline is shell syntax, not a flag: refuse it and say so.

3. Preserve the helper's exit code:
   - `0` — every declared check passed, or none is declared, or it was a dry
     run. None of those is a failure.
   - `1` — at least one check failed, or the run hit its 300-second budget.
   - `2` — target discovery failed.

4. **Read `verdict`, not just the exit code.** The payload distinguishes four
   states, and two of them exit 0 without having verified anything:

   | `verdict`        | Meaning                                          |
   | ---------------- | ------------------------------------------------ |
   | `pass`           | Every declared check ran and passed              |
   | `fail`           | At least one check failed, or the budget was hit |
   | `not_configured` | No target declares `smoke` — nothing was checked |
   | `not_run`        | `--dry-run`; checks were listed, none executed   |

   Report `not_configured` and `not_run` as exactly that. Reporting either as a
   pass claims a verification that did not happen.

## On failure

Report the failing checks and **recommend `/rollback-prod`**. Then stop.

**Never invoke `/rollback-prod`, and never run the rollback helper directly.**
Rolling back is a production change, and both the rule floor and KD-13 require
an explicit human instruction for one. `/rollback-prod` additionally demands a
typed confirmation of its own, which exists precisely so that a chain of
automated judgments cannot end in an unattended production change.

Recommend it, name the failing checks, and let the person decide.

## What the checks are

Declared per target in `.claude/deploy-targets.json`; see
`skills/deploy-status/SKILL.md` for the full schema and the security guards.
In short: `http` checks are GET only, retry 3 times with 2s/4s/8s backoff, and
abort after 10 seconds; `command` checks run their `argv` exactly once, because
a command may not be idempotent.

Secrets are read only from named environment variables, and header values never
appear in the output. If a check needs a token, export it before invoking:

```bash
SMOKE_BEARER=… /smoke-test
```

## Rules

- **Never roll back.** Recommend `/rollback-prod` and stop.
- **Never deploy or promote.** This skill only observes.
- **Never invent a smoke check.** If a target declares none, report
  `not_configured` rather than guessing at a health endpoint.
- **Never report a dry run as a pass.** `--dry-run` lists what would run and
  verifies nothing; its verdict is `not_run`.
- **Never print a header value.** The helper redacts them; do not echo the
  environment variable it read them from either.
