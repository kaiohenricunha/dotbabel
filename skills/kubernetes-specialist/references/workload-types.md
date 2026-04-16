# Workload Types

## Key Concepts

- **Deployment** — stateless replicas with rolling updates; no stable pod identity or ordered startup.
- **StatefulSet** — stable network identity and ordered startup/teardown; required for databases and clustered systems that need persistent identity.
- **DaemonSet** — exactly one pod per node; for node-level agents, log collectors, and network plugins.
- **Job / CronJob** — run-to-completion semantics; for batch processing, migrations, and scheduled tasks.

## Common Patterns

```yaml
# Deployment — default for stateless services
kind: Deployment
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
      maxSurge: 1
```

Use `maxUnavailable: 0` + `maxSurge: 1` for zero-downtime rolling updates.

```yaml
# StatefulSet — for ordered, identity-sensitive workloads
kind: StatefulSet
spec:
  serviceName: "my-service" # should reference a headless Service (clusterIP: None) for stable pod DNS identity
  podManagementPolicy: OrderedReady
```

`OrderedReady` ensures pods start one at a time. Use `Parallel` only if startup order truly doesn't matter.

## Checklist

- [ ] Does the workload need stable network identity? → StatefulSet
- [ ] Does it need persistent per-pod storage? → StatefulSet with `volumeClaimTemplates`
- [ ] Is it a node-level agent? → DaemonSet
- [ ] Is it a one-time or scheduled task? → Job or CronJob
- [ ] Otherwise: Deployment

## Gotchas

- Switching an existing Deployment to a StatefulSet requires manual data migration — plan before choosing.
- DaemonSets ignore replica counts; pod count equals node count automatically.
- CronJob concurrencyPolicy defaults to `Allow` — add `Forbid` to prevent job pile-up if a previous run is still running.
- StatefulSet scale-down is ordered: pod N is deleted before pod N-1.
