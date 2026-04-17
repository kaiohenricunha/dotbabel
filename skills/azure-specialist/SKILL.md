---
id: azure-specialist
name: azure-specialist
type: skill
version: 1.0.0
domain: [infra]
platform: [azure]
task: [debugging, review]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-04-17
description: >
  Deep-dive Azure architecture review, debugging, and service design. Use for
  structured investigations of Azure-specific issues, identity or cost audits,
  and multi-service design reviews. Triggers on: "Azure audit", "Azure design
  review", "EntraID review", "Managed Identity debug", "review my Azure",
  "Azure troubleshooting", "AKS deep-dive".
argument-hint: "<subscription context, service, or problem description>"
tools: Read, Grep, Glob, Bash
effort: max
model: opus
---

# Azure Specialist

Structured investigation for Azure workloads. Five phases: gather context,
diagnose, design, recommend, verify.

## Arguments

- `$0` — subscription context, service scope, or problem description. Required.

---

## Phase 1: Context Gathering

1. Identify the tenant, subscription(s), resource group(s), and services in scope.
2. Glob for IaC in the working directory: `**/*.bicep`, `**/azuredeploy.json`, `**/main.tf`, `**/*.parameters.json`.
3. If Azure CLI access is available:
   ```bash
   az account show
   az group list --query "[].name"
   ```
4. Note which resource providers are registered:
   ```bash
   az provider list --query "[?registrationState=='Registered'].namespace" -o tsv
   ```

---

## Phase 2: Diagnosis

**Compute / containers:**

```bash
az vm list --query "[].{name:name,rg:resourceGroup,state:powerState}" -o table
az aks list --query "[].{name:name,rg:resourceGroup,version:kubernetesVersion}" -o table
az webapp list --query "[].{name:name,rg:resourceGroup,state:state}" -o table
```

**Identity / RBAC:**

```bash
az role assignment list --assignee <principal-id> --all
az ad app list --display-name <name>
az identity list --resource-group <rg>
```

**Networking:**

```bash
az network vnet list
az network nsg rule list --nsg-name <nsg> --resource-group <rg>
az network private-endpoint list
```

**Serverless / events:**

```bash
az functionapp list
az servicebus namespace list
az eventgrid topic list
```

**Cost / quotas:**

```bash
az consumption usage list --start-date <> --end-date <>
az vm list-usage --location <region>
```

---

## Phase 3: Design / Root-Cause Analysis

Map symptoms to causes:

| Symptom                  | Common Causes                                               | Check                                                           |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| AKS pod AuthN fails      | Managed Identity not assigned, missing federated credential | `az aks show --query identity` + pod ServiceAccount annotations |
| App Service slow         | Cold start on consumption plan, misconfigured scale rules   | Plan tier, autoscale settings                                   |
| Storage 403              | Private endpoint with wrong DNS, firewall IP allowlist      | `az storage account network-rule list`                          |
| Function cold starts     | Consumption plan + infrequent traffic                       | Switch to Premium or Always-Ready instances                     |
| Cosmos DB throttle (429) | RU/s too low, hot partition                                 | Diagnostic settings, metrics, partition key review              |
| EntraID app login fails  | Redirect URI mismatch, missing API permission grant         | `az ad app show` + consent status                               |

Cite resource ID or `file:line` for every finding.

---

## Phase 4: Recommendations

Output findings in priority order:

```
[CRITICAL] <title>
Resource: <resource ID or file:line>
Issue: <one sentence>
Evidence: <CLI output or code snippet>
Fix: <specific change, with Bicep/ARM/Terraform diff>
Trade-off: <alternative and its downside, if meaningful>
```

- Order: CRITICAL → WARNING → INFO.
- For IaC fixes, show the exact Bicep/ARM/Terraform diff.
- Reference relevant docs in `references/` where applicable.

---

## Phase 5: Verification

After fixes are applied:

1. Re-run the diagnostic command that surfaced the issue.
2. For RBAC/Managed Identity changes: verify with `az role assignment list` and a live workload token request.
3. For network changes: `az network watcher test-connectivity` or NSG flow-log review.
4. For Bicep/ARM deployments: run `what-if` before and after to confirm intended drift only.
5. Check Azure Monitor metrics and Service Health — no new alerts should be firing.

---

## Reference Docs

Consult `references/` for decision guides:

| File              | When to use                                      |
| ----------------- | ------------------------------------------------ |
| `compute.md`      | AKS, ACI, VMs, App Service                       |
| `serverless.md`   | Functions, Logic Apps, Service Bus, Event Grid   |
| `storage.md`      | Blob, Files, Queues, Cosmos DB, Azure SQL        |
| `networking.md`   | VNet, App Gateway, Front Door, Private Endpoints |
| `identity.md`     | EntraID, Managed Identity, RBAC scopes           |
| `devops.md`       | Azure Pipelines, ACR, release management         |
| `iac-patterns.md` | Bicep, ARM, Terraform (AzureRM/azapi) patterns   |
