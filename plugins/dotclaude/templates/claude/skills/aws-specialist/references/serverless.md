# AWS Serverless

## Key Concepts

- **Lambda** — function-as-a-service. Cold starts on first invocation or after scale-down. Concurrency is account-wide unless reserved.
- **API Gateway** — REST (legacy, feature-rich), HTTP (cheaper, faster, less feature), WebSocket (stateful connections).
- **EventBridge** — event bus with pattern-matching rules. Replacement for CloudWatch Events.
- **Step Functions** — state machine orchestration. Standard (long-running, exactly-once) vs Express (short, at-least-once).
- **SQS / SNS** — queue (pull, durable) vs pub/sub (push, fan-out).

## Common Patterns

```hcl
# Lambda with reserved concurrency
resource "aws_lambda_function" "api" {
  function_name    = "my-api"
  handler          = "index.handler"
  runtime          = "nodejs20.x"  # use the project's Node runtime
  memory_size      = 512
  timeout          = 30
  reserved_concurrent_executions = 50
  environment {
    variables = { LOG_LEVEL = "info" }
  }
}
```

```hcl
# API Gateway HTTP + Lambda integration
resource "aws_apigatewayv2_api" "http" {
  name          = "my-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id             = aws_apigatewayv2_api.http.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}
```

## Checklist

- [ ] Lambda timeout < API Gateway timeout (29 seconds for HTTP API, else client hits 504 before Lambda knows).
- [ ] Reserved concurrency set for production-critical functions to prevent starvation by other workloads.
- [ ] Dead-letter queue (DLQ) or destination configured for async invocations.
- [ ] CloudWatch Logs retention set (default is forever = unbounded cost).
- [ ] SQS queue has a DLQ with `maxReceiveCount`.
- [ ] EventBridge rule targets have retry and DLQ configured.

## Gotchas

- Lambda cold starts multiply with VPC attachment + large deployment packages — use layers and provisioned concurrency for latency-sensitive paths.
- `reserved_concurrent_executions = 0` is a kill switch — it disables the function entirely, not "unlimited".
- API Gateway REST caches are regional, not global. Use CloudFront in front of API Gateway for cache distribution.
- SQS visibility timeout must exceed the slowest consumer processing time, else messages get redelivered while still in-flight.
- Step Functions Standard pricing per state transition; tight loops become expensive. Use Express for high-throughput short workflows.
- EventBridge default bus collects CloudTrail events — don't attach expensive targets without filtering, or you'll pay per event.
