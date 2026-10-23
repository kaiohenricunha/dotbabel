# Artifact metadata compatibility

_Last updated: v4.5.0_

The owner approves these compatibility decisions on 2026-10-18. The complete migration mapping
is in [the implementation plan](specs/model-intelligence/spec/6-implementation-plan.md#65-migration-sequence).

## Agent invocation

The agent schema retains `invocation: passive` and `invocation: explicit` for existing consumers.
The field is deprecated metadata with no execution effect. It does not register a command,
activate an agent, select compute, or change native invocation. Omission remains valid. There is
no replacement invocation engine in this change.

## Skill headless_safe

The skill schema recognizes `headless_safe` as a boolean, as the command schema already does.
Both `true` and `false` are valid; strings such as `"true"` are invalid. Omission remains valid.
The field states the author's assessment of suitability for unattended execution. It grants no
permission and bypasses no required confirmation. It changes no model, effort, native tools,
sandbox, approvals, or runtime projection. Existing skill instructions still govern execution.
