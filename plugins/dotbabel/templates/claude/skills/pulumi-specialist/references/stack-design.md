# Stack Design

## Key Concepts

- **Stack**: a deployed instance of a Pulumi program; one program can have many stacks (dev/staging/prod)
- **`Pulumi.yaml`**: the project manifest — defines the runtime, description, and stack-level config defaults
- **`Pulumi.<stack>.yaml`**: per-stack config values; committed to version control; secrets are encrypted
- **`StackReference`**: reads outputs from another stack's state; the primary cross-stack dependency mechanism
- **Stack topology strategies**: stack-per-environment (one stack per env, same program) vs stack-per-tenant (one stack per customer, parameterized by config)

## Common Patterns

**Stack-per-environment**: one `dev`, one `staging`, one `prod` stack per Pulumi program. Config differences go in `Pulumi.<stack>.yaml`. Use when topology is identical across environments and only values differ.

**Stack-per-tenant**: one stack per customer, provisioned dynamically via Automation API. Config is generated programmatically. Use when each tenant needs isolated, possibly differently-sized infrastructure.

**`StackReference` for cross-stack outputs**:

```typescript
const networkStack = new pulumi.StackReference(`org/network/${pulumi.getStack()}`);
const vpcId = networkStack.getOutput("vpcId");
```

The stack name is parameterized by `pulumi.getStack()` so each environment reads from its own network stack.

**Separation of concerns**: split large programs into focused stacks — one for networking (VPC, subnets), one for compute (EKS, node groups), one for application (databases, services). Cross-stack dependencies flow one way: application depends on compute depends on networking.

**Avoid circular `StackReference`s**: if stack A references B and B references A, both stacks block each other's updates. Design the dependency graph as a DAG.

## Checklist

- [ ] Stack topology documented (stack-per-env vs stack-per-tenant vs layered)
- [ ] `Pulumi.<stack>.yaml` committed — no secrets in plaintext (use `pulumi config set --secret`)
- [ ] `StackReference` names are parameterized by `pulumi.getStack()`, not hardcoded
- [ ] Cross-stack dependency direction is one-way (DAG, no cycles)
- [ ] `pulumi preview` run before every `pulumi up` in CI
- [ ] Stack outputs are the source of truth — no raw resource IDs hardcoded in downstream stacks

## Gotchas

**Renaming a stack's config key is a breaking change for StackReference consumers.** Other stacks reading `networkStack.getOutput("vpcId")` will receive `undefined` if that output is renamed or removed. Treat stack outputs as a public API — version them deliberately and keep old output names as aliases during migrations.
