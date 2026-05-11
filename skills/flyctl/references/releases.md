# `/flyctl releases`

List Fly.io app releases — version, status, image, deployer, timestamp.

## Forms

```bash
flyctl releases -a $APP                  # human-readable table
flyctl releases -a $APP --json           # structured output for piping
flyctl releases -a $APP --image          # include image refs (some older flyctl versions)
```

## Columns (JSON)

Per release object:

| Field                 | Meaning                                             |
| --------------------- | --------------------------------------------------- |
| `version`             | Monotonic release number (v1, v2, ...)              |
| `status`              | `succeeded`, `failed`, `pending`, `running`         |
| `image_ref` / `image` | Container image reference deployed (when available) |
| `deployer`            | User or bot that triggered the deploy               |
| `created_at`          | ISO 8601 timestamp                                  |
| `description`         | Deploy reason or release-command summary            |

## Common queries

```bash
# Most recent successful release
flyctl releases -a $APP --json \
  | jq -r '[.[] | select(.status=="succeeded")][0]'

# Diff the two most recent releases' image refs
flyctl releases -a $APP --json \
  | jq -r '.[0:2] | map(.image_ref // .image) | @tsv'

# Find releases by a specific deployer
flyctl releases -a $APP --json \
  | jq '.[] | select(.deployer=="github-actions[bot]")'
```

## Cross-reference with deploy status

`/flyctl releases` shows the release sequence; `/deploy-status` resolves the
deployed git SHA and compares against `origin/main`. Together:

```bash
# Latest release
flyctl releases -a $APP --json | jq -r '.[0] | {version, image_ref, created_at}'

# Compare against main (cross-provider, includes Vercel/AWS too)
# /deploy-status
```

## Failed-release recovery

If the most recent release shows `status: "failed"`, the previous successful
release is still serving traffic. Roll forward (fix + redeploy) is usually the
right answer, not roll back. For an explicit rollback to the previous
succeeded release, use `/rollback-prod` (this skill does not roll back).

To inspect why a release failed:

```bash
flyctl logs -a $APP --no-tail 2>&1 | head -100   # release_command output is in logs
flyctl releases -a $APP --json | jq '.[0].description'
```

## See also

- [`/deploy-status`](../../deploy-status/SKILL.md) — read-only SHA reconciliation.
- [`/rollback-prod`](../../rollback-prod/SKILL.md) — gated rollback to previous release.
