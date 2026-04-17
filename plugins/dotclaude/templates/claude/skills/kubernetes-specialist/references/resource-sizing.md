# Resource Sizing

## Key Concepts

- **Requests** — minimum guaranteed CPU/memory; used by the scheduler for placement decisions.
- **Limits** — maximum CPU/memory; CPU is throttled at the limit, memory triggers OOMKill.
- **QoS classes** — `Guaranteed` (requests == limits), `Burstable` (requests < limits), `BestEffort` (no requests or limits). BestEffort pods are evicted first under pressure.
- **VPA** — Vertical Pod Autoscaler; recommends or automatically adjusts requests/limits based on observed usage.
- **HPA** — Horizontal Pod Autoscaler; scales replica count based on metrics (CPU, memory, custom).

## Common Patterns

```yaml
resources:
  requests:
    cpu: "250m"
    memory: "128Mi"
  limits:
    cpu: "500m"
    memory: "256Mi"
```

Start with requests at ~50% of expected peak and limits at ~2×requests. Tune with observed data.

```yaml
# HPA — scale on CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
```

Target 60–70% CPU utilization to leave headroom before scale-out.

## Checklist

- [ ] All pods have requests set (required for scheduler placement and QoS assignment).
- [ ] Memory limits set for all containers (prevents runaway memory from OOMKilling neighbors).
- [ ] CPU limits reviewed — overly low CPU limits cause throttling without OOMKill symptoms.
- [ ] HPA `minReplicas` ≥ 2 for production workloads (single replica = no rolling update headroom).
- [ ] VPA in `Off` or `Initial` mode before enabling `Auto` — validate recommendations first.

## Gotchas

- CPU throttling is silent — the pod runs but slowly. Always check CPU throttling metrics before concluding a pod is memory-bound; in Prometheus-based setups, derive a throttling ratio from `container_cpu_cfs_throttled_periods_total` and `container_cpu_cfs_periods_total`.
- Setting memory limit == memory request (Guaranteed QoS) prevents bursting but also protects from eviction.
- HPA and VPA conflict on the same workload — use one or the other, not both, unless using VPA in recommendation-only mode.
- Namespace `LimitRange` objects set defaults for containers without explicit resource specs — always check for LimitRanges when sizing behaves unexpectedly.
