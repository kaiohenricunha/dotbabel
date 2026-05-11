# `/flyctl logs`

Tail or one-shot fetch logs from a Fly.io app.

## Forms

| Goal                     | Command                                     |
| ------------------------ | ------------------------------------------- |
| Live tail                | `flyctl logs -a $APP`                       |
| One-shot, last ~50 lines | `flyctl logs -a $APP --no-tail \| tail -50` |
| Filter to one machine    | `flyctl logs -a $APP -i <machine-id>`       |
| Filter to one region     | `flyctl logs -a $APP --region gru`          |
| JSON output for piping   | `flyctl logs -a $APP --json`                |

`-i` machine IDs are volatile — re-run `flyctl machines list -a $APP --json` to
get the current set before targeting.

## Common grep patterns

```bash
# Errors, fatals, panics
flyctl logs -a $APP --no-tail 2>&1 | grep -E "FTL|ERR|panic|fatal"

# Specific request-id (when the app logs structured fields)
flyctl logs -a $APP --json | jq -r 'select(.attributes.request_id=="<id>")'

# Timeouts and connection failures
flyctl logs -a $APP --no-tail 2>&1 | grep -Ei "timeout|connection refused|EOF"

# Database-flavored errors
flyctl logs -a $APP --no-tail 2>&1 | grep -Ei "postgres|database|pgx|sqlx"
```

## When the app logs are quiet

If `flyctl logs` returns nothing recent, check that the app is actually
receiving traffic:

```bash
flyctl status -a $APP            # machines running?
flyctl checks list -a $APP       # health checks passing?
```

A machine in `stopped` state with `auto_stop: true` is expected when there's
been no traffic — logs will resume on the next request that wakes the machine.

## Triage workflow

For a structured incident-triage flow (1: confirm the problem, 2: find the
error in logs, 3: classify, 4: correlate with the latest deploy, 5: check
resource pressure, 6: check Sentry / external monitoring), this skill does NOT
encode the project-specific playbook. Author it in your project's
`.claude/commands/` directory, calling `/flyctl logs` and `/flyctl releases`
from within it.
