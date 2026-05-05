---
id: rollback-prod
name: rollback-prod
type: skill
version: 1.0.0
domain: [infra, devex]
platform: [vercel, flyio, aws]
task: [debugging, incident-response]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-05
updated: 2026-05-05
description: >
  Roll back the most recent production release across configured deploy targets
  after an explicit typed confirmation. Use only when the user directly invokes
  /rollback-prod during incident response or release recovery.
argument-hint: "[--dry-run]"
tools: Bash, Read, Grep, Glob
model: sonnet
effort: medium
disable-model-invocation: true
user-invocable: true
---

# Rollback Prod

Roll back production deploy targets to their previous releases using each
provider's native rollback primitive.

## Workflow

1. Resolve the shared deploy helper:

   ```bash
   if [ -f "$HOME/.claude/skills/deploy-status/scripts/deploy-ops.mjs" ]; then
     DEPLOY_OPS="$HOME/.claude/skills/deploy-status/scripts/deploy-ops.mjs"
   elif [ -f "skills/deploy-status/scripts/deploy-ops.mjs" ]; then
     DEPLOY_OPS="skills/deploy-status/scripts/deploy-ops.mjs"
   else
     echo "rollback-prod helper not found; re-run dotclaude bootstrap or dotclaude init" >&2
     exit 2
   fi
   ```

2. Run the rollback planner/executor from the consuming project root:

   ```bash
   node "$DEPLOY_OPS" rollback $ARGUMENTS
   ```

3. Preserve the helper's exit code:
   - `0` - rollback ran and post-rollback status is in sync
   - `1` - confirmation declined or post-rollback deploy status reports drift
   - `2` - discovery, auth, release lookup, or rollback execution failed

## Confirmation Contract

The helper always prints the rollback plan first. Unless `--dry-run` is present,
it must require the operator to type exactly:

```text
ROLLBACK PROD
```

No `--yes`, environment variable, autonomous mode, or model routing decision may
bypass this confirmation. Provider CLIs may receive their own non-interactive
flags only after this confirmation succeeds.

## Target Ordering

The helper uses the same target discovery as `/deploy-status`. If
`.claude/deploy-targets.json` contains `rollback_order`, targets matching each
entry are serialized in that order and targets in the same group run in
parallel. Example:

```json
{
  "rollback_order": ["fly", "vercel"]
}
```

This rolls backend targets back before frontend targets.

## Provider References

Load only the provider notes that match discovered targets:

| Provider    | Reference                   |
| ----------- | --------------------------- |
| Vercel      | `references/vercel.md`      |
| Fly.io      | `references/fly.md`         |
| AWS Amplify | `references/aws-amplify.md` |

## Rules

- Never run rollback actions without typed confirmation.
- If any target cannot produce both current and previous releases, run no
  rollback actions and exit `2`.
- If one target fails during rollback, report the partial state clearly and do
  not auto-revert targets that already succeeded.
- After attempted rollback actions, run deploy status automatically and print
  the new state.
