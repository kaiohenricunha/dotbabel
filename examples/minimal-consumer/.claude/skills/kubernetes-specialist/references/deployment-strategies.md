# Deployment Strategies

## Key Concepts

- **Rolling update** — replace pods incrementally; the default Deployment strategy. Zero-downtime for stateless services.
- **Blue/green** — run two full environments simultaneously, shift all traffic at once. Clean cutover; higher resource cost.
- **Canary** — route a small percentage of traffic to the new version before full rollout. Fine-grained blast radius control.
- **Recreate** — stop all old pods, then start new ones. Downtime guaranteed; useful when old and new versions cannot coexist.

## Common Patterns

```yaml
# Rolling update — minimal disruption
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0 # never reduce capacity below desired
    maxSurge: 1 # allow one extra pod during rollout
```

`maxUnavailable: 0` + `maxSurge: 1` is the safest rolling update: capacity never drops, rollout proceeds one pod at a time.

```yaml
# Blue/green — two Deployments, one Service selector swap
# Deploy green, then patch Service:
# kubectl patch service my-app -p '{"spec":{"selector":{"version":"green"}}}'
metadata:
  labels:
    version: green # or blue
```

Service selector swap is atomic at the API level but not at the network level — allow a few seconds for kube-proxy to propagate.

```yaml
# Canary — weighted routing via Ingress (Nginx example)
annotations:
  nginx.ingress.kubernetes.io/canary: "true"
  nginx.ingress.kubernetes.io/canary-weight: "10" # 10% to canary
```

## Checklist

- [ ] Rollback procedure documented and tested before any production deployment.
- [ ] Readiness probe passes on new version before traffic is shifted.
- [ ] For canary: health metrics (error rate, latency) monitored between each traffic shift increment.
- [ ] For blue/green: old environment kept warm until confidence in new version is established.
- [ ] `maxUnavailable: 0` set for services where capacity drops are unacceptable.

## Gotchas

- Rolling updates can briefly run old and new code simultaneously — ensure backward compatibility at API boundaries before rolling.
- Blue/green doubles resource consumption during the cutover window — account for this in capacity planning.
- Canary with session affinity (`sessionAffinity: ClientIP`) routes the same clients to the same version consistently, which can skew error signals.
- `Recreate` strategy causes downtime proportional to pod startup time — only use when version coexistence is impossible (e.g., breaking database schema change).
- Rollback via `kubectl rollout undo` reverts the Deployment spec but not external state (databases, feature flags, message queue schemas).
