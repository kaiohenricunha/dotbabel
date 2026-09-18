# GCP IAM

## Key Concepts

- **Hierarchy** — Organization → Folder → Project → Resource. IAM inherits downward; narrower scopes can expand but not restrict inherited grants.
- **Service Accounts** — identities for workloads. Default compute SA is overly permissive; create dedicated SAs.
- **Roles** — Primitive (Owner/Editor/Viewer — avoid), Predefined (service-specific), Custom (authored).
- **Workload Identity** — KSA ↔ GSA binding on GKE so pods get GSA permissions without downloaded keys.
- **Workload Identity Federation** — external identity provider (GitHub Actions, AWS, Azure AD) assumes GSAs without keys.
- **Organization Policies** — constraints (e.g. `disableServiceAccountKeyCreation`) enforced across the org.
- **VPC Service Controls** — perimeter boundaries around API access to sensitive services.

## Common Patterns

```hcl
# GKE Workload Identity: bind KSA ↔ GSA
resource "google_service_account" "pod_sa" {
  account_id = "my-pod-sa"
}

resource "google_service_account_iam_binding" "wi" {
  service_account_id = google_service_account.pod_sa.name
  role               = "roles/iam.workloadIdentityUser"
  members = [
    "serviceAccount:${var.project_id}.svc.id.goog[my-namespace/my-ksa]",
  ]
}

# KSA annotation: iam.gke.io/gcp-service-account: my-pod-sa@<project>.iam.gserviceaccount.com
```

```hcl
# Workload Identity Federation for GitHub Actions
resource "google_iam_workload_identity_pool" "gha" { ... }
resource "google_iam_workload_identity_pool_provider" "gha" {
  oidc { issuer_uri = "https://token.actions.githubusercontent.com" }
  attribute_mapping = {
    "google.subject" = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
}
```

## Checklist

- [ ] No primitive roles (Owner/Editor/Viewer) in production IAM bindings — use predefined or custom.
- [ ] No downloaded service account keys; use Workload Identity (in-GCP) or Workload Identity Federation (external).
- [ ] Default compute SA stripped of permissions; dedicated SA per workload.
- [ ] IAM bindings granted at the narrowest scope (resource > project > folder > org).
- [ ] Org policy `iam.disableServiceAccountKeyCreation` enabled unless keys are truly required.
- [ ] Org policy `compute.skipDefaultNetworkCreation` enabled to prevent Auto VPC creation.
- [ ] VPC Service Controls perimeters around projects with sensitive data (HIPAA/PCI/etc).

## Gotchas

- IAM inheritance is additive — you can only EXPAND privileges downward, never restrict. To restrict, use Deny Policies (separate mechanism).
- `roles/owner` on a project includes billing control. Separate project-owner from billing-admin via Billing Account IAM.
- Service account impersonation (`iam.serviceAccounts.getAccessToken`) bypasses SA key download but still needs auditing — log impersonation events.
- Workload Identity KSA annotation mismatch (typo, wrong SA email) fails silently with "default credentials not found".
- VPC Service Controls in enforced mode can break legitimate cross-project access; always test in dry-run mode first.
- Custom roles aren't replicated automatically — custom roles created at project level don't exist at folder level. Create at the right scope for inheritance.
