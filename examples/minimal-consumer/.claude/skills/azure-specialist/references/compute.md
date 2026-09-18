# Azure Compute

## Key Concepts

- **AKS** — managed Kubernetes. Node pools (system + user), Virtual Nodes (serverless bursting), Azure CNI (pod IPs from VNet) vs kubenet (overlay).
- **ACI** — Azure Container Instances. Single-container serverless; no orchestration. Useful for batch jobs, not long-running services.
- **App Service** — PaaS for web apps. Plans (Basic/Standard/Premium v2/v3/Isolated). Deployment slots for blue-green.
- **Virtual Machines** — IaaS VMs. Availability sets (fault/update domains) vs Availability Zones (AZ-aware). Spot VMs for interruption-tolerant.

## Common Patterns

```bicep
// AKS with Azure CNI + Workload Identity
resource aks 'Microsoft.ContainerService/managedClusters@2024-01-01' = {
  name: 'my-aks'
  location: resourceGroup().location
  identity: { type: 'SystemAssigned' }
  properties: {
    dnsPrefix: 'myaks'
    oidcIssuerProfile: { enabled: true }
    securityProfile: { workloadIdentity: { enabled: true } }
    networkProfile: {
      networkPlugin: 'azure'
      networkPolicy: 'cilium'
    }
    agentPoolProfiles: [
      {
        name: 'system'
        count: 2
        vmSize: 'Standard_D4s_v5'
        mode: 'System'
      }
    ]
  }
}
```

```bicep
// App Service with deployment slot
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = { ... }
resource app 'Microsoft.Web/sites@2023-12-01' = { ... }
resource staging 'Microsoft.Web/sites/slots@2023-12-01' = {
  parent: app
  name: 'staging'
  properties: { serverFarmId: plan.id }
}
```

## Checklist

- [ ] AKS system pool isolated from user workloads via `nodeSelector`/`taints` (don't schedule app pods on system nodes).
- [ ] AKS cluster has OIDC issuer + Workload Identity enabled (not legacy AAD pod identity).
- [ ] App Service uses Premium v3 for production (better cold-start behavior, VNet integration).
- [ ] Deployment slots used for zero-downtime deploys; `swap` tested.
- [ ] VMs in Availability Zones (not just availability sets) for regional HA.
- [ ] Spot VMs used only for interruption-tolerant workloads with eviction policy set.

## Gotchas

- Azure CNI consumes VNet IPs per pod; subnet must be sized for `max_pods × node_count`. Overlay mode (Azure CNI Overlay) avoids this at some feature cost.
- AKS node image upgrades require rolling node pools; default maintenance window is reactive (security updates auto-apply) — pin for predictability.
- App Service `Always On` defaults to false on Basic/Free tiers — app unloads after idle, first request pays full cold start.
- Deployment slot swap is atomic at the routing layer but NOT at the storage layer — slot-sticky settings prevent accidental swap of config.
- ACI has no autoscaling — one ACI = one pod. For scale, use AKS + Virtual Nodes.
- Availability Sets only protect against rack failure (fault domain 0-2); AZs protect against DC failure. Most production workloads need AZs.
