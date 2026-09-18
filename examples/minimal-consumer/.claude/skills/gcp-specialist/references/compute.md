# GCP Compute

## Key Concepts

- **GKE** — managed Kubernetes. Autopilot (serverless, opinionated) vs Standard (full control). Workload Identity is the default pod identity.
- **Cloud Run** — managed serverless containers. Services (HTTP handlers) vs Jobs (batch). Scale to zero supported.
- **GCE** — Compute Engine VMs. Machine families (E2/N2/C2/M2/T2A), custom machine types. MIGs (Managed Instance Groups) for autoscaling.
- **Spot VMs** — interruptible compute at steep discount. 30s preemption notice.
- **Cloud Functions** — FaaS. v2 is Cloud Run under the hood; v1 is legacy.

## Common Patterns

```hcl
# GKE Autopilot with Workload Identity
resource "google_container_cluster" "autopilot" {
  name     = "app"
  location = "us-central1"
  enable_autopilot = true

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }
  release_channel { channel = "REGULAR" }
}
```

```hcl
# Cloud Run service with concurrency + min instances
resource "google_cloud_run_v2_service" "api" {
  name     = "api"
  location = "us-central1"

  template {
    containers {
      image = "gcr.io/${var.project_id}/api:${var.tag}"
      resources { limits = { cpu = "1"; memory = "512Mi" } }
    }
    scaling {
      min_instance_count = 1
      max_instance_count = 20
    }
    max_instance_request_concurrency = 80
    service_account = google_service_account.api.email
  }
}
```

## Checklist

- [ ] GKE Autopilot preferred for new clusters; Standard only when node customization is required.
- [ ] Cluster has Workload Identity enabled (Autopilot enables by default, Standard must opt in).
- [ ] Release channel set (`RAPID`/`REGULAR`/`STABLE`) — clusters without channel require manual upgrades.
- [ ] Cloud Run services use Service Accounts (not default compute SA).
- [ ] Cloud Run `min_instance_count > 0` for latency-critical services (avoid cold starts).
- [ ] GCE MIGs use health checks + auto-healing; not just autoscaling.
- [ ] Spot VMs used only for interruption-tolerant workloads, paired with checkpointing.

## Gotchas

- Autopilot rejects DaemonSets in most namespaces (pods can't target nodes directly). Known limitation — use Standard if you need DaemonSets.
- Cloud Run services scale to zero by default. First request after idle pays cold-start. `min_instance_count: 1` keeps one warm (+cost).
- Cloud Run max_instance_request_concurrency capped at 1000. Higher values mean more requests per container but memory pressure.
- GKE Standard clusters created without Workload Identity can't retrofit it easily — you can enable on cluster but must rebuild node pools.
- GCE instance metadata server (`metadata.google.internal`) is the only way to get default SA tokens — firewall-blocking it breaks Workload Identity.
- Cloud Functions v1 has separate quotas from v2; migrating doesn't carry over concurrency limits.
