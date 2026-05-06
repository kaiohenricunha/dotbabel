# Workspaces

## Key Concepts

- **Workspace**: a named state slice within a single backend; `default` always exists
- **`terraform workspace new/select/list`**: manage workspaces from the CLI
- **`terraform.workspace`**: interpolation value exposing the current workspace name in config
- **Workspace-per-env**: one workspace per environment (dev/staging/prod) within one root module
- **Stack-per-env**: separate root module invocations per environment, each with its own backend config

## Common Patterns

**When to use workspaces**: lightweight environment separation with identical infrastructure topology. Works well when differences between environments are only in size or count (e.g., `var.instance_count = workspace == "prod" ? 3 : 1`).

**When to use stacks (not workspaces)**: environments diverge structurally — different regions, different providers, different resource sets. Workspaces cannot express structural differences without `count = workspace == "prod" ? 1 : 0` sprawl.

**Terragrunt as an alternative**: Terragrunt generates per-environment backend config and variable files, giving stack-per-env isolation without duplicating root module code. See `terragrunt-specialist` for details.

**Variable files per workspace**: keep `terraform.tfvars` for defaults; use `-var-file=env/prod.tfvars` per environment invocation. Do not hardcode workspace-conditional logic beyond simple sizing differences.

## Checklist

- [ ] Workspace strategy documented (workspace-per-env vs stack-per-env)
- [ ] No structural differences expressed via `workspace == "prod"` conditionals
- [ ] Variable files exist for each environment
- [ ] Backend config is workspace-aware (S3 key includes workspace name)
- [ ] `terraform workspace list` verified before plan/apply in CI
- [ ] Plan output reviewed before apply in every workspace

## Gotchas

**Workspaces share the same code.** A bug in the root module affects all workspaces simultaneously. There is no isolation at the code level — only at the state level. Apply to staging first, verify, then promote to prod.
