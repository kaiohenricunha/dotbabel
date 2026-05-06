# GCP IaC Patterns

## Key Concepts

- **Terraform** — `google` and `google-beta` providers. google-beta exposes preview features earlier but couples your module to the beta provider.
- **Config Connector (KCC)** — GCP resources as Kubernetes CRDs. Managed by GKE-addon or self-install. Lets you use kubectl + GitOps for GCP.
- **Deployment Manager** — legacy GCP-native IaC. Being deprecated; avoid for new work.
- **Pulumi** — code-first IaC with GCP provider, useful for teams with strong language preferences.
- **Crossplane** — Kubernetes-native IaC alternative to Config Connector with broader ecosystem.

## Common Patterns

```hcl
# Terraform: separate google + google-beta for mixed features
terraform {
  required_providers {
    google      = { source = "hashicorp/google"; version = "~> 5.0" }
    google-beta = { source = "hashicorp/google-beta"; version = "~> 5.0" }
  }
  backend "gcs" {
    bucket = "my-terraform-state"
    prefix = "env/prod"
  }
}

provider "google"      { project = var.project_id; region = var.region }
provider "google-beta" { project = var.project_id; region = var.region }
```

```yaml
# Config Connector: GCS bucket as K8s resource
apiVersion: storage.cnrm.cloud.google.com/v1beta1
kind: StorageBucket
metadata:
  name: my-bucket
  namespace: config-connector
spec:
  location: US
  uniformBucketLevelAccess: true
  lifecycleRule:
    - action: { type: Delete }
      condition: { age: 365 }
```

## Checklist

- [ ] Terraform remote state in GCS with versioning + uniform bucket access.
- [ ] Provider versions pinned with `~>` or exact; not `latest`.
- [ ] State bucket has IAM access scoped to the Terraform SA only; no human browsing.
- [ ] `terraform plan` output reviewed for every production change — destroy/recreate flagged in PR description.
- [ ] Config Connector: namespace-scoped CRDs preferred over cluster-scoped for blast-radius control.
- [ ] Deployment Manager NOT used for new work (legacy).
- [ ] No service account keys in state or variables — use Workload Identity (Terraform in GKE) or Workload Identity Federation (Terraform in CI).

## Gotchas

- `google_project_iam_member` adds one member to a role; `_binding` is authoritative (replaces all); `_policy` is the whole policy. Mixing them causes drift.
- Terraform state for GCS buckets with object-level data: the state doesn't track bucket contents. `terraform destroy` fails on non-empty buckets unless `force_destroy = true`.
- Config Connector has a lag between CRD apply and GCP resource creation — `kubectl wait` or retry logic needed in automation.
- `google-beta` provider resources may change without the stability guarantee; pin major + minor version.
- Project creation via Terraform requires billing account linkage — a missing billing binding leaves the project in a broken state.
- Custom role definitions aren't deletable immediately after removal from Terraform — they enter a 7-day soft-delete state.
