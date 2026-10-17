# §5 — Interfaces and APIs

## Configuration

Use `.dotbabel.json`:

```json
{
  "model_intelligence": {
    "enabled": true,
    "adaptive_routing": { "enabled": true }
  }
}
```

Both default to false. A routing preference alone does not enable the engine. Disabling the engine retains the routing preference but makes it ineffective. No command changes global Claude/Codex configuration.

`dotbabel models enable|disable [--routing] [--repo-root <path>] [--json]` changes only these flags under the project configuration lock. `status` reports requested/effective activation separately from whether a verified runtime integration is actually active. Diagnostic `refresh`, `resolve` and `recommend` remain explicit operations even when automatic behavior is disabled.

## Data contracts

`classify({prompt, context})` returns semantic requirement, separate effort intent, confidence, characteristics and stable reason codes. No native model name appears in classification output.

`route({activation, classification, resolverInput, current, manual, runtimeCapability})` returns a decision, selected configuration, observed configuration, confidence, reasons and diagnostics. `current` is not automatically manual: `manual` tracks explicit selections per axis where the harness exposes provenance. Unknown provenance preserves the affected axis.

`apply(decision, originalSubmission)` is runtime-specific and called once before execution. Requested, accepted and observed effective configurations are separate states. A successful submission acknowledgement alone does not prove the actual model.

## Runtime contracts

Claude: investigate documented mods `prompt.submit` and `turn.step`, field mutability, main-agent identification, effort support, effective response model and manual provenance on the installed build. Regular settings hooks and frontmatter do not establish main-session routing support.

Codex: verify installed `turn/start` `model` and `effort`, persistent defaults on subsequent turns, `thread/resume`, model/effort observation, approval requests and exact input preservation. `turn/steer` is not the routing boundary. A client must not silently supply permissive sandbox or approval overrides.

## Diagnostics

JSON fields are additive and reason codes retain meaning. Codes include `intelligence_disabled`, `routing_disabled`, `classification_uncertain`, `manual_selection_preserved`, `routing_unsupported`, `routing_unverified`, `routing_apply_failed`, `effective_configuration_unknown`, `pin_floor_conflict` and `stale_capability_evidence`. Follow existing CLI exits: 0 completed, 1 policy conflict, 2 required environment unavailable, 64 invalid usage.
