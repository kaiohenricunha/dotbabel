---
id: flyctl
name: flyctl
type: skill
version: 1.0.0
domain: [infra, devex, observability]
platform: [flyio]
task: [runtime-ops, diagnostics, incident-response]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-10
updated: 2026-05-10
description: >
  Explicit-invocation Fly.io operations wrapper. Run `/flyctl <subcommand>` to
  deploy (with --image), tail logs, manage secrets, inspect machines, scale,
  SSH, proxy, check health, list releases, and show status. Auto-discovers
  the app from fly.toml in the current directory. Side-effectful ops on
  prod-flavored apps require typed confirmation matching the app name.
  Rollback is delegated to /rollback-prod; cross-provider SHA reporting is
  delegated to /deploy-status. Unlisted subcommands require
  `flyctl <subcommand> --help` first.
argument-hint: "<subcommand> [-a <app>] [--no-confirm] [...]"
tools: Bash, Read, Grep, Glob
model: sonnet
effort: medium
disable-model-invocation: true
user-invocable: true
---

# flyctl

Portable Fly.io operations wrapper. Invoke as `/flyctl <subcommand>`.

## When to Use

This skill is **explicit-invocation only** (`disable-model-invocation: true`).
The operator must type `/flyctl <subcommand>` directly; the model must not
auto-route phrases like "tail fly logs" or "fly deploy" to this side-effectful
skill.

Use `/flyctl` from a Fly.io app directory containing `fly.toml`, or pass
`-a <app>` to override auto-discovery.

## Out of Scope

This skill does **not** perform rollback or cross-provider release reporting.

- For rollback to the previous release, use `/rollback-prod`.
- For deployed git-SHA reporting across Vercel/Fly/AWS, use `/deploy-status`.
- For app provisioning (`fly launch`, region setup), use the Fly UI or your IaC layer.
- For any subcommand not listed in the table or reference files, run
  `flyctl <subcommand> --help` for canonical reference. Read-only verbs (list,
  show, status, info, history, version) may proceed without confirmation;
  mutating verbs (create, destroy, delete, scale, restart, update, set, unset,
  deploy, suspend, resume, regions add/remove, and any verb whose `--help` text
  mentions "destructive", "irreversible", or "will redeploy") MUST be presented
  to the operator with the exact command and require explicit y/N approval before
  executing.

## Auto-Discovery

Every subcommand begins by resolving the CLI binary and the target app. The
operator may override the app with `-a <app>`; otherwise the skill reads the
root `fly.toml` in the current working directory. Multi-app monorepos require
the operator to `cd` into the per-app directory first — this skill refuses to
guess across nested `fly.toml` files.

```bash
# CLI: prefer flyctl, fall back to fly
FLY="$(command -v flyctl || command -v fly || true)"
if [ -z "$FLY" ]; then
  echo "flyctl/fly not on PATH; see https://fly.io/docs/flyctl/install/" >&2
  exit 2
fi

# App: -a flag wins; otherwise parse root fly.toml only.
# Mirrors parseFlyApp() in deploy-ops.mjs — supports leading whitespace
# around the key, optional whitespace around '=', and BOTH double- and
# single-quoted values.
APP="${ARG_APP:-}"
if [ -z "$APP" ]; then
  if [ ! -f fly.toml ]; then
    echo "no fly.toml in $(pwd); pass -a <app> or cd into the app directory" >&2
    exit 2
  fi
  APP="$(sed -nE "s/^[[:space:]]*app[[:space:]]*=[[:space:]]*['\"]([^'\"]+)['\"].*/\1/p" fly.toml | head -n 1)"
fi
[ -z "$APP" ] && { echo "could not resolve app name from fly.toml; pass -a <app>" >&2; exit 2; }

# Auth: existing CLI session only — never prompt
"$FLY" auth whoami >/dev/null 2>&1 \
  || { echo "not authenticated; run: $FLY auth login" >&2; exit 2; }
```

## Subcommands

| Sub                     | Args                                     | Invocation                                                                                                                          | Confirm?               | Reference                               |
| ----------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------- |
| `status`                | `[-a $APP]`                              | `flyctl status -a $APP`                                                                                                             | no                     | –                                       |
| `logs`                  | `[-a $APP] [-i ID] [--region R]`         | `flyctl logs -a $APP $EXTRA`                                                                                                        | no                     | [`logs.md`](references/logs.md)         |
| `releases`              | `[-a $APP] [--image]`                    | `flyctl releases -a $APP --json`                                                                                                    | no                     | [`releases.md`](references/releases.md) |
| `deploy`                | `[-a $APP] [--image REF] [--strategy S]` | `flyctl deploy -a $APP --image $REF`                                                                                                | **YES if prod**        | [`deploy.md`](references/deploy.md)     |
| `secrets list`          | `[-a $APP]`                              | `flyctl secrets list -a $APP`                                                                                                       | no                     | [`secrets.md`](references/secrets.md)   |
| `secrets set`           | `[-a $APP] [--stage] K=V...`             | `flyctl secrets set -a $APP $KV`                                                                                                    | **YES if prod**        | [`secrets.md`](references/secrets.md)   |
| `secrets unset`         | `[-a $APP] K...`                         | `flyctl secrets unset -a $APP $K`                                                                                                   | **YES if prod**        | [`secrets.md`](references/secrets.md)   |
| `machines list`         | `[-a $APP]`                              | `flyctl machines list -a $APP --json`                                                                                               | no                     | [`machines.md`](references/machines.md) |
| `machines restart <id>` | `[-a $APP]`                              | `flyctl machines restart $ID -a $APP`                                                                                               | no                     | [`machines.md`](references/machines.md) |
| `machines stop <id>`    | `[-a $APP]`                              | `flyctl machines stop $ID -a $APP`                                                                                                  | **YES if prod**        | [`machines.md`](references/machines.md) |
| `machines start <id>`   | `[-a $APP]`                              | `flyctl machines start $ID -a $APP`                                                                                                 | no                     | [`machines.md`](references/machines.md) |
| `machines destroy <id>` | `[-a $APP]`                              | `flyctl machines destroy $ID --force -a $APP`                                                                                       | **YES if prod**        | [`machines.md`](references/machines.md) |
| `scale show`            | `[-a $APP]`                              | `flyctl scale show -a $APP`                                                                                                         | no                     | [`scale.md`](references/scale.md)       |
| `scale count <n>`       | `[-a $APP]`                              | `flyctl scale count $N -a $APP`                                                                                                     | **YES if prod or n=0** | [`scale.md`](references/scale.md)       |
| `scale vm <preset>`     | `[-a $APP] [--memory MB]`                | `flyctl scale vm $P -a $APP`                                                                                                        | **YES if prod**        | [`scale.md`](references/scale.md)       |
| `scale memory <mb>`     | `[-a $APP]`                              | `flyctl scale memory $MB -a $APP`                                                                                                   | **YES if prod**        | [`scale.md`](references/scale.md)       |
| `ssh console`           | `[-a $APP] [-s ID]`                      | `flyctl ssh console -a $APP`                                                                                                        | no (interactive)       | [`ssh.md`](references/ssh.md)           |
| `ssh console -C <cmd>`  | `[-a $APP] [-s ID]`                      | `flyctl ssh console -C "$CMD" -a $APP`                                                                                              | **YES if prod**        | [`ssh.md`](references/ssh.md)           |
| `ssh sftp`              | `[-a $APP]`                              | `flyctl ssh sftp shell -a $APP`                                                                                                     | no                     | [`ssh.md`](references/ssh.md)           |
| `proxy`                 | `<local:remote> [-a $APP]`               | `flyctl proxy $P -a $APP`                                                                                                           | no                     | [`proxy.md`](references/proxy.md)       |
| `health`                | `[-a $APP] [--path P]`                   | discover endpoints from `fly.toml`, proxy + curl                                                                                    | no                     | [`health.md`](references/health.md)     |
| _any other_             | –                                        | run `flyctl <cmd> --help`, classify the verb, **stop and prompt for explicit operator approval before executing any mutating verb** | per-op                 | –                                       |

## Confirmation Contract

Destructive ops on prod-flavored apps require the operator to type the exact app
name. The heuristic for "prod-flavored" is: app name does NOT match
`*-staging*`, `*-preview*`, `*-pr-*`, `*-dev*`, or `*-test*`.

> **Heuristic is best-effort.** App names that _contain_ these substrings but
> are nonetheless prod (e.g. `my-developer-portal`, `payments-test-of-record`)
> will silently skip the confirmation gate. Until v1.1 ships `confirm_always`
> config, use `--no-confirm` deliberately for known non-prod apps with unusual
> names, and add a comment in your runbook for prod apps that would false-match.

```bash
# no_confirm_flag MUST be derived ONLY from an explicitly parsed --no-confirm
# flag in $@. The skill never reads any environment variable (e.g. NO_CONFIRM)
# as a bypass — operator intent must be on the command line for each invocation.
confirm_if_prod() {
  local app="$1" op="$2" no_confirm_flag="$3"
  [ "$no_confirm_flag" = "1" ] && return 0
  case "$app" in
    *-staging*|*-preview*|*-pr-*|*-dev*|*-test*) return 0 ;;
  esac
  printf 'About to run %s on PROD app %s.\nType the app name to confirm: ' "$op" "$app" >&2
  read -r reply < /dev/tty || { echo "no interactive TTY; pass --no-confirm explicitly or run interactively" >&2; exit 2; }
  [ "$reply" = "$app" ] || { echo "confirmation failed" >&2; exit 1; }
}

# Argument-parsing stub the skill MUST follow before calling confirm_if_prod:
no_confirm_flag=0
parsed=()
for arg in "$@"; do
  case "$arg" in
    --no-confirm) no_confirm_flag=1 ;;
    *) parsed+=("$arg") ;;
  esac
done
set -- "${parsed[@]}"
```

Lighter than `/rollback-prod`'s `ROLLBACK PROD` literal because deploy/scale are
less catastrophic than rollback; typing the app name is harder to muscle-memory
than a fixed string and is context-aware. Confirmation bypass derives from the
parsed CLI flag only — env vars cannot grant it.

## Rules

- Auto-discover `app` from root `fly.toml`; never hardcode names, regions, VM presets, or secret names.
- Resolve CLI as `flyctl` first, `fly` second; never re-install.
- Use existing CLI auth (`flyctl auth whoami`); never prompt for tokens.
- Destructive ops on prod-flavored apps require typed confirmation matching the app name.
- `--no-confirm` is honored only when passed explicitly as a deliberate operator flag; never via env, templates, or instructions that may reach automated invocations.
- Print the exact `flyctl ...` command before executing (audit trail — terminal scrollback only, not durable).
- Preserve flyctl native exit codes; remap only discovery/auth failures to `2`.
- Multi-app monorepos: refuse to guess — operator must `cd` into the app dir or pass `-a <app>`.
- Never echo secret values to chat — only names.
- For unlisted subcommands: run `flyctl <subcommand> --help` first, classify mutability from the verb and the help text, and **require explicit operator y/N approval before executing any mutating op**. Read-only verbs (`list`, `show`, `status`, `info`, `history`, `version`) may run without prompting.

## Failure Modes

| Condition                                | Exit | Behavior                                                                      |
| ---------------------------------------- | ---- | ----------------------------------------------------------------------------- |
| Success                                  | `0`  | preserve flyctl exit                                                          |
| Confirmation declined / flyctl exit 1    | `1`  | preserve                                                                      |
| No `fly.toml` in cwd and no `-a`         | `2`  | print: "no fly.toml in `<pwd>`; pass -a `<app>` or cd into the app directory" |
| `flyctl`/`fly` not on PATH               | `2`  | print install URL                                                             |
| `auth whoami` fails                      | `2`  | print `flyctl auth login`                                                     |
| `fly.toml` exists but `app` line missing | `2`  | print: "could not resolve app name from fly.toml; pass -a `<app>`"            |
| Invalid `--image` ref (pre-flight regex) | `2`  | print expected format                                                         |

## Optional Config

**This file is NOT consumed by v1.0.0.** It documents the v1.1 config surface
so contributors can preview it. Operators whose prod apps don't match
`*-staging*` / `*-preview*` / `*-pr-*` / `*-dev*` / `*-test*` will get
typed-confirmation prompts on every mutating op until v1.1 wires `confirm_never`
to override the heuristic; pass `--no-confirm` per-invocation until then.

See [`examples/fly-targets.example.json`](examples/fly-targets.example.json).

Planned v1.1 config schema (not yet wired — for preview only):

| Key                     | Type       | Semantics                                                                                        |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `confirm_always`        | `string[]` | App names that always require typed confirmation, regardless of the prod-name heuristic.         |
| `confirm_never`         | `string[]` | App names that never require typed confirmation (overrides heuristic for known non-prod apps).   |
| `deploy.strategy`       | `string`   | Default `--strategy` value for `flyctl deploy` (e.g. `bluegreen`). Overridable per-invocation.   |
| `deploy.require_digest` | `boolean`  | If `true`, reject `--image` refs without a `@sha256:` digest suffix (enforce immutable deploys). |

When v1.1 wires this file, it will be read via `jq` from `.claude/flyctl.json` at skill startup.

## See also

- [`/deploy-status`](../deploy-status/SKILL.md) — read-only SHA / release status across all configured deploy targets (use this when you want a snapshot, not an action).
- [`/rollback-prod`](../rollback-prod/SKILL.md) — confirmation-gated rollback across all targets (use this for incident response; `/flyctl` is for non-incident, fly-only ops).
