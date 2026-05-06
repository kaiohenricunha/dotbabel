# Azure Identity

## Key Concepts

- **EntraID** (formerly Azure AD) — directory and identity provider. Users, groups, app registrations, service principals.
- **App registration** — defines an application in the tenant. Creates a service principal per tenant where the app is consented.
- **Managed Identity** — EntraID identity automatically managed for Azure resources. System-assigned (tied to resource lifecycle) vs User-assigned (shared across resources).
- **RBAC** — role assignments scoped at management group / subscription / resource group / resource level. Inherits downward.
- **Conditional Access** — policy engine gating sign-ins based on user, location, device, risk.
- **PIM** — Privileged Identity Management. Just-in-time elevation for sensitive roles.

## Common Patterns

```bicep
// User-assigned Managed Identity + RBAC on Key Vault
resource uai 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'app-uai'
}

resource kvRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: kv
  name: guid(uai.id, kv.id, 'Key Vault Secrets User')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')  // Key Vault Secrets User
    principalId: uai.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
```

```bicep
// AKS Workload Identity — federated credential on UAI
resource fc 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: uai
  name: 'aks-sa-federation'
  properties: {
    issuer: aks.properties.oidcIssuerProfile.issuerURL
    subject: 'system:serviceaccount:my-namespace:my-sa'
    audiences: ['api://AzureADTokenExchange']
  }
}
```

## Checklist

- [ ] No service principal client secrets where Managed Identity is available.
- [ ] User-assigned Managed Identity preferred for workloads that share identity across resources or need to persist across resource recreation.
- [ ] RBAC role assignments use built-in roles; custom roles only when built-ins insufficient.
- [ ] RBAC scope is as narrow as possible — resource > RG > subscription > management group.
- [ ] Conditional Access policies enforce MFA for admin roles + block legacy authentication.
- [ ] PIM enabled for Owner, Contributor, and custom high-privilege roles.
- [ ] App registrations request only the scopes they actually use (no "All" unless required).

## Gotchas

- System-assigned MI is deleted when the parent resource is deleted — any role assignments referencing it become orphaned.
- Role assignments replicate eventually — after `az role assignment create`, wait 1–2 minutes before testing.
- `guid(...)` in Bicep for role assignment names must be deterministic across redeploys — else ARM tries to create a duplicate and fails.
- Workload Identity federated credential `subject` must exactly match the SA in form `system:serviceaccount:<ns>:<sa>`. Typos fail silently with authN errors.
- EntraID tenant-wide admin consent is required for many Microsoft Graph scopes — granting per-user doesn't propagate.
- Legacy "AAD Pod Identity" is deprecated on AKS — don't use it for new workloads; use Workload Identity.
