# Provider Configs

## Key Concepts

- **`ProviderConfig`**: cluster-scoped resource that tells a Crossplane provider how to authenticate with a cloud API
- **`ProviderCredentials`**: the credential source referenced in `ProviderConfig` — can be a Kubernetes Secret, IRSA, Workload Identity, or `InjectedIdentity`
- **`InjectedIdentity`**: uses the provider pod's ambient identity (IRSA on EKS, Workload Identity on GKE) — preferred over long-lived keys
- **Secret-based credentials**: store cloud credentials in a Kubernetes Secret and reference it in `ProviderConfig`; scope the Secret to the `crossplane-system` namespace
- **Multiple `ProviderConfig`s**: one per cloud account/project or per credential scope; managed resources reference their `ProviderConfig` via `spec.providerConfigRef`

## Common Patterns

**IRSA-based AWS ProviderConfig (preferred)**:

```yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: IRSA
```

**Secret-based ProviderConfig (when IRSA/WI not available)**:

```yaml
apiVersion: aws.upbound.io/v1beta1
kind: ProviderConfig
metadata:
  name: default
spec:
  credentials:
    source: Secret
    secretRef:
      namespace: crossplane-system
      name: aws-secret
      key: creds
```

**Multi-account**: define one `ProviderConfig` per AWS account with a descriptive name (`prod-account`, `staging-account`). Managed resources in Compositions reference the correct config via `providerConfigRef.name`.

**Least-privilege IAM**: the identity used by `ProviderConfig` should only have permissions for the resources Crossplane manages — not `AdministratorAccess`. Use resource-scoped policies.

## Checklist

- [ ] No long-lived keys in `ProviderConfig` — use IRSA, Workload Identity, or `InjectedIdentity`
- [ ] Secret-based credentials stored in `crossplane-system` namespace, not in app namespaces
- [ ] IAM role / service account has least-privilege permissions
- [ ] `ProviderConfig` name matches `providerConfigRef.name` in all managed resources in the Composition
- [ ] Multiple accounts use multiple named `ProviderConfig`s, not a single wildcard config
- [ ] `kubectl describe providerconfig` shows `Synced: True` and no error conditions

## Gotchas

**Deleting a `ProviderConfig` that is referenced by managed resources leaves those resources unmanaged.** Crossplane will not delete the cloud resources, but it will lose the ability to reconcile them. Always check for dependent managed resources before deleting a `ProviderConfig`: `kubectl get managed -o json | jq '.items[] | select(.spec.providerConfigRef.name == "<name>")'`.
