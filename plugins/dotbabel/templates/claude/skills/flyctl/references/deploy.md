# `/flyctl deploy`

Deploy a Fly.io app from source or from a pre-built container image.

## Pre-flight: validate `--image` reference

Before invoking `flyctl deploy --image`, validate the image reference matches the
expected format. Reject anything that doesn't match:

```bash
IMAGE_RE='^[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$'
if ! echo "$IMAGE" | grep -Eq "$IMAGE_RE"; then
  echo "invalid image ref: $IMAGE" >&2
  echo "expected: <registry>/<repo>[:tag][@sha256:<digest>]" >&2
  exit 2
fi
```

**Strongly recommend digest pinning** (`@sha256:...`) for production deploys. A
mutable `:tag` reference is resolved by Fly's builder at deploy time and
introduces ambiguity if the registry is repushed mid-deploy.

If `--image` is missing the digest, warn but do not block:

```bash
case "$IMAGE" in
  *@sha256:*) ;;
  *) echo "warning: deploying mutable tag $IMAGE — recommend digest pinning" >&2 ;;
esac
```

## Source vs image deploys

| Form                   | Command                                                   | When to use                                               |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| Source build (default) | `flyctl deploy -a $APP`                                   | Local source + Dockerfile, builder runs on Fly            |
| Source, remote builder | `flyctl deploy -a $APP --remote-only`                     | No local Docker; offload to Fly's remote builder          |
| Source, local builder  | `flyctl deploy -a $APP --local-only`                      | Force local Docker (faster iteration on big images)       |
| Pre-built image        | `flyctl deploy -a $APP --image $REF`                      | CI built the image and pushed to a registry; just promote |
| Pre-built, no fly.toml | `flyctl deploy -a $APP --image $REF --strategy bluegreen` | Need explicit strategy override                           |

## `--strategy` semantics

| Strategy            | Behavior                                                   | Use when                                                |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| `immediate`         | All machines updated at once; brief outage                 | Single-machine dev/preview apps                         |
| `rolling` (default) | One machine at a time                                      | Most multi-machine apps                                 |
| `bluegreen`         | Spin up new machines alongside old, swap traffic           | Zero-downtime prod deploys; doubles cost during rollout |
| `canary`            | Deploy to one machine, hold for health check, then proceed | High-risk releases                                      |

Read the value from `fly.toml` `deploy.strategy` first; honor an explicit
`--strategy` override only when the operator passes it.

## `--build-arg` and `--build-secret`

Repeatable. Form: `--build-arg KEY=VALUE`. Build secrets are not persisted in
the image (Docker buildkit secret-mount semantics):

```bash
flyctl deploy -a $APP --build-arg NODE_ENV=production --build-secret npmrc="$(cat .npmrc)"
```

Never paste secret values into chat. If a build secret is needed, prompt the
operator for the source.

## `release_command` failure

If `fly.toml` defines `[deploy].release_command`, Fly runs it in a one-shot
machine after the build and before swapping traffic. A non-zero exit aborts the
deploy. Common causes:

- Database migration failure — check `flyctl logs -a $APP` for the one-shot
  machine output
- Missing env/secret in the new release — check the secrets diff against the
  previous release with `flyctl releases -a $APP --json | jq '.[0:2]'`

Recovery: roll back via `/rollback-prod` (this skill does NOT do rollback).

## Confirmation rail

For prod-flavored apps, always run `confirm_if_prod "$APP" deploy "$no_confirm_flag"`
before invoking `flyctl deploy`. The operator must type the exact app name to
proceed. `--no-confirm` is only honored when passed explicitly on the command
line.

## Post-deploy verification

After `flyctl deploy` returns 0, verify the new release is healthy:

```bash
flyctl status -a "$APP"
flyctl releases -a "$APP" --json | jq '.[0]'
```

For end-to-end health, see [`health.md`](health.md) for the `flyctl proxy` + curl
pattern.

## See also

- [`/rollback-prod`](../../rollback-prod/SKILL.md) — rollback the release this deploy created.
- [`/deploy-status`](../../deploy-status/SKILL.md) — confirm the new SHA matches `origin/main`.
