# AWS Observability

## Key Concepts

- **CloudWatch Metrics** — namespace/dimension-based time-series. 1-minute granularity standard, 1-second for detailed monitoring ($).
- **CloudWatch Logs** — log streams organized into log groups. Query with Logs Insights (subset of SQL).
- **CloudWatch Alarms** — trigger on metric thresholds. SNS target for paging, Lambda for auto-remediation.
- **X-Ray** — distributed tracing. Instrument SDK per language; service map shows call graph.
- **Container Insights** — CloudWatch addon for ECS/EKS with pre-built dashboards and detailed metrics.
- **CloudTrail** — API call audit log. Required for security; enable in all regions.

## Common Patterns

```hcl
# Metric filter + alarm from application log
resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "error-count"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "{ $.level = \"error\" }"
  metric_transformation {
    name      = "AppErrors"
    namespace = "MyApp"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "app-error-spike"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "AppErrors"
  namespace           = "MyApp"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  alarm_actions       = [aws_sns_topic.oncall.arn]
}
```

## Checklist

- [ ] Log group retention set (not "Never Expire" for production — cost risk).
- [ ] Structured JSON logs (for Logs Insights `$.field` queries).
- [ ] CloudTrail enabled in all regions + logs encrypted + log file validation on.
- [ ] Alarms use `evaluation_periods > 1` to avoid flapping.
- [ ] Container Insights enabled on all production ECS/EKS clusters.
- [ ] X-Ray sampling rate tuned — 100% sampling is expensive, 5% is standard for production.
- [ ] CloudWatch dashboards scoped per service; no "god dashboard" with 100 widgets.

## Gotchas

- CloudWatch metric publishing has a 1-minute delay — alarms can't detect sub-minute spikes without detailed monitoring ($).
- Logs Insights query costs are per-GB scanned. Narrow time ranges and log groups before running wide filters.
- Metric filters process logs as they arrive, charging per delivered log byte. High-volume logs with many filters become expensive.
- Custom metrics via `PutMetricData` are billed per metric per month. Tagging every request with a custom dimension explodes cardinality.
- X-Ray trace retention is 30 days max — can't use it for long-term analysis.
- CloudTrail "data events" (S3/Lambda data plane) are off by default and extra-cost; "management events" are on by default and free for single-region.
