# Providers

## Key Concepts

- **Provider**: a plugin that maps Terraform resources to an API (AWS, Azure, GCP, Kubernetes, etc.)
- **`required_providers`**: declares provider source and version constraint in `terraform` block
- **`.terraform.lock.hcl`**: pins exact provider versions and platform hashes; must be committed to version control
- **Provider aliases**: multiple configurations of the same provider (e.g., two AWS regions) using `provider "aws" { alias = "us-west-2" }`
- **Provider inheritance**: child modules inherit the default provider configuration; explicit `providers` map for aliases

## Common Patterns

**Pin conservatively**: use `~>` constraints to allow patch bumps but lock the minor version (e.g., `~> 5.0` allows `5.x` but not `6.0`). Major version bumps often contain breaking changes.

**Commit the lock file**: `.terraform.lock.hcl` must be committed. It ensures all team members and CI use identical provider binaries. Regenerate with `terraform providers lock` when adding a new platform.

**Multi-region with aliases**: define one `provider "aws" {}` per region with distinct `alias` values. Pass the alias to resources via `provider = aws.<alias>`. Never use provider aliases as a substitute for proper module design.

**Credential injection**: providers should receive credentials from environment variables (`AWS_ACCESS_KEY_ID`, `ARM_CLIENT_SECRET`) or instance/workload identity — never from hardcoded values in provider blocks.

**Provider meta-arguments**: `lifecycle { ignore_changes = [tags] }` at the resource level; `depends_on` to force ordering when providers have implicit dependencies that Terraform cannot detect.

## Checklist

- [ ] `required_providers` block present with source and version constraint
- [ ] `.terraform.lock.hcl` committed and not `.gitignore`d
- [ ] No credentials hardcoded in provider blocks
- [ ] Provider aliases documented with a comment explaining each region/account
- [ ] `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64` run for CI + local dev
- [ ] Provider upgrades tested on staging before rolling to prod

## Gotchas

**`terraform init -upgrade` ignores the lock file.** Running `init -upgrade` fetches the newest provider matching the version constraint, overwriting `.terraform.lock.hcl`. This can silently introduce breaking provider changes. Always review the diff of `.terraform.lock.hcl` after an upgrade.
