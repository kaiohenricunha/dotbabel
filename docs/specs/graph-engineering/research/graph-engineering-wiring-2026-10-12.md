# Wiring Graph Engineering and Jev into dotbabel — 2026-10-12

An assessment of how dotbabel could add a graph layer and a model-backed decision step while it stays a generic, open-source, easy-to-adopt tool and not one maintainer's harness.

## Scope

**Included:** dotbabel's packaging and dependencies, its supported CLIs, its configuration schema, its existing adapter and trust patterns, the fleet, task state, and the PR stack graph. Builds on [`graph-engineering-state-of-art-2026-10-12.md`](graph-engineering-state-of-art-2026-10-12.md) and [`jev-for-graph-engineering-2026-10-12.md`](jev-for-graph-engineering-2026-10-12.md).

**Excluded:** implementation. This audit proposes a shape and names the constraints. It does not design schemas field by field.

## Findings

### 1. The constraints that a generic tool imposes

| Item                            | Status         | Details                                                                                                                                                                                              |
| ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported CLIs                  | Six            | `claude`, `codex`, `gemini`, `antigravity`, `opencode`, `copilot` (`plugins/dotbabel/src/agents.mjs:99-230`).                                                                                        |
| Runtime dependencies            | Four, no SDKs  | `ajv`, `ajv-formats`, `js-yaml`, `prettier`; Node 20 or later (`package.json`).                                                                                                                      |
| Outbound network calls in `src` | None           | A search for `fetch(`, `https.request`, and `node:https` in `plugins/dotbabel/src` returns 0 matches. GitHub access goes through the user's `gh` (`plugins/dotbabel/bin/dotbabel-pr-stack.mjs:403`). |
| Tool installation               | Never          | "dotbabel never installs a checker" (`docs/quality.md:107`).                                                                                                                                         |
| Running project commands        | Trust-gated    | Exact-path trust allowlist; CI uses `--allow-project-commands` for one run, which never persists (`docs/quality.md:329-330`).                                                                        |
| New risky behavior              | Off by default | Unforgeable-evidence ships every switch off until a repository opts in (`docs/specs/unforgeable-evidence/spec/6-implementation-plan.md:5`, `:17`).                                                   |

Any graph or Jev wiring must keep these properties: it works with every supported CLI, it makes no network call unless the user opts in, it brings no vendor SDK, and it does nothing new until it is configured.

### 2. What already exists that a graph layer can build on

| Piece                                              | Generic today?                 | Evidence                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR stack graph and topological plan                | Yes, for any GitHub repository | `buildStackGraph` and `planStack` (`plugins/dotbabel/src/pr-stack.mjs:240`, `:445-446`); data from `gh pr list` (`plugins/dotbabel/bin/dotbabel-pr-stack.mjs:76`, `:403`).                                                                        |
| Task contract and durable state                    | Yes, files only                | Stored under the git directory, so it never shows in `git status` (`plugins/dotbabel/src/task-state.mjs:11-14`).                                                                                                                                  |
| Run receipt                                        | Yes, files only                | Append-only record of conductor phases (`plugins/dotbabel/src/run-receipt.mjs:2-7`).                                                                                                                                                              |
| Adapter descriptor with network and support states | Yes                            | `network: "never" \| "optional" \| "required"`, `execution: "read-only" \| "may-execute-model"` (`docs/specs/model-intelligence/spec/5-interfaces-apis.md:230-248`). `unverified` is never treated as `supported` (`:229`).                       |
| Fleet: claims, merge token, event feed, CPU lanes  | **No, Claude Code only**       | Titled "across Claude Code sessions" (`docs/fleet.md:1`). Session identity reads `~/.claude/sessions/<pid>.json` (`docs/fleet.md:165-166`). Liveness uses `/proc` on Linux (`docs/fleet.md:171`). Lanes pin with `taskset` (`docs/fleet.md:190`). |

### 3. Proposed shape

Three layers. Each one is useful without the next.

| Layer                        | What it adds                                                                                                                                                                                                                                                                                                                  | Generic by construction because                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **1. Work graph**            | An optional `depends_on` list in the task contract. A `dotbabel task graph` command and a `dotbabel task next` command show ready and blocked tasks, with a small topological sort of its own. (Corrected 2026-10-12: `pr-stack`'s `topoOrder` sorts only pull request numbers, `plugins/dotbabel/src/pr-stack.mjs:339-353`.) | Plain JSON files in git, read by a CLI. Any agent on any host can run the command. No model and no network.          |
| **2. Coordination adapters** | The fleet's claims and merge token behind a host adapter, so session identity and liveness come from a per-host adapter. Claude Code is the first adapter; others declare `unsupported` until verified.                                                                                                                       | Uses the existing descriptor envelope and support states, so a missing host is reported, not guessed.                |
| **3. Decision step**         | A vendor-neutral `decide` interface for router edges, such as review triage. The built-in decider is today's deterministic rule. A model-backed decider, Jev or any other, is an optional adapter with `network: "required"`, off until configured, with the user's own key.                                                  | The default path never leaves the machine. The vendor's name appears only in an adapter, never in the core contract. |

The Jev triage harness stays in `docs/experiments/` until its locked rule returns ADOPT (`docs/experiments/2026-10-12-jev-finding-triage.md:134`). A decider adapter becomes a product feature only after that.

### 4. What dotbabel should not build

| Not this                                                    | Why                                                                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A general workflow engine with nodes, edges, and supersteps | LangGraph and Microsoft Agent Framework already do this (previous audit, Finding 1). dotbabel's stated purpose is verification: "dotbabel is the verification layer" (`README.md:13-14`).     |
| A required model call anywhere in the default path          | It would break the zero-network property in Finding 1 and add cost to every user.                                                                                                             |
| A gate that trusts a decider's answer                       | An agent requests and records the answer, which is the agent-asserted evidence class that unforgeable-evidence closes (`docs/specs/unforgeable-evidence/spec/1-problem-motivation.md:20-37`). |

## Issues

| Severity | Issue                                                                                                                                               | Location                                                                                     | Recommendation                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WARNING  | The fleet works only in Claude Code and mainly on Linux, but dotbabel supports six CLIs. A graph layer built on the fleet would inherit that limit. | `docs/fleet.md:1`, `:165-171`, `:190`; `plugins/dotbabel/src/agents.mjs:99-230`              | Build the work graph on task files first. Put the fleet's session identity and liveness behind a host adapter with explicit support states.                                 |
| WARNING  | Task state is per worktree, so no shared store exists for a dependency graph across sessions.                                                       | `plugins/dotbabel/src/task-state.mjs:15-16`                                                  | Keep each task in its worktree, and add a shared index under the git common directory, which all worktrees of a clone share.                                                |
| WARNING  | Wiring Jev directly would add the first third-party network call and a single-vendor dependency to a codebase that has none.                        | `plugins/dotbabel/src` (0 network calls)                                                     | Define a vendor-neutral decider contract. Ship only the deterministic decider in core. Put Jev in an opt-in adapter that needs a key and per-repository consent.            |
| INFO     | The configuration schema has no key for a work graph or a decision step.                                                                            | `schemas/dotbabel.config.schema.json` (top-level keys)                                       | Add strict, typed keys, following the precedent that `dotbabel.compute` uses `additionalProperties: false` (`docs/specs/model-intelligence/spec/5-interfaces-apis.md:157`). |
| INFO     | The adapter descriptor and the quality trust model already solve consent and capability reporting.                                                  | `docs/specs/model-intelligence/spec/5-interfaces-apis.md:221-248`; `docs/quality.md:329-330` | Reuse both for decider adapters instead of new mechanisms. Report decider status in `dotbabel doctor`.                                                                      |
| INFO     | Graph state could interoperate with other frameworks.                                                                                               | Previous audit, Finding 3                                                                    | Later, offer an optional export that maps task states to A2A task states. Do not take a dependency on either A2A or OpenTelemetry.                                          |

## Summary

dotbabel can add graph engineering in a generic way if it starts with a file-based work graph, which needs no model, no network, and no particular CLI, and adds a small topological sort, since `pr-stack`'s planner sorts only pull request numbers. The fleet is the main obstacle to genericity, because it is tied to Claude Code and Linux, so coordination should move behind host adapters before more depends on it. Jev belongs behind a vendor-neutral, opt-in decider adapter, and only after its experiment returns ADOPT. The recommended next action is a spec for layer 1: `depends_on` in the task contract, a shared index under the git common directory, and `dotbabel task graph`.

## Sources

- [`graph-engineering-state-of-art-2026-10-12.md`](graph-engineering-state-of-art-2026-10-12.md)
- [`jev-for-graph-engineering-2026-10-12.md`](jev-for-graph-engineering-2026-10-12.md)
- `docs/fleet.md`, `docs/quality.md`, `plugins/dotbabel/src/agents.mjs`, `plugins/dotbabel/src/task-state.mjs`, `plugins/dotbabel/src/pr-stack.mjs`
- `docs/specs/model-intelligence/spec/5-interfaces-apis.md`, `docs/specs/unforgeable-evidence/spec/`
