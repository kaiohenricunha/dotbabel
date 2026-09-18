# Import Patterns

## Key Concepts

- **`terraform import`**: CLI command that pulls an existing resource into state by ID; requires matching `resource` block already written
- **`import` block (config-driven import)**: declarative import defined in `.tf` files; generates resource config with `terraform plan -generate-config-out=generated.tf`
- **`terraform state rm`**: removes a resource from state without destroying it — useful when handing off resource ownership
- **Bulk import**: importing many resources at once using scripts that loop `terraform import` or a single `import` block per resource
- **Import ID**: provider-specific identifier for the resource (e.g., S3 bucket name, VPC ID, `<cluster>/<namespace>/<name>` for k8s)

## Common Patterns

**Config-driven import (preferred)**: write `import { to = aws_s3_bucket.example  id = "my-bucket" }` in a `.tf` file, then run `terraform plan -generate-config-out=generated.tf` to scaffold the resource block. Review and clean up the generated config before applying.

**Manual import workflow**: (1) write the resource block matching the existing resource's properties, (2) run `terraform import <address> <id>`, (3) run `terraform plan` — expect zero diff. If there's a diff, adjust the config to match real state.

**Bulk import scripting**: when importing dozens of resources, generate import blocks programmatically from cloud API output (e.g., `aws ec2 describe-instances` → loop over instance IDs). Commit the import blocks; they are idempotent after the first apply.

**State hand-off**: when moving a resource from one root module to another, use `terraform state mv` (same backend) or `terraform state rm` + re-import (different backends). Never delete and recreate — this destroys stateful resources.

## Checklist

- [ ] Import ID format confirmed from provider documentation before running import
- [ ] Resource block written before `terraform import` (or generated with `-generate-config-out`)
- [ ] `terraform plan` shows zero diff after successful import
- [ ] Import blocks committed to version control for team reproducibility
- [ ] `terraform state list` run before and after to confirm the address is correct
- [ ] Sensitive resource attributes (passwords, keys) reviewed in state after import

## Gotchas

**Import does not generate config automatically (without `-generate-config-out`).** If you run `terraform import` before writing the resource block, Terraform writes to state but `terraform plan` will immediately plan a destroy (the resource is in state but not in config). Always write or generate the resource block first.
