# run-all

## Key Concepts

- **`run-all`**: executes a Terraform command across all modules in a directory tree, respecting `dependency` ordering
- **Dependency graph**: Terragrunt infers execution order from `dependency` blocks; independent modules run in parallel
- **`--terragrunt-non-interactive`**: suppresses confirmation prompts — recommended for CI on both `plan` and `apply`; does not suppress plan output (capture it with `tee`); the real risk is running `apply` without first reviewing the plan, not the flag itself
- **`--terragrunt-include-dir`**: scopes `run-all` to specific subtrees; use to apply a single environment without touching others
- **`--terragrunt-ignore-dependency-errors`**: continues past module failures — use with caution, can leave infra in a partial state

## Common Patterns

**Always plan before apply**:

```bash
terragrunt run-all plan --terragrunt-non-interactive 2>&1 | tee /tmp/plan.txt
# Review /tmp/plan.txt for destroys before proceeding
terragrunt run-all apply --terragrunt-non-interactive
```

**Scope to one environment**:

```bash
# Apply only the staging subtree
terragrunt run-all apply --terragrunt-include-dir "envs/staging/**"
```

**Graph visualization** (when available):

```bash
terragrunt run-all graph-dependencies
```

**Partial apply with `--target`**: pass `--terragrunt-forward-tf-args="-target=aws_s3_bucket.example"` to scope what each module applies. Use sparingly — `run-all` + target is complex to reason about.

## Checklist

- [ ] `run-all plan` reviewed before any `run-all apply`
- [ ] Plan output checked for unexpected destroys (`-` lines)
- [ ] `--terragrunt-non-interactive` set in CI; `run-all apply` never run without a prior `run-all plan` review
- [ ] `--terragrunt-include-dir` used when targeting a single environment
- [ ] Dependency graph verified to match intended execution order
- [ ] No `--terragrunt-ignore-dependency-errors` in production pipelines

## Gotchas

**`run-all apply` stops on the first error by default, but partially applied changes are not rolled back.** If module B depends on module A and module A fails mid-apply, Terraform has already mutated whatever A touched. Running `run-all apply` again after fixing the error will re-run A and continue to B. Understand the blast radius before running `run-all apply` in production.
