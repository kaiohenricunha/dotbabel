# Dependency Blocks

## Key Concepts

- **`dependency`**: declares an explicit ordering dependency on another Terragrunt module and exposes its outputs
- **`mock_outputs`**: fallback values used when the dependency module has not been applied yet (plan-only mode)
- **`mock_outputs_allowed_terraform_commands`**: restricts when mocks are used; typically `["validate", "plan"]`
- **`outputs`**: real output values fetched from the dependency's state after it has been applied
- **Cross-stack output**: using a dependency's `outputs.<key>` in the current module's `inputs`

## Common Patterns

**Basic dependency with mocks**:

```hcl
dependency "vpc" {
  config_path = "../vpc"

  mock_outputs = {
    vpc_id          = "vpc-00000000000000000"
    private_subnets = ["subnet-00000000000000001", "subnet-00000000000000002"]
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan"]
}

inputs = {
  vpc_id  = dependency.vpc.outputs.vpc_id
  subnets = dependency.vpc.outputs.private_subnets
}
```

**Chained dependencies**: if EKS depends on VPC and an RDS module depends on EKS's security group, declare all explicit `dependency` blocks — do not assume `run-all` infers transitive ordering automatically.

**`skip_outputs`**: set `skip_outputs = true` when you only need the ordering guarantee and do not reference any outputs. This avoids a state read on each plan.

**Real vs mocked outputs**: after the dependency module is applied, `dependency.vpc.outputs.vpc_id` fetches the real value from remote state. The mock is only a fallback — its value is irrelevant to correctness once the real state exists.

## Checklist

- [ ] Every cross-module reference has an explicit `dependency` block
- [ ] `mock_outputs` types match the real output types (string vs list vs map)
- [ ] `mock_outputs_allowed_terraform_commands` set to `["validate", "plan"]` — never `["apply"]`
- [ ] `skip_outputs = true` on pure-ordering dependencies that reference no outputs
- [ ] Transitive dependencies are explicit, not assumed from `run-all` graph
- [ ] No circular dependencies (A depends on B which depends on A)

## Gotchas

**Mock output types must match the real output schema exactly.** If the VPC module outputs `private_subnets` as `list(string)` but the mock declares it as a plain string, the plan succeeds with mocks but fails on apply when real outputs are used. Always check the dependency module's `output` blocks to confirm types before writing mocks.
