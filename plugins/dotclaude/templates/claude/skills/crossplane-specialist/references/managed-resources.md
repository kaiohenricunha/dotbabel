# Managed Resources

## Key Concepts

- **Managed resource**: a Crossplane CRD that represents a single cloud API resource (e.g., `Bucket`, `Instance`, `VPC`)
- **`external-name` annotation**: the identifier used by the provider to find or create the real cloud resource; format is provider-specific
- **`deletionPolicy`**: controls what happens to the cloud resource when the managed resource is deleted — `Delete` (default, destroys cloud resource) or `Orphan` (removes from management, leaves cloud resource intact)
- **`forProvider`**: the spec section holding cloud-provider-specific configuration; maps to the real API parameters
- **Reconciliation**: the provider continuously compares the managed resource spec to the real cloud resource and applies corrections

## Common Patterns

**Setting external-name for adoption**:

```yaml
metadata:
  annotations:
    crossplane.io/external-name: my-existing-s3-bucket
```

This tells Crossplane to adopt the existing bucket rather than create a new one. The name in `metadata.name` is the Kubernetes name; `external-name` is the cloud name.

**Safe deletion for stateful resources**:

```yaml
spec:
  deletionPolicy: Orphan
```

Use `Orphan` for RDS instances, S3 buckets with data, and any resource where accidental deletion has data-loss consequences. Reserve `Delete` for ephemeral resources (security groups, IAM roles created by the Composition).

**Checking resource health**:

```bash
kubectl describe rdsinstance.rds.aws.upbound.io <name>
# Look for: READY: True, SYNCED: True
# Events section shows reconciliation errors
```

**Managed resource naming**: Crossplane generates a unique name for managed resources created by a Composition if not explicitly patched. Patch `metadata.name` using the Composite name as a prefix to make debugging traceable.

## Checklist

- [ ] `deletionPolicy` explicitly set — never rely on the default for stateful resources
- [ ] `external-name` annotation set when adopting existing cloud resources
- [ ] `READY` and `SYNCED` conditions monitored in production
- [ ] Managed resource names are traceable back to their Claim (patch from `metadata.name`)
- [ ] `forProvider.region` or equivalent is patched from the Composite, not hardcoded
- [ ] Provider CRD version matches the installed provider package version

## Gotchas

**`SYNCED: False` does not always mean an error.** Crossplane sets `SYNCED: False` during the initial creation phase and during updates. Check the `conditions` and `events` fields to distinguish a transient sync from a persistent error — a managed resource that has been `SYNCED: False` for more than a few minutes almost always has an actionable error message in the conditions.
