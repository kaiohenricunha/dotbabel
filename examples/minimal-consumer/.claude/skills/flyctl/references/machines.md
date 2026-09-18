# `/flyctl machines`

Inspect and manipulate individual Fly Machines under an app.

## Verbs

| Verb           | Command                                        | Confirm on prod? |
| -------------- | ---------------------------------------------- | ---------------- |
| `list`         | `flyctl machines list -a $APP --json`          | no               |
| `status <id>`  | `flyctl machines status <id> -a $APP`          | no               |
| `restart <id>` | `flyctl machines restart <id> -a $APP`         | no (transient)   |
| `stop <id>`    | `flyctl machines stop <id> -a $APP`            | **yes**          |
| `start <id>`   | `flyctl machines start <id> -a $APP`           | no               |
| `destroy <id>` | `flyctl machines destroy <id> --force -a $APP` | **yes**          |

## List with JSON for scripting

```bash
flyctl machines list -a $APP --json | jq '.[] | {id, name, state, checks: .checks[]?.status}'
```

State values: `created`, `started`, `stopped`, `suspended`, `replacing`,
`destroyed`, `destroying`.

## Machine IDs are volatile

After `flyctl scale count`, `flyctl machines destroy`, or `flyctl deploy
--strategy bluegreen`, the set of machine IDs changes. Always re-query before
targeting:

```bash
ids=$(flyctl machines list -a $APP --json | jq -r '.[].id')
```

## `stop` vs `apps suspend`

| Action                         | Scope                            | Reversible?                          |
| ------------------------------ | -------------------------------- | ------------------------------------ |
| `flyctl machines stop <id>`    | One machine                      | yes — `flyctl machines start <id>`   |
| `flyctl scale count 0 -a $APP` | All machines, app stays          | yes — scale back up                  |
| `flyctl apps suspend -a $APP`  | Whole app, traffic blocked       | yes — `flyctl apps resume -a $APP`   |
| `flyctl apps destroy -a $APP`  | App + machines + volumes deleted | **no** — out of scope for this skill |

## Stuck `stopped` machines

With `auto_stop = true` in `fly.toml`, a machine in `stopped` state is normal
behavior between requests. Only intervene if:

- ALL machines are stopped AND traffic should be active
- A machine has been stopped for > 5 minutes AND health checks were failing
  before it stopped (suggests OOM-kill or panic)

To force-wake one:

```bash
ID=$(flyctl machines list -a $APP --json | jq -r '.[] | select(.state=="stopped") | .id' | head -1)
flyctl machines start "$ID" -a $APP
```

## Destroy

`flyctl machines destroy <id> --force` is irreversible from this skill's
perspective. Always confirm on prod. After destruction, a `flyctl deploy` will
recreate machines from the latest release.

For full app destruction (`flyctl apps destroy`), this skill refuses — use the
Fly UI explicitly.
