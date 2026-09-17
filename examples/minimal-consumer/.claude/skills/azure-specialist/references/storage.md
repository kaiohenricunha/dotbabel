# Azure Storage

## Key Concepts

- **Blob Storage** — object storage. Access tiers (Hot/Cool/Cold/Archive), lifecycle rules. Block blobs vs page blobs vs append blobs.
- **Azure Files** — SMB and NFS shares. Standard (HDD) vs Premium (SSD). AD-joined for identity-based access.
- **Queue Storage** — simple queue service (not to be confused with Service Bus). Up to 64KB messages.
- **Cosmos DB** — multi-model (SQL/MongoDB/Cassandra/Gremlin/Table) NoSQL. Consistency levels (Strong, Bounded Staleness, Session, Consistent Prefix, Eventual). RU/s provisioning.
- **Azure SQL** — managed relational. vCore vs DTU purchasing models. Elastic pools for multi-tenant.

## Common Patterns

```bicep
// Storage account with lifecycle + private endpoint
resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'mystorageaccount'
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    networkAcls: { defaultAction: 'Deny' }
    encryption: { services: { blob: { enabled: true } } }
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: sa
  name: 'default'
  properties: {
    policy: {
      rules: [{
        name: 'archive-old-blobs'
        enabled: true
        type: 'Lifecycle'
        definition: {
          filters: { blobTypes: ['blockBlob'] }
          actions: { baseBlob: { tierToArchive: { daysAfterModificationGreaterThan: 180 } } }
        }
      }]
    }
  }
}
```

```bicep
// Cosmos DB with Session consistency + partition key
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: 'my-cosmos'
  kind: 'GlobalDocumentDB'
  properties: {
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [{ locationName: resourceGroup().location }]
    capabilities: []   // add 'EnableServerless' for unpredictable workloads
  }
}
```

## Checklist

- [ ] Storage accounts: `allowBlobPublicAccess: false`, `minimumTlsVersion: 'TLS1_2'`, `supportsHttpsTrafficOnly: true`.
- [ ] Storage network ACL default-deny; allowlist VNet subnets or Private Endpoint.
- [ ] Lifecycle rules tier cold data to Cool/Archive, delete ancient blobs.
- [ ] Cosmos DB partition key chosen for even distribution (high cardinality, frequent value).
- [ ] Cosmos Session consistency is the default; use Strong only when truly required.
- [ ] Azure SQL uses vCore + General Purpose for most workloads; Hyperscale for >4TB.
- [ ] SQL Transparent Data Encryption (TDE) on; Azure Defender for SQL enabled for production.

## Gotchas

- Storage account names are globally unique DNS labels — pick carefully; deletion doesn't immediately free the name.
- Archive tier rehydrate takes hours. Application code should NOT hit archive blobs directly; rehydrate to Cool first.
- Cosmos DB RU/s is account-wide or per-container; hot partitions throttle silently with HTTP 429. Always log and alarm on 429 rate.
- Cosmos serverless max container throughput is capped — not a substitute for provisioned at high throughput.
- Azure SQL DTU model hides CPU/memory separately; vCore is the modern and recommended choice.
- Blob soft-delete and versioning are independent features — enabling both ensures both accidental delete AND accidental overwrite are recoverable.
