# Automation API

## Key Concepts

- **Automation API**: a programmatic interface to the Pulumi engine — run `up`, `preview`, `destroy`, and `refresh` from Node, Python, or Go code without a CLI
- **`LocalWorkspace`**: manages stacks whose programs live on the local filesystem; used for CI pipelines and custom CLIs
- **`RemoteWorkspace`**: manages stacks whose programs live in a Pulumi Cloud workspace; used for self-service portals
- **`InlineProgramDeployment`**: runs a Pulumi program defined as an in-process function, not a separate file — ideal for dynamic stack generation
- **`OnEvent`**: callback for streaming engine events (resource creates, updates, failures) to logs or UIs during a run

## Common Patterns

**Basic `up` with inline program**:

```typescript
import * as auto from "@pulumi/pulumi/automation";
import * as aws from "@pulumi/aws";

const program = async () => {
  const bucket = new aws.s3.BucketV2("my-bucket");
  return { bucketName: bucket.bucket };
};

const stack = await auto.LocalWorkspace.createOrSelectStack({
  stackName: "dev",
  projectName: "my-project",
  program,
});

await stack.setAllConfig({ "aws:region": { value: "us-east-1" } });

const result = await stack.up({ onOutput: console.log });
console.log(result.outputs.bucketName.value);
```

**Streaming events to a UI**:

```typescript
await stack.up({
  onEvent: (event) => {
    if (event.resourcePreEvent) {
      console.log(`Creating: ${event.resourcePreEvent.metadata.urn}`);
    }
  },
});
```

**Multi-stack orchestration**: provision a VPC stack, read its outputs, pass them to an EKS stack — all in a single Go or Node program. This replaces manual sequencing of `pulumi up` CLI calls in shell scripts.

**Destroy on cleanup**:

```typescript
try {
  await stack.up();
  // ... use the stack
} finally {
  await stack.destroy({ onOutput: console.log });
}
```

## Checklist

- [ ] `createOrSelectStack` used instead of `createStack` alone — handles re-runs gracefully
- [ ] `setAllConfig` called before `up` — config is not read from `Pulumi.<stack>.yaml` in inline mode
- [ ] `onEvent` handler captures errors for observability
- [ ] Long-running operations have a timeout enforced by the caller
- [ ] `destroy` called in a `finally` block for ephemeral stacks (test environments, preview envs)
- [ ] Secrets set via `{ value: "...", secret: true }` in `setConfig`, not plain config

## Gotchas

**Inline programs do not automatically load `Pulumi.<stack>.yaml` config.** Unlike the CLI, the Automation API with an inline program starts with an empty config — you must call `stack.setConfig` or `stack.setAllConfig` explicitly for every value the program reads. Missing config calls cause the program to receive `undefined` and may silently use defaults or fail at runtime.
