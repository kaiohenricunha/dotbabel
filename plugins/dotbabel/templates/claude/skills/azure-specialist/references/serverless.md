# Azure Serverless

## Key Concepts

- **Azure Functions** — FaaS. Consumption plan (pay-per-exec, cold starts), Premium (pre-warmed), Dedicated (App Service plan).
- **Logic Apps** — low-code workflow orchestration. Standard (single-tenant) vs Consumption (multi-tenant).
- **Service Bus** — enterprise message broker. Queues (1:1) vs Topics (1:N with subscriptions). Sessions for ordering.
- **Event Grid** — pub/sub for Azure events + custom topics. Push-based, webhook targets.
- **Event Hubs** — high-throughput event streaming (think: Kafka-alike). Partitioned, checkpoint-based consumers.

## Common Patterns

```bicep
// Function App on Premium plan with VNet integration
resource fnplan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'fn-premium'
  sku: { name: 'EP1', tier: 'ElasticPremium' }
  kind: 'functionapp'
  properties: { maximumElasticWorkerCount: 20 }
}

resource fn 'Microsoft.Web/sites@2023-12-01' = {
  name: 'my-fn'
  kind: 'functionapp'
  properties: {
    serverFarmId: fnplan.id
    siteConfig: {
      alwaysOn: true
      functionsRuntimeScaleMonitoringEnabled: true
      appSettings: [
        { name: 'WEBSITE_CONTENTOVERVNET', value: '1' }
      ]
    }
  }
}
```

```bicep
// Service Bus queue with DLQ + sessions
resource sb 'Microsoft.ServiceBus/namespaces@2023-01-01-preview' = { ... }
resource q 'Microsoft.ServiceBus/namespaces/queues@2023-01-01-preview' = {
  parent: sb
  name: 'orders'
  properties: {
    maxDeliveryCount: 10
    deadLetteringOnMessageExpiration: true
    requiresSession: true
    lockDuration: 'PT1M'
  }
}
```

## Checklist

- [ ] Production Function Apps on Premium or Dedicated plans (Consumption OK for non-critical).
- [ ] `functionAppScaleLimit` or `maximumElasticWorkerCount` set to cap cost at tail.
- [ ] Service Bus queues have DLQ (`deadLetteringOnMessageExpiration: true`) and bounded `maxDeliveryCount`.
- [ ] Logic Apps Standard used for stateful workflows; Consumption fine for simple event connectors.
- [ ] Event Hubs capture enabled for long-term storage if compliance requires.
- [ ] Event Grid subscriptions have retry policies + DLQ (dead-letter endpoint).

## Gotchas

- Functions `host.json` settings silently override portal configuration — diff the file in git when behavior drifts.
- Consumption plan cold starts are real (seconds). VNet-integrated Functions always require Premium or Dedicated.
- Service Bus sessions serialize within a session ID — if all messages share a session ID, throughput collapses to a single consumer.
- Event Grid push can't retry forever — eventually events go to DLQ or dropped. Always configure DLQ for production.
- Logic Apps Standard runs on App Service plan; you pay for the plan whether workflows run or not.
- Event Hubs consumer groups must have offset tracking (checkpoint) — without it, restart reads from the beginning (or end, depending on config).
