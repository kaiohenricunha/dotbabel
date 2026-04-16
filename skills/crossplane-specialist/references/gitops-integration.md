# GitOps Integration

## Key Concepts

- **Package management**: Crossplane `Provider` and `Configuration` CRDs are package references — Crossplane installs and upgrades them automatically when the image tag changes
- **Argo CD health checks**: custom health assessment rules for Crossplane composite types; without them, Argo CD marks Composites `Healthy` as soon as they are created, regardless of readiness
- **Flux**: syncs Crossplane manifests (XRDs, Compositions, Claims) from Git; `HelmRelease` for Crossplane itself; `Kustomization` for Claims
- **Claim as GitOps artifact**: each developer environment or tenant gets a Claim committed to Git; the Composition turns it into real infrastructure
- **Package revision pinning**: pin `Provider` and `Configuration` to an immutable digest (not a mutable tag) for deterministic deployments

## Common Patterns

**Argo CD health check for Composite**:

```yaml
# In Argo CD ConfigMap argocd-cm
resource.customizations.health.platform.example.com_XPostgreSQLInstance: |
  hs = {}
  if obj.status ~= nil then
    if obj.status.conditions ~= nil then
      for i, condition in ipairs(obj.status.conditions) do
        if condition.type == "Ready" and condition.status == "True" then
          hs.status = "Healthy"
          hs.message = "Composite is ready"
          return hs
        end
        if condition.type == "Ready" and condition.status == "False" then
          hs.status = "Degraded"
          hs.message = condition.message
          return hs
        end
      end
    end
  end
  hs.status = "Progressing"
  hs.message = "Waiting for composite to become ready"
  return hs
```

**Provider package pinning**:

```yaml
apiVersion: pkg.crossplane.io/v1
kind: Provider
metadata:
  name: provider-aws-s3
spec:
  package: xpkg.upbound.io/upbound/provider-aws-s3:v1.14.0
  packagePullPolicy: IfNotPresent
```

**Claim directory layout in Git**:

```
claims/
├── staging/
│   └── database.yaml      # PostgreSQLInstance Claim
└── prod/
    └── database.yaml
```

Flux or Argo CD watches `claims/<env>/` and applies on change. Gate `prod/` with a PR approval requirement.

## Checklist

- [ ] Argo CD custom health checks defined for all XRD kinds
- [ ] Provider packages pinned to immutable digests or versioned tags
- [ ] `packagePullPolicy: IfNotPresent` for production stability
- [ ] Claim files committed to Git with environment-scoped directories
- [ ] PR approvals required for `prod/` claims directory
- [ ] Flux / Argo CD health shown in CI before merging Claim changes

## Gotchas

**Argo CD will mark a Composite `Healthy` immediately without custom health checks.** The default health assessment for unknown CRDs is `Healthy` as soon as the object exists. This means a stuck or error-state Composite appears green in the Argo CD UI. Always define custom health checks for every XRD kind exposed to developers.
