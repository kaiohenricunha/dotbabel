# AWS Storage

## Key Concepts

- **S3** — object storage. Storage classes (Standard, IA, Intelligent-Tiering, Glacier). Bucket policies + IAM + Access Points + Block Public Access overlap.
- **EBS** — block storage for EC2. gp3 for general purpose, io2 for high-IOPS, st1/sc1 for throughput/cold.
- **EFS** — shared NFS filesystem. Standard (multi-AZ) vs One Zone. Provisioned vs Bursting throughput.
- **RDS** — managed relational DB. Engine choice (PostgreSQL/MySQL/MariaDB/Oracle/SQL Server/Aurora). Read replicas cross-region for DR.
- **DynamoDB** — managed key-value/document. Partition key + sort key. GSIs for alternate access patterns. On-demand vs Provisioned capacity.

## Common Patterns

```hcl
# S3 with lifecycle + encryption + block public access
resource "aws_s3_bucket" "data" {
  bucket = "my-app-data"
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
```

```hcl
# DynamoDB with GSI
resource "aws_dynamodb_table" "items" {
  name           = "items"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "pk"
  range_key      = "sk"
  attribute { name = "pk"; type = "S" }
  attribute { name = "sk"; type = "S" }
  attribute { name = "gsi1pk"; type = "S" }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    projection_type = "ALL"
  }
}
```

## Checklist

- [ ] S3 buckets have Block Public Access enabled at bucket level (default on new buckets, verify for imported).
- [ ] S3 default encryption set (SSE-S3 minimum, SSE-KMS for compliance).
- [ ] S3 lifecycle rules transition old objects to IA/Glacier and expire incomplete multipart uploads.
- [ ] EBS volumes encrypted by default (account-level setting).
- [ ] RDS has automated backups, multi-AZ for production, Performance Insights enabled.
- [ ] DynamoDB uses PAY_PER_REQUEST for spiky workloads, Provisioned + auto-scaling for predictable.
- [ ] Point-in-time recovery enabled on DynamoDB tables with production data.

## Gotchas

- S3 bucket names are global — a deleted bucket name is reusable, but not immediately. Plan for name-squatting risk in public scenarios.
- `aws s3 cp` recursively with `--exclude` before `--include` is the opposite order of most tools; get it wrong and you copy nothing.
- EFS throughput mode "Bursting" runs out of credits under sustained load; switch to Elastic or Provisioned for steady workloads.
- RDS minor version auto-upgrades happen during maintenance windows — production DBs should pin minor version and upgrade deliberately.
- DynamoDB "hot partition" is the #1 performance issue. Partition key cardinality must spread load evenly; monotonic keys (timestamps) concentrate writes.
- S3 Intelligent-Tiering has a monitoring fee per object — cost-effective only for objects > 128 KB.
