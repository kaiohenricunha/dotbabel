# AWS Networking

## Key Concepts

- **VPC** — isolated virtual network. Subnets are AZ-scoped. Route tables + NAT/IGW control egress. Default VPC is permissive — don't use for production.
- **ALB / NLB / CLB** — Application (L7, path/host routing), Network (L4, TCP/UDP + static IP), Classic (legacy).
- **Route53** — managed DNS. Routing policies: simple, weighted, latency, geolocation, failover, multi-value.
- **CloudFront** — global CDN. Behaviors match by path pattern; origin access control (OAC) replaces legacy OAI for S3.
- **PrivateLink / VPC Endpoints** — private connectivity to AWS services (gateway endpoints for S3/DynamoDB; interface endpoints for others).
- **Transit Gateway** — hub-and-spoke connecting multiple VPCs + on-prem.

## Common Patterns

```hcl
# VPC with public + private + isolated subnets across AZs
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  name   = "app"
  cidr   = "10.0.0.0/16"

  azs              = ["us-east-1a", "us-east-1b", "us-east-1c"]
  public_subnets   = ["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"]
  private_subnets  = ["10.0.10.0/24", "10.0.11.0/24", "10.0.12.0/24"]
  isolated_subnets = ["10.0.20.0/24", "10.0.21.0/24", "10.0.22.0/24"]

  enable_nat_gateway     = true
  single_nat_gateway     = false   # one per AZ for HA
  enable_dns_hostnames   = true
  enable_dns_support     = true
}
```

```hcl
# ALB with HTTPS redirect + target group health check
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.app.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}
```

## Checklist

- [ ] VPC has at least 3 AZs (availability + AZ-rebalancing tolerance).
- [ ] Single NAT Gateway only in dev — production uses one NAT per AZ.
- [ ] Security groups: default-deny inbound, reference other SGs (not CIDRs) for intra-VPC traffic.
- [ ] NACLs used only for subnet-level coarse controls; application-level rules belong in SGs.
- [ ] ALB/NLB access logs enabled to S3 for production.
- [ ] CloudFront uses OAC (not legacy OAI) for S3 origins.
- [ ] VPC endpoints (interface/gateway) used for private AWS service access to avoid NAT costs.

## Gotchas

- NAT Gateway bandwidth is per-gateway — a single gateway caps all egress from a subnet's AZ. Provision per-AZ for production.
- Security group rule limits are per-SG (60 inbound + 60 outbound by default) and per-ENI (total rules). Request limit increases early.
- Route53 DNS propagation isn't instant; TTL controls client-side caching. `alias` records to AWS resources follow the target's TTL, not yours.
- CloudFront price class affects edge distribution — `PriceClass_100` excludes non-US/EU edges.
- VPC peering is non-transitive: A↔B and B↔C does NOT imply A↔C. Use Transit Gateway for mesh.
- Gateway endpoints (S3, DynamoDB) are free; interface endpoints cost per hour per AZ + per GB.
