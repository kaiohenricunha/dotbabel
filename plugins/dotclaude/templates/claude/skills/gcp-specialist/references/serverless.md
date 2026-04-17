# GCP Serverless and Events

## Key Concepts

- **Cloud Functions v2** — FaaS on Cloud Run. HTTP or event triggers (Pub/Sub, GCS, Eventarc).
- **Pub/Sub** — async messaging. Topics + subscriptions. Push (HTTP endpoint) vs pull (subscriber polls). Ordering keys for per-key FIFO.
- **Cloud Tasks** — delayed/retried task queue. Unlike Pub/Sub, targets a specific endpoint per task.
- **Eventarc** — event routing for GCP services and CloudEvents. Trigger Cloud Run/Functions from audit logs.
- **Workflows** — managed orchestration. YAML-defined state machine, supports HTTP and GCP connectors.

## Common Patterns

```hcl
# Pub/Sub topic + subscription with DLQ
resource "google_pubsub_topic" "orders" {
  name = "orders"
}

resource "google_pubsub_topic" "orders_dlq" {
  name = "orders-dlq"
}

resource "google_pubsub_subscription" "worker" {
  name  = "worker"
  topic = google_pubsub_topic.orders.name

  ack_deadline_seconds = 60
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.orders_dlq.id
    max_delivery_attempts = 5
  }
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}
```

```hcl
# Eventarc trigger: Audit Log → Cloud Run
resource "google_eventarc_trigger" "gcs_to_run" {
  name     = "gcs-finalize"
  location = "us-central1"
  matching_criteria {
    attribute = "type"
    value     = "google.cloud.audit.log.v1.written"
  }
  matching_criteria {
    attribute = "serviceName"
    value     = "storage.googleapis.com"
  }
  destination {
    cloud_run_service {
      service = google_cloud_run_v2_service.processor.name
      region  = google_cloud_run_v2_service.processor.location
    }
  }
  service_account = google_service_account.eventarc.email
}
```

## Checklist

- [ ] Pub/Sub subscriptions have DLQ + max delivery attempts set.
- [ ] Push subscriptions use OIDC authentication (`pushConfig.oidcToken`) not public endpoints.
- [ ] Cloud Functions v2 used for new work (v1 is legacy).
- [ ] Ack deadline covers the slowest consumer processing time; else messages redeliver while in-flight.
- [ ] Cloud Tasks for targeted retries with backoff; Pub/Sub for fan-out.
- [ ] Workflow definitions use named steps with explicit error handling (try/retry).
- [ ] Eventarc triggers scoped to specific service/resource, not wildcard everything.

## Gotchas

- Pub/Sub ordering keys serialize delivery per key — if all messages share one key, throughput collapses.
- Push subscription endpoint MUST respond 2xx within ack deadline; slow endpoints cause redelivery.
- Cloud Tasks queues are regional — cross-region calls pay egress and latency.
- Eventarc triggers on Audit Logs require Cloud Audit Logging (Data Access / Admin Activity) to be enabled for the target service.
- Cloud Functions v2 cold starts are shorter than v1 but still measurable; use min-instances for critical paths.
- Pub/Sub "exactly-once delivery" is per-region and requires explicit enablement on the subscription; without it, plan for at-least-once and idempotent consumers.
