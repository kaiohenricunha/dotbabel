# §1 — Problem / Motivation

> Why does this exist? What's broken? Why now?

## The Question

"How do my parallel agent sessions, on any CLI, coordinate work without colliding?"

## Why

- Agent sessions that run in parallel in one repository have no shared view of which work is ready and which waits on other work. Each session plans alone.
- The fleet coordinates sessions only at run time, with file claims, a merge token, a merge event feed, and CPU lanes (`docs/fleet.md:1-21`). It works only in Claude Code, because it reads the Claude Code session registry (`docs/fleet.md:165-166`). dotbabel supports six CLIs (`plugins/dotbabel/src/agents.mjs:99-230`).
- Nothing records that one task waits on another. The task contract has no dependency field, and each worktree keeps its own tasks (`plugins/dotbabel/src/task-state.mjs:15-16`). Only stacked pull requests get a dependency order (`plugins/dotbabel/src/pr-stack.mjs:240`, `:445-446`).
- The merge token does not queue, so merges land in retry order, not in dependency order (`docs/fleet.md:514-515`).
- Collisions are common. Of concurrent pull request pairs from different agents, 41.7% conflict, against 19.8% for pairs from one agent (DOC-1).
- Judgment steps, such as review triage, send every non-mechanical finding to a full LLM validation (`skills/review-pr/SKILL.md:83-89`). A cheaper decision step has no place to plug in.

## What

- **Phase 1:** tasks declare their dependencies, and a command shows which work is ready and which is blocked.
- **Phase 2:** fleet coordination works on every CLI that has an adapter. A CLI without one reports `unsupported`.
- **Phase 3:** judgment steps call a vendor-neutral decider. The default decider is today's rule. A model such as Jev is an opt-in adapter that uses the user's own key.

## Why Now

- Durable task state (#454, `fda2c99`) and the run receipt (#451, `4ee7665`) shipped on 2026-10-12. This spec builds on them.
- The Jev triage harness (#453, `33f66a8`) is built and waits only on hand labels (DOC-7). Phase 3 gives its result a place to land.
