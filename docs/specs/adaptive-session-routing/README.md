# Adaptive Session Routing — Engineering Spec

> Optional project-scoped model and reasoning selection before an ordinary main-session prompt executes.
>
> Created: 2026-10-16. Owner assignment: `2a2431bf-6f1e-4b66-aeb4-4c8782304813/pasted-text-1.txt`.

## Status

Implementation remains incomplete. The managed Codex App Server client has real-turn proof on 0.163.0. The Claude native Mods integration is experimental on 2.1.302 and 2.1.304. One ordinary MAIN turn on 2.1.304 applies the routed model; the effort axis remains unverified. See the [Claude setup and proof](../../../experiments/adaptive-session-routing-claude/README.md) and [Codex native proof](../../../experiments/adaptive-session-routing-codex/native-proof-2026-10-18.json).

## Quick Start

Read [scope](spec/2-scope.md), [architecture](spec/3-high-level-architecture.md), [interfaces](spec/5-interfaces-apis.md), [implementation plan](spec/6-implementation-plan.md) and [requirements](spec/7-non-functional-requirements.md). The [Model Intelligence spec](../model-intelligence/README.md) supplies the resolver and capability evidence. [Current state](current-state/analysis.md) separates current behavior from the requested additions.

## Research Sources

See [sources](research/sources.md). Documentation establishes candidate interfaces, not verified local integration support.
