---
id: deploy-status
name: deploy-status
type: skill
version: 1.0.0
domain: [infra, devex]
platform: [vercel, flyio, aws]
task: [diagnostics, runtime-ops]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-05
updated: 2026-05-05
description: >
  Show deployed git SHAs across configured production targets and compare them
  against origin/main. Use during deploy verification, incident response, and
  release drift checks. Triggers on: "what is deployed", "deploy status",
  "production drift", "is prod on main", "compare prod to main".
argument-hint: "[--dry-run] [--no-fetch]"
tools: Bash, Read, Grep, Glob
model: sonnet
effort: medium
disable-model-invocation: false
user-invocable: true
---

# Deploy Status

Report what git revision is live across production deploy targets and whether
each target matches `origin/main`.

## Workflow

1. Resolve the helper script:

   ```bash
   if [ -f "$HOME/.claude/skills/deploy-status/scripts/deploy-ops.mjs" ]; then
     DEPLOY_OPS="$HOME/.claude/skills/deploy-status/scripts/deploy-ops.mjs"
   elif [ -f "skills/deploy-status/scripts/deploy-ops.mjs" ]; then
     DEPLOY_OPS="skills/deploy-status/scripts/deploy-ops.mjs"
   else
     echo "deploy-status helper not found; re-run dotclaude bootstrap or dotclaude init" >&2
     exit 2
   fi
   ```

2. Run the status command from the consuming project root:

   ```bash
   node "$DEPLOY_OPS" status $ARGUMENTS
   ```

3. Preserve the helper's exit code:
   - `0` - every target is in sync with `origin/main`
   - `1` - at least one target is behind, ahead, or otherwise drifted
   - `2` - target discovery, provider auth, provider parsing, or SHA detection failed

## Target Discovery

Discovery is configuration-first only where auto-discovery cannot prove a target.
The helper:

1. Auto-discovers Vercel from `.vercel/project.json`.
2. Auto-discovers Fly.io from top-level `app = "..."`
   in `fly.toml`.
3. Merges `.claude/deploy-targets.json` when present. Config entries override
   matching auto-discovered targets and add non-discoverable platforms.

Example config: `examples/deploy-targets.example.json`.

## Provider References

Load only the provider notes that match discovered targets:

| Provider    | Reference                   |
| ----------- | --------------------------- |
| Vercel      | `references/vercel.md`      |
| Fly.io      | `references/fly.md`         |
| AWS Amplify | `references/aws-amplify.md` |

## Rules

- Do not prompt for provider tokens. Use the existing CLI auth state
  (`vercel whoami`, `fly auth whoami`).
- Do not deploy or roll back from this skill. This skill is read-only except for
  `git fetch origin main --quiet`.
- If a provider cannot expose a git SHA, report that target as unknown and exit
  `2` rather than inventing drift data.
