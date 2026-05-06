# Observability

## Key Concepts

- **Liveness probe** — if it fails, the container is restarted. Use for detecting hard deadlocks.
- **Readiness probe** — if it fails, the pod is removed from Service endpoints (no traffic). Use for warmup and temporary unreadiness.
- **Startup probe** — disables liveness and readiness until it passes; for slow-starting containers.
- **Metrics endpoints** — expose application metrics in a scrape-friendly format for collection.
- **Structured logging** — JSON or key=value logs parseable by log aggregators without regex.

## Common Patterns

```yaml
# HTTP readiness + liveness with startup probe
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 0
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  periodSeconds: 5
  failureThreshold: 2

startupProbe:
  httpGet:
    path: /healthz
    port: 8080
  failureThreshold: 30 # 30 × 10s = 5 min startup budget
  periodSeconds: 10
```

Separate `/healthz` (liveness — is the process alive?) from `/ready` (readiness — is it serving traffic?).

```yaml
# Metrics port annotation (Prometheus discovery)
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "9090"
  prometheus.io/path: "/metrics"
```

## Checklist

- [ ] Every container has a readiness probe — services without one receive traffic before they're ready.
- [ ] Liveness probe is not identical to readiness probe — a liveness failure kills the pod, which may cascade.
- [ ] `initialDelaySeconds` removed in favor of `startupProbe` for slow-starting containers.
- [ ] Log output is structured (JSON) with at minimum: timestamp, level, message, service name.
- [ ] Metrics endpoint protected from external exposure (not in the Ingress routes).

## Gotchas

- A liveness probe that checks external dependencies (database, cache) will restart pods during a downstream outage — keep liveness probes local and lightweight.
- `initialDelaySeconds` is a fixed delay that doesn't adapt to actual startup time; `startupProbe` is adaptive and preferred.
- HTTP probes must return 2xx or 3xx — any other code (including 404 on wrong path) is treated as failure.
- Probe timeouts default to 1 second — increase for probes that call endpoints with non-trivial latency.
