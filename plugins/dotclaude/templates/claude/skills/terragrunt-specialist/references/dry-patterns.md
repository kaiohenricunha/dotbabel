# DRY Patterns

## Key Concepts

- **`include`**: pulls a parent `terragrunt.hcl` into the current leaf; values from parent merge with leaf
- **`read_terragrunt_config`**: reads an arbitrary HCL file and exposes its `locals` — used for cross-cutting shared values
- **`locals`**: computed values scoped to the current `terragrunt.hcl`; referenced as `local.<name>`
- **`find_in_parent_folders`**: walks up the directory tree to locate the nearest parent file by name — typically used to find the root `terragrunt.hcl` or a shared vars file
- **Path functions**: `get_terragrunt_dir()`, `get_repo_root()`, `path_relative_to_include()` — resolve paths relative to the current file

## Common Patterns

**Two-level include**: root `terragrunt.hcl` holds `remote_state`, `terraform_version_constraint`, and global `generate` blocks. A mid-level `_env.hcl` holds environment-specific locals (region, account ID). Leaf `terragrunt.hcl` includes the root and reads the env file.

**Shared inputs via `read_terragrunt_config`**:

```hcl
locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

inputs = {
  region     = local.env.locals.region
  account_id = local.env.locals.account_id
}
```

**`generate` blocks for provider injection**: define the `provider` and `terraform` backend config in a `generate` block in the root so every leaf gets it without duplication.

**Path-relative module source**: use `path_relative_to_include()` to build the Terraform module source path so moving a leaf in the directory tree doesn't break the source reference.

## Checklist

- [ ] Root `terragrunt.hcl` contains all shared config (backend, version, generate blocks)
- [ ] No `inputs` block duplicated verbatim across multiple sibling leaves
- [ ] `find_in_parent_folders` used to locate shared vars, not hardcoded relative paths
- [ ] `read_terragrunt_config` used for cross-cutting values, not copy-pasted locals
- [ ] `path_relative_to_include()` used for module source paths
- [ ] `generate` blocks inject provider and backend — leaves do not write `provider.tf` manually

## Gotchas

**`include` merges shallowly for `inputs`.** If both the parent and the leaf define `inputs = { ... }`, the leaf's map overrides the parent's entirely — it does not merge key-by-key. To share inputs across levels, use `merge(local.parent_inputs, { leaf_key = ... })` explicitly.
