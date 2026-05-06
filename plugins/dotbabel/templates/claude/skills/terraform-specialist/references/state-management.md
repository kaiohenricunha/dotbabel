# State Management

## Key Concepts

- **State file**: Terraform's source of truth mapping config to real infrastructure; never hand-edit
- **Backend**: where state is stored and locked (S3+DynamoDB, GCS, AzureRM, Terraform Cloud)
- **State locking**: prevents concurrent `apply` runs from corrupting state; verify the lock backend is configured
- **`terraform state mv`**: relocates resources within state without destroying them — use for module refactors
- **`terraform import`**: pulls existing real resources under Terraform management; pairs with `import` blocks
- **Drift**: real infrastructure diverges from state due to manual changes or out-of-band automation

## Common Patterns

**Remote state with locking**: all team environments must use a remote backend with locking. Local state is only acceptable for personal experimentation.

**State isolation by blast radius**: each workspace or stack should own one logical environment. Never share state between prod and staging.

**Import before manage**: when adopting existing infrastructure, run `terraform import` (or define `import` blocks) before writing resource config. Attempting to create already-existing resources causes errors or duplicates.

**State move for refactors**: when restructuring module hierarchies, use `terraform state mv old.address new.address` before `terraform apply`. Without this, Terraform destroys the old resource and creates a new one.

**Sensitive state**: state files contain resource attributes in plaintext — treat the state backend like a secrets store. Enable server-side encryption on S3/GCS buckets and restrict access via IAM.

## Checklist

- [ ] Remote backend configured with locking
- [ ] State bucket has encryption and versioning enabled
- [ ] IAM access to state backend is least-privilege
- [ ] `terraform state list` checked before any module refactor
- [ ] `moved` blocks or `state mv` used for all address changes
- [ ] No resource that already exists is targeted by a `create` without prior `import`
- [ ] Drift detected with `terraform plan` after any out-of-band change

## Gotchas

**`terraform refresh` can mask drift permanently.** Running `terraform refresh` updates state to match reality — including deleting resources from state that were manually destroyed. This makes the drift invisible to `plan`. Always review `terraform plan` output before running `refresh` to understand what's being reconciled.
