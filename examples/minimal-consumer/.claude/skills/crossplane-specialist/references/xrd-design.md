# XRD Design

## Key Concepts

- **`CompositeResourceDefinition` (XRD)**: defines a new API type (kind + schema) that developers use to request infrastructure
- **`spec.group`**: the API group for the Composite and Claim kinds (e.g., `platform.example.com`)
- **`spec.versions`**: one or more versioned OpenAPI schemas; mark one as `served: true, referenceable: true`
- **`spec.claimNames`**: if present, enables a namespace-scoped Claim in addition to the cluster-scoped Composite
- **Open vs closed schema**: `x-kubernetes-preserve-unknown-fields: true` allows extra fields; closed schemas reject unknown keys and are preferred for production

## Common Patterns

**Minimal XRD with Claim**:

```yaml
apiVersion: apiextensions.crossplane.io/v1
kind: CompositeResourceDefinition
metadata:
  name: xpostgresqlinstances.platform.example.com
spec:
  group: platform.example.com
  names:
    kind: XPostgreSQLInstance
    plural: xpostgresqlinstances
  claimNames:
    kind: PostgreSQLInstance
    plural: postgresqlinstances
  versions:
    - name: v1alpha1
      served: true
      referenceable: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                parameters:
                  type: object
                  properties:
                    storageGB:
                      type: integer
                  required: ["storageGB"]
              required: ["parameters"]
```

**Version migration**: add a new version alongside the existing one before removing the old; use conversion webhooks or manual migration for breaking schema changes. Never remove a version that Claims are actively referencing.

**Schema design principle**: design the Claim API from the developer's perspective — hide provider-specific complexity (region codes, instance class naming) behind simple parameters (size: small/medium/large).

## Checklist

- [ ] `spec.group` uses a domain you own (not `crossplane.io`)
- [ ] Schema is closed (no `x-kubernetes-preserve-unknown-fields` at root)
- [ ] `claimNames` defined if namespace-scoped access is needed
- [ ] Required fields explicitly listed in `required: [...]`
- [ ] At least one version marked `referenceable: true`
- [ ] Developer-facing parameters named for intent, not for cloud API concepts
- [ ] XRD applied before the Composition that references it

## Gotchas

**XRD deletion cascades to all Composites and Claims.** Deleting an XRD orphans the cloud resources managed by existing Claims — they lose their controller. Always verify no Claims exist before deleting an XRD: `kubectl get claim --all-namespaces -l crossplane.io/composite=<name>`.
