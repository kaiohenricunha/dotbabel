# Networking

## Key Concepts

- **ClusterIP** — stable virtual IP reachable only inside the cluster; the default Service type.
- **NodePort** — exposes a port on every node's IP; useful for debugging, not for production ingress.
- **LoadBalancer** — provisions a cloud load balancer; use for external traffic entry points.
- **Ingress / Gateway API** — L7 routing rules (host, path) pointing to ClusterIP Services.
- **NetworkPolicy** — pod-level firewall rules; default is allow-all unless a policy selects a pod.
- **CoreDNS** — cluster-internal DNS; `<service>.<namespace>.svc.cluster.local` resolves to ClusterIP.

## Common Patterns

```yaml
# Default-deny all ingress for a namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
spec:
  podSelector: {} # selects all pods in namespace
  policyTypes:
    - Ingress
```

Apply default-deny first, then add explicit allow policies per service.

```yaml
# Allow ingress only from pods with label app=frontend
spec:
  podSelector:
    matchLabels:
      app: backend
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - port: 8080
```

## Checklist

- [ ] Services use `ClusterIP` unless external access is needed.
- [ ] Ingress or Gateway API used for L7 routing — not NodePort in production.
- [ ] Default-deny NetworkPolicy in place for sensitive namespaces.
- [ ] `kubectl get endpoints <svc>` shows populated IPs (empty endpoints = selector mismatch).
- [ ] DNS resolution tested: `kubectl run -it --rm debug --image=busybox -- nslookup <svc>.<ns>`.

## Gotchas

- NetworkPolicy is additive — multiple policies selecting the same pod create a union, not an intersection. A allow-all policy defeats a default-deny.
- NodePort range is cluster-wide and fixed at provision time; changing it requires cluster reconfiguration.
- Ingress `pathType: Prefix` matches `/api` and `/api/v2`, but not `/apistuff`; use `Exact` when strict matching is required.
- CoreDNS caches by TTL; stale DNS after a Service update can persist for seconds. Reduce TTL in CoreDNS configmap if immediate propagation is needed.
- Services with `sessionAffinity: ClientIP` route all requests from one client to one pod — this hides load imbalances.
