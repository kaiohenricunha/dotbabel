# Compositions

## Key Concepts

- **Composition**: maps a Composite resource to one or more managed resources; defines the patch-and-transform pipeline
- **`compositeTypeRef`**: links the Composition to its XRD kind and version
- **`resources` list (classic mode)**: list of managed resource templates with `patches`, `transforms`, and `readinessChecks`
- **Pipeline mode**: uses Composition Functions for complex logic; replaces `resources` list with a `pipeline` of function steps
- **Patch-and-transform**: copies field values from Composite spec to managed resource spec; transforms convert types, apply regex, or map enum values
- **`readinessChecks`**: conditions that must be true before the Composite is considered ready

## Common Patterns

**Basic patch from Claim to managed resource**:

```yaml
resources:
  - name: rds-instance
    base:
      apiVersion: rds.aws.upbound.io/v1beta1
      kind: Instance
      spec:
        forProvider:
          region: us-east-1
    patches:
      - type: FromCompositeFieldPath
        fromFieldPath: spec.parameters.storageGB
        toFieldPath: spec.forProvider.allocatedStorage
      - type: FromCompositeFieldPath
        fromFieldPath: metadata.name
        toFieldPath: metadata.name
        transforms:
          - type: string
            string:
              fmt: "%s-rds"
```

**Enum mapping with transform**:

```yaml
transforms:
  - type: map
    map:
      small: db.t3.micro
      medium: db.m5.large
      large: db.m5.4xlarge
```

**Pipeline mode with Function**: use `function-patch-and-transform` for patch logic and add custom Functions (CEL, Go) for complex conditionals that are not expressible as transforms.

**`readinessChecks` for composite readiness**: add a `MatchTrue` check on the managed resource's `Ready` condition to prevent the Composite from becoming ready before the underlying resource is provisioned.

## Checklist

- [ ] `compositeTypeRef` matches the XRD `group`, `kind`, and `version` exactly
- [ ] All required managed resource fields are either hardcoded in `base` or patched from the Composite
- [ ] `readinessChecks` defined so the Composite only reports `Ready` when resources are truly ready
- [ ] Patches use stable `fromFieldPath` — spec fields, not status
- [ ] `metadata.name` or `crossplane.io/external-name` annotation patched to avoid naming collisions
- [ ] `kubectl apply --dry-run=server` passes before applying to a cluster

## Gotchas

**Patches that reference missing paths fail silently in classic mode.** If `fromFieldPath: spec.parameters.foo` does not exist on the Composite, the patch is skipped — not errored. This means a managed resource can be created with a missing field and default to an unexpected value. Use `policy: Required` on patches that must succeed.
