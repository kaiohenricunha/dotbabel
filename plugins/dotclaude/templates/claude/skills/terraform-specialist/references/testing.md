# Testing

## Key Concepts

- **`terraform validate`**: syntax and schema check; catches typos and missing required fields; fast and always run first
- **`terraform test` (`.tftest.hcl`)**: native test framework; runs real applies in ephemeral workspaces; supports `run` blocks with `assert` conditions
- **Terratest (Go)**: integration test library that provisions real infrastructure and asserts on outputs; slower but more flexible
- **Mock providers**: in `.tftest.hcl`, use `mock_provider "aws" { mock_resource "aws_s3_bucket" { defaults { ... } } }` for plan-only unit tests without credentials
- **Checkov / tfsec / Trivy**: static analysis for security misconfigurations; run in CI on every PR

## Common Patterns

**Validate first, always**: `terraform validate` and `terraform fmt -check` are free — add them as the first CI step.

**Unit tests with mock providers**: use `.tftest.hcl` with `mock_provider` to assert that modules produce the expected resource graph without touching real infrastructure. Test edge cases like empty variable lists and boundary values.

**Integration tests for critical paths**: use Terratest or `terraform test` with a real provider for production-critical modules. Scope to the module under test; clean up with `defer terraform.Destroy()`.

**Static analysis in CI**: run Checkov or Trivy on every PR. Fail CI on HIGH/CRITICAL findings. Configure a `.checkov.yaml` or `trivy.yaml` ignore file to suppress accepted risks with justification comments.

**Plan assertions**: in `.tftest.hcl`, use `plan_only = true` with `assert { condition = ... }` to check resource counts and attribute values without applying.

## Checklist

- [ ] `terraform validate` in CI
- [ ] `terraform fmt -check` in CI (or pre-commit hook)
- [ ] At least one `.tftest.hcl` or Terratest file per non-trivial module
- [ ] Static analysis tool (Checkov/tfsec/Trivy) integrated in CI
- [ ] Test infrastructure isolated from production (separate account or project)
- [ ] Cleanup guaranteed (defer destroy or ephemeral workspace)
- [ ] Edge cases tested: empty lists, zero counts, optional variables unset

## Gotchas

**Mock provider defaults must match schema types.** If a mock default specifies a string where the provider expects a number, the plan still fails. Check the provider schema with `terraform providers schema` when writing mocks.
