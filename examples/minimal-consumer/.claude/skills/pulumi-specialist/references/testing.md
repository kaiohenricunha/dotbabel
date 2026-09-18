# Testing

## Key Concepts

- **Unit tests with mocks**: `@pulumi/pulumi/testing/mocks` intercepts resource registrations and returns controlled outputs — no cloud credentials needed
- **Integration tests**: use the Automation API to provision real infrastructure, run assertions against outputs, then destroy
- **Property testing**: `@pulumi/policy` (Policy as Code) applies rules to every resource in a stack during preview — use for compliance checks
- **Test runner**: Pulumi programs are regular code, so use the project's native test framework (Vitest/Jest for TypeScript, `go test` for Go, `pytest` for Python)
- **`pulumi.runtime.setMocks`**: the primary entry point for unit testing — sets up the mock runtime before importing the Pulumi program

## Common Patterns

**TypeScript unit test with mocks**:

```typescript
import * as pulumi from "@pulumi/pulumi";

pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs) => {
    return { id: `${args.name}-id`, state: args.inputs };
  },
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

// Import AFTER setMocks
import { EksCluster } from "../src/eks-cluster";

describe("EksCluster", () => {
  it("creates a cluster with the correct name", async () => {
    const cluster = new EksCluster("test", {
      vpcId: "vpc-123",
      subnetIds: ["subnet-1", "subnet-2"],
    });

    await cluster.clusterName.apply((name) => {
      expect(name).toBe("test-cluster");
    });
  });
});
```

**Automation API integration test**:

```typescript
const stack = await auto.LocalWorkspace.createOrSelectStack({
  stackName: "test-integration",
  projectName: "myproject",
  program,
});
await stack.up();
try {
  const outputs = await stack.outputs();
  expect(outputs.bucketName.value).toMatch(/^myproject-/);
} finally {
  await stack.destroy();
}
```

**Policy as Code for compliance**:

```typescript
new PolicyPack("security-checks", {
  policies: [
    {
      name: "no-public-buckets",
      description: "S3 buckets must not be public",
      validateResource: (args, reportViolation) => {
        if (args.type === "aws:s3/bucketAcl:BucketAcl" && args.props.acl === "public-read") {
          reportViolation("S3 bucket ACL must not be public");
        }
      },
    },
  ],
});
```

## Checklist

- [ ] `pulumi.runtime.setMocks` called before any program imports
- [ ] Unit tests cover positive, negative, and boundary inputs
- [ ] Integration tests use `createOrSelectStack`, not `createStack`, for idempotency
- [ ] Integration test cleanup uses `destroy` in a `finally` block
- [ ] Policy packs run in CI via `pulumi preview --policy-pack`
- [ ] No cloud credentials required for unit tests (mock runtime only)

## Gotchas

**The Pulumi program must be imported AFTER `setMocks` is called.** If any module-level code registers Pulumi resources (e.g., at the top level of an `index.ts`), importing it before `setMocks` causes the real runtime to handle those registrations, which will fail without credentials. Always call `setMocks` before any `import` that triggers resource creation.
