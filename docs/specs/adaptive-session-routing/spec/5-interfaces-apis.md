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

The initial local classifier accepts at most 16,384 prompt bytes and a strict supplied context object
bounded to 4,096 serialized bytes. Context fields are `componentCount` (0–64), `priorFailures` (0–20),
`specification` (`present|absent|unknown`), `risk` and `consequence` (`low|medium|high|unknown`),
`ambiguity` (`low|medium|high|unknown`), and `verification` (`simple|integration|adversarial|unknown`).
It does not load that context from a repository or infer missing fields as verified facts.

`status` is `classified`, `uncertain` or `invalid`. A classified result carries a normalized dynamic
session requirement and a separate semantic `effortIntent` (`low|medium|high`). These effort labels
are not assumed to be native runtime values. Adapters must map them against verified support.
Confidence describes rule/input certainty; it is not calibrated task-success or model-quality
probability. Structured diagnostics never echo rejected prompt/context contents. Quoted examples and
negated clauses do not automatically raise demand; relevant failure facts belong in supplied context.

`route({activation, classification, resolverInput, current, manual, runtimeCapability})` returns a decision, selected configuration, observed configuration, confidence, reasons and diagnostics. `current` is not automatically manual: `manual` tracks explicit selections per axis where the harness exposes provenance. Unknown provenance preserves the affected axis.

Routing delegates modality, operation capability, ordinary-selection, semantic effort and per-axis override constraints to
the existing resolver. An automatic current-model retention probe must still require ordinary listed
eligibility. Retention cannot smuggle an internal/hidden model into an automatic choice. Runtime
control application and effective-state observation remain separate from successful resolution.

`prepareRoute(request, dependencies)` reads project activation before accessing the prompt or loading
capabilities. Unsupported mechanisms and uncertain classifications also stop before capability
loading. Dependency failures return coded fallback without copying rejected input or exception text.
A proposal remains distinct from an applied or observed configuration. Hysteresis uses a second
shared-resolver probe and cannot shadow an existing model pin.

`apply(decision, originalSubmission)` is runtime-specific and called once before execution. Requested, accepted and observed effective configurations are separate states. A successful submission acknowledgement alone does not prove the actual model.

## Runtime contracts

The shared source descriptor accepts an optional `capabilities.mainSession` table keyed by execution
mechanism. Each entry carries support/axis states, an observation support/axis block, and optional
manual-selection provenance support. Existing five-block descriptors remain valid. Unknown mechanisms
and absent axes stay unverified; a supported invocation recipe alone never proves per-turn control.
The registry snapshots and freezes this metadata. The runtime integration must still verify the
installed interface before proposing or applying a control change.

Claude: investigate documented mods `prompt.submit` and `turn.step`, field mutability, main-agent identification, effort support, effective response model and manual provenance on the installed build. Regular settings hooks and frontmatter do not establish main-session routing support.

Codex: verify installed `turn/start` `model` and `effort`, persistent defaults on subsequent turns, `thread/resume`, model/effort observation, approval requests and exact input preservation. `turn/steer` is not the routing boundary. A client must not silently supply permissive sandbox or approval overrides.

## Diagnostics

JSON fields are additive and reason codes retain meaning. Codes include `intelligence_disabled`, `routing_disabled`, `classification_uncertain`, `manual_selection_preserved`, `routing_unsupported`, `routing_unverified`, `routing_apply_failed`, `effective_configuration_unknown`, `pin_floor_conflict` and `stale_capability_evidence`. Follow existing CLI exits: 0 completed, 1 policy conflict, 2 required environment unavailable, 64 invalid usage.
