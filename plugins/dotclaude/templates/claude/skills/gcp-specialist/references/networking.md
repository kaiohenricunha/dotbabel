# GCP Networking

## Key Concepts

- **VPC** — global resource. Auto mode (subnets per region auto) vs Custom mode (you define subnets). Custom is production-preferred.
- **Shared VPC** — hosts VPC in one project, others attach. Centralized network admin.
- **VPC peering** — connects two VPCs; non-transitive.
- **Private Google Access** — subnet flag letting VMs without public IPs reach Google APIs.
- **Cloud Load Balancing** — Global (HTTP/S, SSL proxy, TCP proxy) vs Regional. Anycast IPs.
- **Cloud Armor** — WAF + DDoS. Adaptive Protection for ML-based rules.
- **Cloud CDN** — edge caching fronting Cloud Load Balancing.

## Common Patterns

```hcl
# Custom-mode VPC + subnet with Private Google Access
resource "google_compute_network" "main" {
  name                    = "main"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "app" {
  name                     = "app-us-central1"
  network                  = google_compute_network.main.id
  region                   = "us-central1"
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.20.0.0/14"
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.30.0.0/20"
  }
}
```

```hcl
# Global HTTP(S) LB + Cloud Armor
resource "google_compute_security_policy" "waf" {
  name = "app-waf"
  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr { expression = "evaluatePreconfiguredExpr('sqli-stable')" }
    }
  }
  adaptive_protection_config {
    layer_7_ddos_defense_config { enable = true }
  }
}
```

## Checklist

- [ ] VPC in Custom mode for production (Auto mode creates subnets in every region — wasteful and risky).
- [ ] Private Google Access enabled on subnets hosting private-IP-only VMs.
- [ ] Secondary IP ranges configured for GKE cluster + services CIDRs.
- [ ] Cloud Armor attached to public-facing load balancers; Adaptive Protection enabled.
- [ ] Firewall rules: default-deny ingress, explicit allows.
- [ ] Cloud CDN enabled on static content paths; cacheable responses include `Cache-Control`.
- [ ] VPC Service Controls (service perimeters) for sensitive data projects (BigQuery, GCS).

## Gotchas

- VPC is global; subnets are regional. Routes in one region's subnet don't exist in another unless explicitly added.
- Private Google Access only covers Google APIs; on-prem resources via VPN/Interconnect still need explicit routes.
- GKE needs secondary IP ranges sized for `max pods per cluster × 2` (ranges must not overlap with primary).
- Cloud Armor rules are priority-ordered; lower number = higher priority. Accidentally placing an `allow` rule above a `deny` lets traffic through.
- Shared VPC service project permissions are managed at the host project — a missing `compute.networkUser` on the subnet breaks service project deploys.
- Cloud CDN invalidation is global and fast (~1 min) but expensive at scale — prefer short TTLs + cache versioning over frequent invalidation.
