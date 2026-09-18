# §2 — Scope

> What's in, what's out, and where are the boundaries?

**Settled.** The owner decided every subsection on 2026-09-17. The seven in-scope capabilities come from the spec description, and the `Touches` list comes from the inventory in [DOC-1](../research/sources.md).

## In Scope

All seven capabilities belong to the target architecture. §6 can phase their implementation, with the discovery, resolution, and migration foundations before the higher-level recommendation surfaces. Decided 2026-09-17.

1. **Discovery.** Model and capability discovery across supported runtimes and external authoritative/fallback sources.
2. **Data state.** Freshness, provenance, confidence, and availability state for discovered capability data.
3. **Resolution.** Resolution from semantic compute requirements to concrete runtime-native model/configuration.
4. **Binding modes.** Explicit pins, minimum capability floors, inheritance, and dynamic resolution modes.
5. **Design-time recommendations.** Recommendations when creating or configuring agents, workflows, and other model-aware artifacts.
6. **Runtime advisory recommendations.** Recommendations when the current model/configuration is materially mismatched with the work, including escalation and de-escalation guidance. This remains advisory; the system must not silently change the user's active model.
7. **Migration.** Backward-compatible migration of Dotbabel's existing hardcoded model/effort metadata, schemas, generated artifacts, and runtime fan-out.

## Out of Scope

These are boundaries of responsibility, not exclusions from observation. Dotbabel may inspect runtime/provider metadata needed to make and explain a recommendation without taking ownership of execution, billing, authentication, or provider policy. The owner decided all eight exclusions on 2026-09-17.

- **Model execution.** Dotbabel does not proxy model traffic, call provider inference APIs on behalf of the runtime, or become a model gateway. The selected runtime remains responsible for executing the model.
- **Automatic model changes.** Dotbabel may recommend escalation or de-escalation, but it must not silently change the user's active model or reasoning configuration. See in-scope item 6.
- **Dotbabel-owned model benchmarking.** This spec does not introduce a benchmark/evaluation platform for ranking models. Resolution may use provider metadata, runtime capabilities, external catalogs, and curated Dotbabel classifications, but building and operating an independent model-evaluation suite is separate work.
- **Cost and billing management.** Dotbabel does not calculate bills, enforce spending limits, choose models solely to minimize cost, or act as a budgeting system. Cost/latency metadata may inform explanations or future policy if trustworthy data is available.
- **Credential management.** Dotbabel does not authenticate users to runtimes or providers, copy credentials, manage API keys, or modify credential stores.
- **Provider entitlement management.** Dotbabel may observe that a model is unavailable or not exposed to the current account, but it does not purchase plans, request access, or manage subscriptions/quotas.
- **Universal model scoring.** Dotbabel does not assign one global numeric intelligence score or assume model capability, effort, context, latency, and cost can be reduced to a single ordering.
- **Replacing runtime-native configuration.** Dotbabel resolves and recommends runtime-native configurations, but each supported runtime remains authoritative for its own model identifiers, effort/thinking controls, context modes, validation rules, and execution semantics.

## Boundaries

This spec may change Dotbabel's own representation, resolution, fan-out, discovery, observation, and migration behavior. It must not become the owner of runtime configuration, authentication, billing, or provider execution. The owner settled these boundaries on 2026-09-17, and DOC-1 supplies the inventory behind the first list.

### Touches

- `schemas/{agent,skill,command}.schema.json`
- `plugins/dotbabel/src/validate-skills-inventory.mjs`
- `plugins/dotbabel/src/agents.mjs` (the `RUNTIMES` registry)
- `plugins/dotbabel/src/copilot-frontmatter.mjs`
- `plugins/dotbabel/src/project-sync.mjs`
- `plugins/dotbabel/src/build-index.mjs`
- `plugins/dotbabel/scripts/handoff-extract.sh`
- the existing model-aware artifacts under `agents/`, `skills/`, and `commands/`
- `skills/agents-search/SKILL.md`
- `skills/post-pr-review/SKILL.md`
- `plugins/dotbabel/templates/workflows/ai-review.yml`
- generated/template surfaces affected by those source changes

`handoff-extract.sh` is in scope because Model Intelligence needs an observation path for the effective runtime model where the runtime exposes one. Its existing contract conflicts directly with the new system: it hardcodes Claude's model to `null` (`plugins/dotbabel/scripts/handoff-extract.sh:84`), stores Codex's provider in the model field (`:275`), and does not cover Antigravity or OpenCode (`:9`).

### Does Not Mutate

- real runtime/user configuration roots such as `~/.claude`, `~/.codex`, `~/.gemini`, `~/.copilot`, and `~/.config/opencode`
- credential/authentication stores
- provider account/subscription state

Read-only discovery and observation of those surfaces is allowed where safe. Dotbabel does not take ownership of them.

### Does Not Redesign

- `plugins/dotbabel/src/quality/**` — reuse its resolver/state/provenance patterns where useful, but this spec does not redesign the quality system
- the spec-governance / validation system, except where Model Intelligence needs its own schema or compatibility hooks
- unrelated runtime bootstrap/install behavior

## Urgency

There is no hard external deadline. This work is **high priority but not interrupt priority**. The problems are already active and will worsen as Dotbabel adds runtimes and provider capabilities continue to change, but no current incident requires stopping other in-progress work. Decided 2026-09-17.

The current `feat/qa-harness-p-c4-mutation` work completes before Model Intelligence implementation begins, because it is already an active, bounded implementation workstream. This specification proceeds in parallel now, because it is isolated design work and does not change the active QA implementation.

Priority order:

1. Finish the current QA harness mutation workstream.
2. Complete and validate the Model Intelligence spec.
3. Begin Model Intelligence implementation after the QA work lands. Feeds §6.1.

A newly discovered correctness or compatibility issue that materially breaks supported runtimes may raise Model Intelligence above this ordering. Ordinary model/provider churn alone does not.
