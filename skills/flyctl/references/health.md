# `/flyctl health`

Run a quick health check against the app's HTTP endpoints via `flyctl proxy` and
`curl`. Endpoints are **NOT universal** — every project picks its own
(`/livez`, `/readyz`, `/healthz`, `/_health`, none-at-all). This skill never
hardcodes paths; it discovers them from `fly.toml` or asks the operator.

## Discovery strategy

1. **Parse `fly.toml`** for health-check paths. Fly supports two main forms:

   ```toml
   # Form A (current)
   [[http_service.checks]]
   path = "/healthz"
   interval = "10s"

   # Form B (legacy v2 services)
   [[services.http_checks]]
   path = "/healthz"
   ```

   Extract paths:

   ```bash
   paths=$(grep -E '^[[:space:]]*path[[:space:]]*=' fly.toml | sed -E 's/.*path[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')
   ```

2. **Override via `--path`** if the operator passes a specific endpoint:

   ```bash
   /flyctl health --path /custom-health
   ```

3. **Fallback prompt** when no checks are configured AND no `--path` was given.
   Ask the operator:

   > No health-check paths found in `fly.toml`. Provide one (e.g. `/healthz`)
   > or use `--path <p>`.

   Do NOT guess `/livez` / `/readyz` / `/healthz` — many apps don't expose
   those, and a 404 from a guessed path is worse than no check at all.

## Probe via `flyctl proxy`

```bash
INTERNAL_PORT=$(awk -F'=' '/^[[:space:]]*internal_port[[:space:]]*=/{gsub(/[[:space:]]/,""); print $2; exit}' fly.toml)
INTERNAL_PORT="${INTERNAL_PORT:-8080}"
LOCAL_PORT=18080

flyctl proxy "$LOCAL_PORT:$INTERNAL_PORT" -a "$APP" &
PROXY_PID=$!
sleep 2

for p in $paths; do
  echo "=== $p ==="
  curl -sf -w 'HTTP %{http_code} in %{time_total}s\n' "http://localhost:$LOCAL_PORT$p" || echo "FAILED: $p"
done

kill $PROXY_PID 2>/dev/null
wait $PROXY_PID 2>/dev/null || true
```

## Authenticated endpoints

Some apps gate health endpoints behind a header (e.g. `X-Admin-Secret`). Don't
auto-fetch the secret from `flyctl secrets` (values are not retrievable —
secrets are write-only from outside the running app). Either:

- The operator pastes the secret into the prompt (skill never logs it)
- The operator runs the curl manually after the proxy is up
- The app exposes a public, unauthenticated liveness path (recommended)

## Multi-endpoint sequencing

If `fly.toml` declares multiple checks (e.g., `/livez` + `/readyz`), probe both
in order. Stop on the first failure and surface that endpoint's response body
to the operator for triage.

## Interpretation

| Outcome                     | Meaning                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| All paths 2xx               | App is responding                                                             |
| Liveness 2xx, readiness 5xx | Process is up but dependencies (DB, cache) are unhealthy                      |
| All paths timeout           | Machine likely stopped or unreachable — check `flyctl status`                 |
| 404 on a documented path    | Path mismatch — verify the path against the running code, not just `fly.toml` |

## Project-specific health workflows

This reference covers generic discovery. Project-specific multi-step health
playbooks (e.g., "after deploy, check `/livez`, `/readyz`, `/api/data-health`,
then Sentry") belong in a project-scoped slash command that calls `/flyctl
health` plus any project-specific endpoints.
