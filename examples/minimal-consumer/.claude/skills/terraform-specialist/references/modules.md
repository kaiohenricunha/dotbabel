# Modules

## Key Concepts

- **Root module**: the top-level directory where `terraform apply` runs; consumes child modules
- **Child module**: a reusable directory called via `module` block with `source`
- **Input variables**: the public API of a module — define with `variable` blocks, document with `description`
- **Outputs**: values a module exports for parent consumption; sensitive outputs should be marked `sensitive = true`
- **Locals**: intermediate computed values; reduce repetition without exposing as inputs/outputs

## Common Patterns

**Minimal variable surface**: expose only what callers need to vary. Avoid pass-through variables that just relay a parent's values to a deeper child.

**Typed variables**: always declare `type` constraints (`string`, `list(string)`, `object({...})`). Untyped variables accept any value and produce cryptic errors downstream.

**Outputs as contracts**: any resource property a caller might reference should be an output. Avoid forcing callers to construct ARNs or names from inputs — export them from the resource.

**`for_each` over `count`**: `count` uses integer indices; renaming an element at index 0 replaces everything. `for_each` uses stable string keys. Prefer `for_each = { for k, v in var.items : k => v }`.

**Module versioning**: when sourcing from a registry or Git, pin to a version tag (`?ref=v1.2.0`), never a branch. Branch pins drift silently.

## Checklist

- [ ] All `variable` blocks have `description` and `type`
- [ ] No variable is a pass-through relay more than one level deep
- [ ] `sensitive = true` on any output containing credentials or tokens
- [ ] `for_each` used instead of `count` for resources keyed by name
- [ ] Module source pins a version tag, not a branch
- [ ] `terraform validate` passes with no warnings
- [ ] Outputs cover all resource properties callers are likely to reference

## Gotchas

**Changing `count` to `for_each` is destructive.** Terraform sees the `count`-indexed resources as different addresses from `for_each`-keyed resources and will plan a replace. Use `terraform state mv` to migrate state before switching, or run a targeted apply with `moved` blocks.
