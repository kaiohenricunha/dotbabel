# model-intelligence — Engineering Spec

> Design a provider-neutral Model Intelligence system for Dotbabel that replaces stale hardcoded model/effort assumptions with semantic compute requirements resolved to concrete runtime-native configurations across Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, GitHub Copilot CLI, and OpenCode. It must support model/capability discovery, freshness and provenance, runtime-specific resolution, intentional pins and inheritance, design-time recommendations for agents/workflows, runtime advisory recommendations to users, and backward-compatible migration of the existing model-aware agents, skills, commands, and fan-out behavior.
>
> Created: 2026-09-17

## Status

| #   | Section                     | Status   |
| --- | --------------------------- | -------- |
| 1   | Problem / Motivation        | [x] done |
| 2   | Scope                       | [x] done |
| 3   | High-Level Architecture     | [x] done |
| 4   | Data Flow / Components      | [x] done |
| 5   | Interfaces and APIs         | [x] done |
| 6   | Implementation Plan         | [x] done |
| 7   | Non-Functional Requirements | [x] done |
| 8   | Risks and Alternatives      | [x] done |

## Quick Start

The owner settled all eight sections between 2026-09-17 and 2026-09-18. The owner approved the spec on 2026-09-18; the metadata status in `spec.json` is `approved`. This is a brownfield spec: [current-state/analysis.md](current-state/analysis.md) holds the grounded analysis of the model metadata that Dotbabel ships today and the preserved behaviors PB-1 to PB-13.

Read in this order:

1. [§1 Problem / Motivation](spec/1-problem-motivation.md) — the question, the four failures, and why now.
2. [§4 Data Flow / Components](spec/4-data-flow-components.md) — the target architecture and the six key decisions KD-1 to KD-6. This is the core of the spec.
3. [§5 Interfaces and APIs](spec/5-interfaces-apis.md) — the contracts: `dotbabel.compute`, the source adapter, the resolver, the `dotbabel models` CLI, materialization and provenance, and the release snapshot.
4. [§6 Implementation Plan](spec/6-implementation-plan.md) — seven phases, ten workstreams, 23 implementation prompts, the test tiers, the additive migration, and the rollback plan.
5. [§7 Non-Functional Requirements](spec/7-non-functional-requirements.md) — 21 constraints, each with its metric, its value, and the action on breach.

Reference: [§2 Scope](spec/2-scope.md), [§3 High-Level Architecture](spec/3-high-level-architecture.md) (ARCH-1 to ARCH-36, the five stores, and the accepted dependencies), and [§8 Risks and Alternatives](spec/8-risks-alternatives.md).

Before implementation starts: `feat/qa-harness-p-c4-mutation` lands (§2 `Urgency`), and Phase 0 closes RQ-1, RQ-3, and RQ-4 in [research/sources.md](research/sources.md). The class-F owner-decision gate (IMPL-7) blocks only P-19f.

## Research Sources

See [research/sources.md](research/sources.md) for indexed source documents.
