# graph-engineering — Engineering Spec

> Created: 2026-10-12
> Branch: `spec/graph-engineering`
> Worktree: `.claude/worktrees/spec-graph-engineering/`
> Base: `origin/main` @ `33f66a8`
> Status: done on 2026-10-20 (implementing since 2026-10-13; approved the same day; unit 1a landed first)

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

All 12 units of §6.1 landed. Unit 3e ran each step's experiment under a locked rule: review-triage
REJECT, dispatch REJECT, and retry INCONCLUSIVE, so no model adapter is adopted
([adoption status](research/adoption-status.md)). The validation audit
`docs/audits/spec-graph-engineering-validation-2026-10-20.md` found 33 constraints implemented, 1 partial,
12 N/A, and all 14 acceptance criteria passing. The owner chose to close the spec on 2026-10-20.

## Quick Start

- **The problem:** [§1](spec/1-problem-motivation.md) gives the question and why it matters now.
- **What is built, and what is not:** [§2](spec/2-scope.md) has the three phases, the exclusions, and the file boundaries.
- **The design in short:** the key decisions KD-1 to KD-9 in [§4](spec/4-data-flow-components.md).
- **Every command and data shape:** [§5](spec/5-interfaces-apis.md).
- **The build order and each unit's tests:** §6.1 and §6.3 in [§6](spec/6-implementation-plan.md).
- **The numbers that the tests enforce:** [§7](spec/7-non-functional-requirements.md).

## Research Sources

See [research/sources.md](research/sources.md) for indexed source documents.
