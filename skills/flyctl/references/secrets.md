# `/flyctl secrets`

Manage Fly.io app secrets.

## Verbs

| Verb            | Command                                  | Triggers redeploy?          | Confirm on prod? |
| --------------- | ---------------------------------------- | --------------------------- | ---------------- |
| `list`          | `flyctl secrets list -a $APP`            | no                          | no               |
| `set` (default) | `flyctl secrets set K=V -a $APP`         | **yes**                     | yes              |
| `set --stage`   | `flyctl secrets set --stage K=V -a $APP` | no (applied on next deploy) | yes              |
| `unset`         | `flyctl secrets unset K -a $APP`         | **yes**                     | yes              |

## Batch updates → one restart

`flyctl secrets set` accepts multiple `KEY=VALUE` pairs in a single invocation
and triggers exactly one rolling restart. Always batch when setting more than
one secret:

```bash
# Good — one restart
flyctl secrets set DB_PASSWORD=...new... API_TOKEN=...new... -a $APP

# Bad — two restarts, two windows of partial config
flyctl secrets set DB_PASSWORD=...new... -a $APP
flyctl secrets set API_TOKEN=...new... -a $APP
```

## Never echo secret values

`flyctl secrets list` prints names only (and a digest), never values — that's by
design. Mirror the same discipline in skill output:

- Never paste a secret value into the chat to the operator
- Never log the contents of `$VALUE` in audit output
- When prompting for a secret, redirect the prompt and read silently:
  `read -s -r VALUE && echo`
- If the operator pastes a secret into chat, **do not** include it in any
  subsequent assistant message or commit message

## Rotation flow

1. Obtain the new value from the external system (Neon dashboard, AWS Secrets
   Manager, 1Password vault, etc.). The user must provide it; this skill does
   not have access.
2. `flyctl secrets set KEY="$NEW" -a $APP` (with confirmation if prod).
3. Wait for the rolling restart to complete (~30 s for a small VM):
   `flyctl status -a $APP` — confirm all machines are `started` on the new
   release.
4. Verify the specific functionality that uses the secret (a health endpoint,
   a smoke query, etc.) — see [`health.md`](health.md).

## `--stage` for atomic multi-secret + deploy

Use `--stage` when you want to land multiple secrets AND a code change in a
single deploy:

```bash
flyctl secrets set --stage DB_URL=... CACHE_URL=... -a $APP
# no restart yet
flyctl deploy -a $APP --image registry.fly.io/$APP:new-tag
# secrets land in the new release
```

## Project-secret-manager indirection

Many projects use an external secret manager (1Password, AWS Secrets Manager,
Vault) as the source of truth, with Fly secrets as a runtime cache. If your
project does, prefer the project's rotation tooling over direct `flyctl secrets
set` — direct setting bypasses the project audit trail.
