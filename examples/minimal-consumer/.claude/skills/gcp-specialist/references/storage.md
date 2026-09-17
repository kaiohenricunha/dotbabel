# GCP Storage and Data

## Key Concepts

- **GCS** — object storage. Storage classes (Standard, Nearline, Coldline, Archive). Uniform vs fine-grained ACLs — prefer Uniform for IAM consistency.
- **Filestore** — managed NFS. Basic/Standard/Premium/High Scale tiers.
- **BigQuery** — serverless data warehouse. On-demand vs Slots (capacity-based) pricing. Partitioning + clustering critical for cost.
- **Cloud SQL** — managed relational (PostgreSQL/MySQL/SQL Server). Regional vs HA config.
- **Spanner** — globally consistent SQL. Expensive; use only when multi-region strong consistency required.
- **Firestore** — document database. Native mode (default/newer) vs Datastore mode (Datastore-compatible legacy mode).

## Common Patterns

```hcl
# GCS bucket: uniform ACL + lifecycle + encryption
resource "google_storage_bucket" "data" {
  name          = "${var.project_id}-data"
  location      = "US"
  force_destroy = false

  uniform_bucket_level_access = true

  versioning { enabled = true }

  lifecycle_rule {
    action { type = "SetStorageClass"; storage_class = "NEARLINE" }
    condition { age = 30 }
  }
  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 365 }
  }

  encryption {
    default_kms_key_name = google_kms_crypto_key.data.id
  }
}
```

```sql
-- BigQuery: partitioned + clustered for cost control
CREATE TABLE analytics.events
PARTITION BY DATE(event_time)
CLUSTER BY user_id, event_type
AS SELECT ... FROM raw.events;
```

## Checklist

- [ ] GCS buckets use Uniform bucket-level access (not fine-grained ACLs).
- [ ] Public access prevention enabled (`publicAccessPrevention: enforced`) unless intentionally public.
- [ ] Lifecycle rules tier to Nearline/Coldline/Archive, delete ancient objects.
- [ ] BigQuery tables partitioned (typically by DATE) and clustered on frequent filter columns.
- [ ] BigQuery queries reviewed with `--dry_run` before running to see cost estimate.
- [ ] Cloud SQL has automated backups, point-in-time recovery, HA for production.
- [ ] Firestore Native mode for new projects — Datastore mode is legacy.

## Gotchas

- GCS bucket names are globally unique DNS labels. Deleted names reusable but subject to squatting.
- Uniform ACL is one-way — switching to fine-grained requires bucket recreation in some scenarios.
- BigQuery on-demand charges per byte scanned, not per row returned. `SELECT *` on a wide table is expensive.
- BigQuery partition pruning only works when the partition column is in a `WHERE` clause with a filter compatible with the partition type.
- Cloud SQL's HA is regional (one primary, one standby in another zone). For cross-region HA, use Cloud SQL read replicas (manual promotion).
- Firestore has 1 write/second per document limit — hot documents serialize writes.
- GCS signed URLs don't respect uniform bucket-level access for the bucket's underlying ACL model — test generation + access before relying.
