# AWS IaC Patterns

## Key Concepts

- **CloudFormation** — JSON/YAML declarative IaC. AWS-native; supports StackSets (multi-account/region), ChangeSets (preview), drift detection.
- **CDK** — imperative IaC in TypeScript/Python/Java/Go/C#. Compiles to CloudFormation via `cdk synth`. Constructs encapsulate patterns.
- **SAM** — Serverless Application Model. CloudFormation superset for Lambda + API Gateway + DynamoDB shortcuts.
- **Terraform** — third-party, multi-cloud. `aws` and `awscc` providers (the latter auto-generated from CloudFormation schema).

## Common Patterns

```yaml
# CloudFormation ChangeSet preview before apply
# aws cloudformation create-change-set --stack-name app --template-body file://template.yaml --change-set-name preview
# aws cloudformation describe-change-set --stack-name app --change-set-name preview
# aws cloudformation execute-change-set --stack-name app --change-set-name preview
```

```typescript
// CDK: use L2 constructs, not L1 (Cfn*)
const bucket = new s3.Bucket(this, "Data", {
  encryption: s3.BucketEncryption.S3_MANAGED,
  blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  lifecycleRules: [
    {
      transitions: [
        { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
      ],
    },
  ],
  removalPolicy: RemovalPolicy.RETAIN, // never default to DESTROY for stateful resources
});
```

```hcl
# Terraform + AWS provider with assume_role per environment
provider "aws" {
  region = "us-east-1"
  assume_role {
    role_arn     = "arn:aws:iam::${var.account_id}:role/TerraformDeploy"
    session_name = "terraform-${var.env}"
  }
}
```

## Checklist

- [ ] All stateful resources (S3, RDS, DynamoDB) have `DeletionPolicy: Retain` (CloudFormation) or `removalPolicy: RETAIN` (CDK).
- [ ] ChangeSet or `terraform plan` review is gated on every production deploy (not auto-applied).
- [ ] CloudFormation stack drift detection scheduled weekly.
- [ ] CDK `cdk diff` output committed to PR description or comment for reviewer inspection.
- [ ] State backends (Terraform) use S3 + DynamoDB lock; state encryption + versioning on.
- [ ] No hardcoded account IDs or ARNs — use variables or data sources.

## Gotchas

- CloudFormation rollback on failure can leave orphaned resources (Lambda versions, ENIs in VPC) that block retry — manually clean up or import.
- CDK construct updates can generate large diffs on version bumps. Review `cdk diff` carefully after `npm update`.
- Terraform `aws_s3_bucket_*` resources split in provider v4+: config that worked before needs migration to `aws_s3_bucket_policy`, `aws_s3_bucket_versioning`, etc.
- SAM `Transform: AWS::Serverless-2016-10-31` expands at deploy time — template in git is not the deployed template. Use `sam package` for exact rendered CFN.
- CDK `cdk destroy` removes stacks, but bucket/table deletion needs `RemovalPolicy.DESTROY` or `autoDeleteObjects: true` (for S3) — otherwise deletion fails with non-empty errors.
- Multi-account CDK: the `env` prop is per-stack and must be set; otherwise `cdk synth` uses the current CLI profile's account.
