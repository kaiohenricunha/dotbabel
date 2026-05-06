# AWS IAM

## Key Concepts

- **Identity-based policies** — attached to users, groups, roles. Define what the principal can do.
- **Resource-based policies** — attached to resources (S3 buckets, SQS queues, Lambda). Define who can access the resource.
- **Permission boundaries** — cap the maximum permissions a role/user can have, regardless of attached policies.
- **Service Control Policies (SCPs)** — Organization-level guardrails that define the maximum permissions principals in an account can have. Can contain both Allow and Deny statements, but do not grant permissions by themselves.
- **Role chaining** — assume role A, then assume role B from A. Each assumption has a max session duration.
- **IRSA (IAM Roles for Service Accounts)** — EKS pod identity via OIDC provider trust.

## Common Patterns

```hcl
# Least-privilege role with resource ARN + condition
data "aws_iam_policy_document" "s3_read" {
  statement {
    effect = "Allow"
    actions = ["s3:GetObject"]
    resources = ["arn:aws:s3:::my-bucket/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceVpce"
      values   = ["vpce-xxxxx"]
    }
  }
}
```

```hcl
# Permission boundary: cap what developer-created roles can do
resource "aws_iam_role" "developer_role" {
  name                 = "app-role"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = aws_iam_policy.developer_boundary.arn
}
```

## Checklist

- [ ] No `*` in Action or Resource in production policies (except read-only documentation actions).
- [ ] All roles use assumable-by principals that are as narrow as possible (specific service, specific account).
- [ ] Cross-account role trust policies include `sts:ExternalId` condition.
- [ ] MFA required for human user policies (via `aws:MultiFactorAuthPresent` condition).
- [ ] Root account has MFA and no access keys.
- [ ] SCPs set in the organization to block risky actions (disabling CloudTrail, leaving the organization).
- [ ] Access Analyzer enabled to flag resources accessible from outside the account/organization.

## Gotchas

- `NotAction` / `NotResource` is dangerous — it allows everything EXCEPT the listed items, easy to write permissive-by-accident.
- Policy evaluation: explicit Deny wins, then SCP (if any), then permission boundary (if any), then identity + resource policies combined. A missing SCP allow is a deny.
- IRSA requires both: OIDC provider registered in IAM, AND ServiceAccount has the `eks.amazonaws.com/role-arn` annotation.
- AssumeRole doesn't propagate session tags automatically — need `sts:TagSession` permission and explicit tag passing.
- Condition keys differ by service. `aws:PrincipalArn` is global; `s3:x-amz-acl` is S3-specific. Wrong key silently fails (doesn't match, evaluates false).
- Role sessions expire; long-running processes must refresh credentials. SDK default providers handle this, custom signing does not.
