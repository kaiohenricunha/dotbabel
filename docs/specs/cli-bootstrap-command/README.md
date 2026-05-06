# cli-bootstrap-command — Engineering Spec

> Add `dotbabel bootstrap` and `dotbabel sync` commands to the CLI so developers can set up and update their global `~/.claude/` configuration without running `bootstrap.sh` directly.
>
> Created: 2026-04-15

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

1. **Problem:** [`spec/1-problem-motivation.md`](spec/1-problem-motivation.md) — why the CLI/bootstrap split is the issue
2. **What to build:** [`spec/5-interfaces-apis.md`](spec/5-interfaces-apis.md) — exact CLI flags, Node API, and `package.json` changes
3. **How to build it:** [`spec/6-implementation-plan.md`](spec/6-implementation-plan.md) — 4 phased prompts with TDD test names
4. **Key decisions:** [`spec/4-data-flow-components.md`](spec/4-data-flow-components.md#key-decisions) — KD-1 (agents copy), KD-2 (secret-scan), KD-3 (symlink-to-npm-dir)
