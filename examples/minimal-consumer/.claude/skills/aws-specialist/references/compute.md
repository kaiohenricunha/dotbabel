# AWS Compute

## Key Concepts

- **EC2** — virtual machines. Choose instance family by workload (compute/memory/storage/network optimized). Spot for interruptible, Savings Plans for steady-state.
- **ECS** — AWS-native container orchestration. Fargate (serverless) vs EC2 launch type (you manage nodes).
- **EKS** — managed Kubernetes. Managed node groups (EC2) vs Fargate profiles. IRSA (IAM Roles for Service Accounts) for pod identity.
- **Auto Scaling** — EC2 Auto Scaling Groups with launch templates; ECS service autoscaling on CloudWatch metrics; EKS Cluster Autoscaler or Karpenter.

## Common Patterns

```hcl
# Fargate task — no node management
resource "aws_ecs_task_definition" "app" {
  family                   = "my-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions    = jsonencode([{ ... }])
}
```

```hcl
# EKS IRSA — pod assumes IAM role via OIDC
resource "aws_iam_role" "pod_role" {
  name = "eks-pod-role"
  assume_role_policy = data.aws_iam_policy_document.irsa.json
}

# ServiceAccount annotation: eks.amazonaws.com/role-arn
```

## Checklist

- [ ] EC2 instance families match workload profile (not default `t3.medium` for production databases).
- [ ] Spot instances used only for interruption-tolerant workloads; mixed with On-Demand via ASG mixed instances policy.
- [ ] ECS tasks use `awsvpc` network mode (task-level ENI) for production — `bridge` leaks ports between tasks.
- [ ] EKS pod identity uses IRSA, not node instance profile.
- [ ] EKS cluster autoscaler OR Karpenter — not both.
- [ ] Managed node group release channel pinned or automated.

## Gotchas

- Fargate cold starts (task startup) are seconds, not milliseconds — unsuitable for sub-second latency triggers.
- `t3`/`t4g` burstable instances accumulate CPU credits. Production workloads that exceed baseline get throttled silently; use `unlimited` mode or non-burstable.
- EKS Fargate profiles require subnets with private connectivity — public subnets are rejected.
- IRSA requires the OIDC provider to be registered with IAM once per cluster; missing registration fails silently with 403.
- ECS Service `minimumHealthyPercent: 100` + `maximumPercent: 100` blocks rolling deploys (no headroom to start new tasks).
