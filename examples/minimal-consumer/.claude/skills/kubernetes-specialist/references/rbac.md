# RBAC

## Key Concepts

- **Role / ClusterRole** — defines a set of allowed verbs on resources. Role is namespace-scoped; ClusterRole is cluster-wide.
- **RoleBinding / ClusterRoleBinding** — grants a Role or ClusterRole to a subject (User, Group, ServiceAccount).
- **ServiceAccount** — identity for pods; every pod runs as a ServiceAccount (default if not specified).
- **Least privilege** — pods should only have the exact verbs and resources they need, scoped to the tightest namespace possible.

## Common Patterns

```yaml
# Narrow Role: allow a pod to read ConfigMaps in its own namespace
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: configmap-reader
  namespace: my-app
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
```

```yaml
# ServiceAccount bound to the Role above
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app-sa
  namespace: my-app
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-app-configmap-reader
  namespace: my-app
subjects:
  - kind: ServiceAccount
    name: my-app-sa
roleRef:
  kind: Role
  name: configmap-reader
  apiGroup: rbac.authorization.k8s.io
```

Never use the `default` ServiceAccount for application workloads — create a dedicated one.

## Checklist

- [ ] Each workload uses a dedicated ServiceAccount (not `default`).
- [ ] No ServiceAccount has `cluster-admin` or wildcard resource/verb grants.
- [ ] ClusterRoleBindings are justified — use RoleBinding in a specific namespace wherever possible.
- [ ] `kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa>` reviewed for each workload SA.
- [ ] Automounting of ServiceAccount tokens disabled if the pod doesn't call the API: `automountServiceAccountToken: false`.

## Gotchas

- `ClusterRoleBinding` to a namespace-scoped ServiceAccount grants cluster-wide access — double-check the binding kind.
- `*` in `verbs` or `resources` is almost never the right answer outside of cluster-admin bootstrapping.
- RBAC denies are silent from the application's perspective — the pod gets a 403 with no indication of which rule denied it. Use `kubectl auth can-i` to test before deploying.
- Aggregated ClusterRoles (using `aggregationRule`) can silently gain permissions when new ClusterRoles with matching labels are installed (e.g., by a Helm chart).
