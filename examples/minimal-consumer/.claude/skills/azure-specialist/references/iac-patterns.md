# Azure IaC Patterns

## Key Concepts

- **ARM templates** — JSON declarative IaC. Low-level, verbose. Every resource has an `apiVersion`.
- **Bicep** — DSL compiling to ARM. Modules, loops, conditions, type-checking. Preferred for new work.
- **Terraform** — `azurerm` provider for stable resources, `azapi` provider for preview/unreleased services.
- **Azure Verified Modules** — Microsoft-maintained Bicep and Terraform modules with consistent patterns.

## Common Patterns

```bicep
// Bicep module with parameters + outputs
param location string = resourceGroup().location
param env string
@allowed(['Basic', 'Standard', 'Premium'])
param tier string

module app 'modules/app-service.bicep' = {
  name: 'app-${env}'
  params: {
    location: location
    sku: tier
    env: env
  }
}

output endpoint string = app.outputs.defaultHostName
```

```bicep
// Loops for multi-region deployment
param regions array = ['eastus', 'westeurope']
resource sas 'Microsoft.Storage/storageAccounts@2023-05-01' = [for r in regions: {
  name: 'sa${uniqueString(resourceGroup().id, r)}'
  location: r
  ...
}]
```

```hcl
# Terraform azapi provider for preview features
resource "azapi_resource" "my_preview" {
  type      = "Microsoft.SomeService/resources@2024-08-01-preview"
  name      = "my-resource"
  parent_id = azurerm_resource_group.rg.id
  body = jsonencode({ properties = { ... } })
}
```

## Checklist

- [ ] New IaC work in Bicep, not raw ARM.
- [ ] `bicep build <file>.bicep` runs clean before deploy (catches invalid refs, type errors).
- [ ] `az deployment group what-if` reviewed before every production deploy.
- [ ] Resource tags applied via module/default — don't rely on manual post-deploy tagging.
- [ ] Terraform remote state in Storage Account with SAS/MI access; state locking via blob lease.
- [ ] No hardcoded tenant IDs, subscription IDs — reference via parameters or data sources.
- [ ] Use Azure Verified Modules for common patterns (AKS, App Service, Storage) to inherit baseline hardening.

## Gotchas

- Bicep module `name` must be unique per deployment — it's ARM's deployment name, not the Bicep variable name. Duplicate names collide.
- ARM `apiVersion` affects which properties are valid. Upgrading API version in Bicep can silently drop/add features — check the schema.
- `az deployment group what-if` can miss drift introduced by manual portal changes; use `az deployment group list` + change history for the full picture.
- Terraform azurerm v3 → v4 migrations reorganized many resources (storage account sub-resources split off). Check upgrade guide before provider bumps.
- Bicep `existing` references don't validate at build time — a typo in the name of an existing resource fails at deploy, not compile.
- ARM incremental mode (default) adds new resources but doesn't remove ones missing from the template; Complete mode removes anything not in the template. Complete mode is dangerous for shared RGs.
