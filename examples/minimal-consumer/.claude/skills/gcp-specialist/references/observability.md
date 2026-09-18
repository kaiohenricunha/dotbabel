# GCP Observability

## Key Concepts

- **Cloud Monitoring** — metrics + dashboards + alerting. Legacy "Stackdriver" rebrand.
- **Cloud Logging** — structured logs. Log buckets, sinks (to BigQuery/GCS/Pub/Sub), log-based metrics.
- **Cloud Trace** — distributed tracing. OpenTelemetry-compatible.
- **Error Reporting** — automatic error aggregation from structured logs.
- **Profiler** — continuous production profiling (CPU, heap, contention) with low overhead.

## Common Patterns

```hcl
# Log sink exporting WARN+ logs to BigQuery for SIEM
resource "google_logging_project_sink" "warnings" {
  name        = "warn-to-bq"
  destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/logs"
  filter      = "severity>=WARNING"

  unique_writer_identity = true
}
```

```hcl
# Alerting policy: 5xx rate spike
resource "google_monitoring_alert_policy" "error_spike" {
  display_name = "5xx rate above 5%"
  combiner     = "OR"
  conditions {
    display_name = "5xx ratio"
    condition_threshold {
      filter = "metric.type=\"run.googleapis.com/request_count\" AND metric.label.response_code_class=\"5xx\""
      comparison = "COMPARISON_GT"
      threshold_value = 0.05
      duration = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  notification_channels = [google_monitoring_notification_channel.oncall.id]
}
```

## Checklist

- [ ] Log buckets have retention set per class of data (application logs shorter, audit longer).
- [ ] Audit Logs (Admin Activity + Data Access) enabled on all production projects.
- [ ] Structured JSON logs with severity, trace ID, and request context.
- [ ] Alert policies use rate/ratio comparisons, not absolute counts (resilient to traffic changes).
- [ ] Notification channels cover multiple routes (email + pager/Slack).
- [ ] Dashboards versioned as IaC (Terraform `google_monitoring_dashboard`), not portal-only.
- [ ] SLOs defined for customer-facing services using `google_monitoring_slo` — error budget-based alerting.

## Gotchas

- Log-based metrics have a few-minute delay — don't use them for sub-minute alerting.
- Log sink filters are strings; `resource.type="foo"` vs `resource.type=foo` behave differently in some edge cases. Always quote strings.
- Data Access audit logs are verbose and expensive — enable selectively per service (not globally).
- Cloud Monitoring "uptime checks" probe from multiple regions; false positives happen when a single region has issues. Require N of M regions to alert.
- Trace sampling default (Cloud Run / GKE) is very low; custom code paths need explicit sampler config to capture enough traces.
- Log-based metrics count entries matching the filter at log-write time; retroactive filter changes don't backfill old data.
