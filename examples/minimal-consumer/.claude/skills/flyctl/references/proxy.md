# `/flyctl proxy`

Forward a local port to an internal Fly service.

## Form

```bash
flyctl proxy <local-port>[:<remote-port>] [-a $APP]
```

If `<remote-port>` is omitted, Fly uses the app's primary internal port (read
from `fly.toml` `[services]` or `[http_service]`).

## Common use cases

| Goal                      | Command                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Hit `/healthz` on prod    | `flyctl proxy 8080 -a $APP` → `curl http://localhost:8080/healthz`                                |
| Connect to Fly Postgres   | `flyctl proxy 5432 -a $APP-db` → `psql postgres://...@localhost:5432/...`                         |
| Connect to internal Redis | `flyctl proxy 6379 -a $APP-redis` → `redis-cli -p 6379`                                           |
| Hit admin endpoint        | `flyctl proxy 8080 -a $APP` → `curl -H "X-Admin-Secret: $SECRET" http://localhost:8080/admin/...` |

## `.flycast` internal hostnames

Fly's internal networking exposes apps to each other via `.flycast` and
`.internal` hostnames. `flyctl proxy` is the bridge that brings these into the
operator's local machine. The proxy listens on `127.0.0.1` by default; bind to
all interfaces with `--bind-addr 0.0.0.0:<port>` if you need WSL/host access
(rarely needed).

## Lifecycle

`flyctl proxy` runs in the foreground until killed. Common pattern in scripts:

```bash
flyctl proxy 8080 -a $APP &
PROXY_PID=$!
sleep 2
curl -sf http://localhost:8080/healthz
kill "$PROXY_PID" 2>/dev/null
wait "$PROXY_PID" 2>/dev/null || true
```

Always clean up the proxy PID — leaving it running blocks the port for the next
invocation.

## Authentication

The proxy inherits `flyctl auth` state. If the proxy fails to connect, run
`flyctl auth whoami` to verify the session is valid for the app's org.

## Limitations

- One port per `flyctl proxy` invocation. Multiple internal services require
  multiple background proxies on different local ports.
- TCP only. WebSocket and HTTP/2 work because they ride on TCP, but UDP services
  are not supported.
- Long-running proxies survive flyctl auth refresh; if auth expires mid-session,
  the proxy reports broken pipe and exits.
