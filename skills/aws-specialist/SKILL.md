---
id: aws-specialist
name: aws-specialist
type: skill
version: 1.0.0
domain: [infra]
platform: [aws]
task: [debugging, review]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-04-17
description: >
  Deep-dive AWS architecture review, debugging, and service design. Use for
  structured investigations of AWS-specific issues, cost or IAM audits, and
  multi-service design reviews. Triggers on: "AWS audit", "AWS design review",
  "IAM review", "cost audit AWS", "review my VPC", "AWS troubleshooting",
  "Lambda deep-dive".
argument-hint: "<account context, service, or problem description>"
tools: Read, Grep, Glob, Bash
effort: max
model: opus
---

# AWS Specialist

Structured investigation for AWS workloads. Five phases: gather context,
diagnose, design, recommend, verify.

## Arguments

- `$0` — account context, service scope, or problem description. Required.

---

## Phase 1: Context Gathering

1. Identify the account(s), region(s), and services in scope.
2. Glob for IaC in the working directory: `**/*.tf`, `**/*.yaml` (SAM/CloudFormation), `**/cdk.json`, `**/template.yaml`.
3. If AWS CLI access is available:
   ```bash
   aws sts get-caller-identity
   aws configure list
   ```
4. Note the service scope (e.g. "EKS cluster + VPC + IAM" vs "Lambda + API Gateway + DynamoDB"). Scope commands to the relevant resource types.

---

## Phase 2: Diagnosis

**Compute / containers:**

```bash
aws ec2 describe-instances --filters Name=instance-state-name,Values=running
aws ecs list-services --cluster <name>
aws eks describe-cluster --name <name>
```

**IAM / identity:**

```bash
aws iam list-policies --scope Local
aws iam get-role --role-name <role>
aws iam simulate-principal-policy --policy-source-arn <arn> --action-names <action>
```

**Networking:**

```bash
aws ec2 describe-vpcs
aws ec2 describe-route-tables
aws ec2 describe-security-groups
```

**Serverless / events:**

```bash
aws lambda list-functions
aws lambda get-function-configuration --function-name <name>
aws apigateway get-rest-apis
```

**Cost / quotas:**

```bash
aws service-quotas list-service-quotas --service-code ec2
aws ce get-cost-and-usage --time-period Start=<>,End=<> --granularity DAILY --metrics UnblendedCost
```

---

## Phase 3: Design / Root-Cause Analysis

Map symptoms to causes:

| Symptom                 | Common Causes                                          | Check                                             |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| 5xx from ALB            | Unhealthy targets, timeout mismatch, HTTP/S misrouting | Target group health, ALB access logs              |
| Lambda throttled        | Reserved concurrency, account-wide limit               | `aws lambda get-function-concurrency`             |
| EKS pod IAM fails       | Missing IRSA, ServiceAccount annotation                | OIDC provider + trust policy on role              |
| S3 AccessDenied         | Bucket policy, SCP, VPC endpoint policy                | Use `aws s3api get-bucket-policy` + IAM simulator |
| RDS CPU spike           | Missing indexes, connection storm, runaway query       | Performance Insights, slow query log              |
| CloudFront caching miss | Incorrect cache key, missing `Cache-Control`           | Check behaviors + origin headers                  |

Cite resource ARN or `file:line` for every finding.

---

## Phase 4: Recommendations

Output findings in priority order:

```
[CRITICAL] <title>
Resource: <ARN or file:line>
Issue: <one sentence>
Evidence: <CLI output or code snippet>
Fix: <specific change, with IaC diff if applicable>
Trade-off: <alternative and its downside, if meaningful>
```

- Order: CRITICAL → WARNING → INFO.
- For IaC fixes, show the exact Terraform/CDK/CloudFormation diff.
- Reference relevant docs in `references/` where applicable.

---

## Phase 5: Verification

After fixes are applied:

1. Re-run the diagnostic command that surfaced the issue.
2. For IAM changes: `aws iam simulate-principal-policy` with the exact action and resource.
3. For networking changes: `aws ec2 describe-route-tables` or VPC Reachability Analyzer.
4. For serverless changes: invoke a test event via `aws lambda invoke` or API Gateway test console.
5. Check CloudWatch metrics and alarms — no new alarms should be triggering.

---

## Reference Docs

Consult `references/` for decision guides:

| File               | When to use                                    |
| ------------------ | ---------------------------------------------- |
| `compute.md`       | EC2, ECS, EKS selection and sizing             |
| `serverless.md`    | Lambda, API Gateway, EventBridge, SQS, SNS     |
| `storage.md`       | S3, EBS, EFS, RDS, DynamoDB                    |
| `networking.md`    | VPC, ALB/NLB, Route53, CloudFront, PrivateLink |
| `iam.md`           | Policies, roles, SCPs, permission boundaries   |
| `observability.md` | CloudWatch, X-Ray, Container Insights          |
| `iac-patterns.md`  | CloudFormation, CDK, SAM patterns              |
