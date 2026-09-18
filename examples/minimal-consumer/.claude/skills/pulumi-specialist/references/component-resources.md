# Component Resources

## Key Concepts

- **`ComponentResource`**: a Pulumi resource that groups related child resources into a reusable unit with typed inputs and outputs
- **`opts.parent`**: sets the parent of a child resource to the ComponentResource, establishing the ownership tree in the resource graph
- **`registerOutputs`**: must be called at the end of the ComponentResource constructor to expose outputs to callers and to signal Pulumi that the component is complete
- **`ComponentResourceOptions`**: extends `ResourceOptions` with `providers` for multi-provider components
- **Inputs/outputs contract**: `ComponentResource` args are typed inputs; exported properties are typed `Output<T>` values

## Common Patterns

**Minimal ComponentResource**:

```typescript
export interface EksClusterArgs {
  vpcId: pulumi.Input<string>;
  subnetIds: pulumi.Input<string[]>;
  instanceType?: pulumi.Input<string>;
}

export class EksCluster extends pulumi.ComponentResource {
  public readonly clusterName: pulumi.Output<string>;
  public readonly kubeconfig: pulumi.Output<string>;

  constructor(name: string, args: EksClusterArgs, opts?: pulumi.ComponentResourceOptions) {
    super("platform:index:EksCluster", name, {}, opts);

    const cluster = new aws.eks.Cluster(
      `${name}-cluster`,
      {
        vpcConfig: {
          subnetIds: args.subnetIds,
          endpointPublicAccess: false,
        },
      },
      { parent: this },
    );

    this.clusterName = cluster.name;
    this.kubeconfig = generateKubeconfig(cluster);

    this.registerOutputs({
      clusterName: this.clusterName,
      kubeconfig: this.kubeconfig,
    });
  }
}
```

**Resource option inheritance**: child resources created inside a ComponentResource automatically inherit `provider`, `protect`, and `ignoreChanges` from the component's opts when set via `parent: this`.

**Naming convention**: prefix child resource names with `${name}-` to ensure uniqueness when the same component is instantiated multiple times. This prevents resource name collisions across instances.

## Checklist

- [ ] `super(...)` called with the URN type string `"<package>:index:<ClassName>"`
- [ ] All child resources set `parent: this` in their opts
- [ ] `registerOutputs({...})` called as the last statement in the constructor
- [ ] Exported properties typed as `pulumi.Output<T>`, not raw values
- [ ] Child resource names prefixed with the component's `name` parameter
- [ ] ComponentResource can be instantiated multiple times without name conflicts

## Gotchas

**Forgetting `registerOutputs` causes the Pulumi CLI to warn about unreported outputs and can leave the resource graph in an incomplete state.** More critically, without `registerOutputs`, Pulumi does not know which outputs are part of the component's contract — this breaks `StackReference` consumers that read from this component's outputs.
