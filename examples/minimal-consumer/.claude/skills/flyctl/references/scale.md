# `/flyctl scale`

Adjust Fly Machines: how many, what VM size, how much memory, what regions.

## Subverbs

| Verb                     | Command                                     | Confirm on prod?       |
| ------------------------ | ------------------------------------------- | ---------------------- |
| `show`                   | `flyctl scale show -a $APP`                 | no                     |
| `count <n>`              | `flyctl scale count $N -a $APP`             | **yes if prod or n=0** |
| `count <n> --region <r>` | `flyctl scale count $N --region $R -a $APP` | **yes if prod or n=0** |
| `vm <preset>`            | `flyctl scale vm $PRESET -a $APP`           | **yes if prod**        |
| `memory <mb>`            | `flyctl scale memory $MB -a $APP`           | **yes if prod**        |

## `scale count 0` is destructive on prod

Scaling to zero machines drains traffic and leaves no warm capacity. Treat it
as a destructive op even on non-prod-flavored apps; gate behind confirmation
unless the operator explicitly passes `--no-confirm`.

## VM presets

Common presets (verify against `flyctl platform vm-sizes`):

| Preset           | vCPU        | Memory | Use case                 |
| ---------------- | ----------- | ------ | ------------------------ |
| `shared-cpu-1x`  | 1 shared    | 256 MB | Small APIs, cron workers |
| `shared-cpu-2x`  | 2 shared    | 512 MB | Medium APIs              |
| `shared-cpu-4x`  | 4 shared    | 1 GB   | Larger Node/Go services  |
| `performance-1x` | 1 dedicated | 2 GB   | Latency-sensitive        |
| `performance-2x` | 2 dedicated | 4 GB   | CPU-bound services       |

Override memory with `--memory`: `flyctl scale vm shared-cpu-1x --memory 512 -a $APP`.

## Multi-region scale

Fly Apps that span multiple regions: scale per-region with `--region`:

```bash
flyctl scale count 2 --region gru -a $APP
flyctl scale count 1 --region cdg -a $APP
flyctl scale show -a $APP  # confirm new layout
```

To list regions: `flyctl platform regions`.

## `auto_stop` / `min_machines_running` interactions

If `fly.toml` sets `min_machines_running = N`, `flyctl scale count` won't reduce
below N (Fly enforces this server-side). To go lower, edit `fly.toml` first
and `flyctl deploy` to apply, then `flyctl scale count` for the new floor.

`auto_stop` and `auto_start` (typical default `true`) cause machines to stop
between requests. This is independent of `scale count`: a `count 2` app with
`auto_stop = true` may show one or zero machines in `started` state at any
moment.

## Memory ceiling

A common cause of OOM-kills is undersized memory. Inspect Fly's metrics
endpoint or watch `flyctl logs -a $APP` for `out of memory`. Bump with
`flyctl scale memory <new-mb>` — the app restarts.

## Verification

After any scale change, confirm:

```bash
flyctl scale show -a $APP
flyctl machines list -a $APP --json | jq '.[] | {id, state, region, size: .config.guest.cpus}'
```
