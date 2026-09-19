---
# dotbabel:generated — do not edit directly. Source: .claude/skills/deploy-status/SKILL.md. Regenerate with `dotbabel project-sync`.
name: deploy-status
description: >
  Show deployed git SHAs across configured production targets and compare them
  against origin/main. Use during deploy verification, incident response, and
  release drift checks. Triggers on: "what is deployed", "deploy status",
  "production drift", "is prod on main", "compare prod to main".
applyTo: "**"
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
     echo "deploy-status helper not found; re-run dotbabel bootstrap or dotbabel init" >&2
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

## Smoke checks

A target in `.claude/deploy-targets.json` may declare a `smoke` array, run
after a deploy to confirm the thing actually answers:

```bash
node "$DEPLOY_OPS" smoke            # human-readable
node "$DEPLOY_OPS" smoke --json     # machine-readable, see schemas/dotbabel.smoke-report.schema.json
node "$DEPLOY_OPS" smoke --dry-run  # list the checks without running them
```

Exit codes match the status command: `0` every check passed (or none is
declared, or it was a dry run — neither is a failure), `1` at least one failed
or the run hit its time budget, `2` target discovery failed.

Read `verdict` rather than inferring success from the exit code: `pass`,
`fail`, `not_configured` (no target declares checks) and `not_run` (a dry run).
A dry run also sets `dry_run: true` and reports each planned check with
`ok: null`, so a stray `--dry-run` in a pipeline cannot be mistaken for a green
gate over zero executed checks.

Two check types. An `http` check is **GET only** and retries up to 3 times with
2s, 4s and 8s backoff; a `command` check runs its `argv` **exactly once**,
because a command may not be idempotent and a retry would repeat a side effect
nobody agreed to. Each request is aborted after 10 seconds — a timeout is
transient, so it is retried on the backoff schedule — and the whole run stops
after 300 seconds.

**A check with no `expect_status` defaults to requiring 2xx.** A response
arriving is not the same as a response being good: without that default, a
check declaring no expectations reported green against a hard 500, which turns
an outage into a passing release gate. Set `expect_status` explicitly when you
want a specific non-2xx code.

These requests go to production and may carry a real credential, so the guards
are enforced rather than advised:

- A URL with embedded credentials is refused, and is **not** echoed back in the
  error — the config carrying it is already a committed secret.
- `https` is required for every host except `localhost` and `127.0.0.1`.
- Redirects are followed manually, at most 3, and only to the **same https
  origin**. Handing the response the power to choose the next host is how a
  secret header reaches somewhere it was never meant to go.
- A header value is read **only** from a named environment variable
  (`{ "env": "SMOKE_BEARER" }`). A literal in the config is refused, and a
  variable that is unset fails the check rather than quietly sending no header
  and passing against an anonymous response.
- Header **names** are reported; values never are. The failing response body is
  shown truncated and redacted, because an endpoint that echoes the header back
  would otherwise leak it through the very message reporting the failure.
- A refusal from any of these guards is never retried: a retry cannot turn it
  into a pass, and a differing later response would mask it.

```json
{
  "kind": "vercel",
  "project": "my-app",
  "smoke": [
    {
      "type": "http",
      "url": "https://my-app.example.com/healthz",
      "expect_status": 200,
      "expect_text": "ok"
    },
    {
      "type": "http",
      "url": "https://my-app.example.com/api/me",
      "expect_status": 200,
      "headers": { "Authorization": { "env": "SMOKE_BEARER" } }
    },
    { "type": "command", "argv": ["./scripts/smoke-api.sh", "--prod"] }
  ]
}
```

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
- On a smoke failure, recommend `/rollback-prod` and stop. The rule floor
  forbids production changes without explicit instruction, so this skill never
  rolls back on its own.
