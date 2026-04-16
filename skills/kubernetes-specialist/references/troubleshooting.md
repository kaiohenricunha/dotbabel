# Troubleshooting

## Key Concepts

- **Events** — the primary signal for cluster-level issues; always check events before logs.
- **Pod phases** — `Pending`, `Running`, `Succeeded`, `Failed`, `Unknown`. Each phase has distinct diagnostic paths.
- **CrashLoopBackOff** — the container is crashing repeatedly; exponential backoff delay between restarts.
- **OOMKilled** — container exceeded its memory limit; visible in `kubectl describe pod` under Last State.

## Common Patterns

```bash
# Start here: what's wrong in the namespace?
kubectl get pods -n <ns> -o wide
kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -30

# Pod stuck Pending
kubectl describe pod <pod> -n <ns>
# Look for: Insufficient cpu/memory, no nodes matching affinity, taint/toleration

# CrashLoopBackOff
kubectl logs <pod> -n <ns> --previous --tail=100
# Look for: startup errors, missing env vars, panic/exception on startup

# OOMKilled
kubectl describe pod <pod> -n <ns>
# Look for: Last State → Reason: OOMKilled

# Service not routing
kubectl get endpoints <svc> -n <ns>
# Empty endpoints = label selector mismatch between Service and pods

# ImagePullBackOff
kubectl describe pod <pod> -n <ns>
# Look for: failed to pull image, unauthorized, not found
```

## Checklist

- [ ] Check events first — they usually name the problem before logs do.
- [ ] Check pod `Status.Conditions` for `PodScheduled`, `Initialized`, `ContainersReady`, `Ready`.
- [ ] For network issues: `kubectl get endpoints` before assuming a NetworkPolicy problem.
- [ ] For resource issues: `kubectl describe node` → Conditions and Allocatable vs Requests.
- [ ] For auth issues: `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>`.

## Gotchas

- `kubectl logs` without `--previous` shows the current container's logs, not the one that crashed. Always use `--previous` for CrashLoopBackOff.
- Events are namespace-scoped and expire after ~1 hour by default — capture them early in an incident.
- A pod can be `Running` but not `Ready` (readiness probe failing) and receive no traffic. Check both states.
- `kubectl exec` into a running pod uses the current container's environment — it won't show the failed container's state. Use `kubectl debug` to attach an ephemeral container to a running pod.
- `Unknown` pod phase usually means the node is unreachable — check node status, not pod logs.
