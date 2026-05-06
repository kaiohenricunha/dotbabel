# Environment Hierarchy

## Key Concepts

- **Account → Region → Environment → Module**: the canonical four-level hierarchy for cloud deployments
- **Leaf module**: a `terragrunt.hcl` that configures and calls exactly one Terraform root module
- **Mid-level config**: shared `_account.hcl`, `_region.hcl`, or `env.hcl` files holding locals that flow down to leaves
- **`path_relative_to_include()`**: builds a relative path from a leaf to its Terraform source, enabling the directory layout to mirror the source layout
- **State key isolation**: each leaf must produce a unique backend state key, typically derived from the directory path

## Common Patterns

**Standard layout**:

```
infra/
├── terragrunt.hcl              # root: remote_state, generate blocks, version constraint
├── _account.hcl                # account-level locals: account_id, org_id
├── us-east-1/
│   ├── _region.hcl             # region locals: region, azs
│   ├── staging/
│   │   ├── env.hcl             # env locals: environment = "staging"
│   │   ├── vpc/terragrunt.hcl
│   │   └── eks/terragrunt.hcl
│   └── prod/
│       ├── env.hcl             # env locals: environment = "prod"
│       ├── vpc/terragrunt.hcl
│       └── eks/terragrunt.hcl
```

**State key from path**: derive the backend key from the module's relative path so it is automatically unique:

```hcl
# In root terragrunt.hcl
remote_state {
  backend = "s3"
  config = {
    key = "${path_relative_to_include()}/terraform.tfstate"
  }
}
```

**Promoting between environments**: copy the leaf directory (e.g., `staging/eks/`) to `prod/eks/` and update the `env.hcl` locals. The state key changes automatically because the path changes.

## Checklist

- [ ] Four-level hierarchy (account → region → env → module) documented
- [ ] Each leaf's state key is unique and derived from path
- [ ] Shared config in `_account.hcl` / `_region.hcl` / `env.hcl`, not duplicated in leaves
- [ ] Leaf directories mirror the Terraform module source layout
- [ ] `run-all plan --terragrunt-include-dir` scoped per environment in CI
- [ ] No cross-environment references in `dependency` blocks (prod must not depend on staging)

## Gotchas

**Renaming a directory changes the state key.** Moving `envs/staging/eks/` to `envs/staging/kubernetes/` changes the backend key, which Terraform treats as new state. The old state is orphaned and the old resources are no longer managed. Always rename with a `terraform state` migration plan, not a simple `mv`.
