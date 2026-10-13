# §4 — Data Flow / Components

> Current state analysis + target architecture.

## Current State

- **Tasks.** One file per task, per worktree, at `<git-dir>/dotbabel/tasks/<slug>.json` (`plugins/dotbabel/src/task-state.mjs:11-16`). The schema is version 1 and has no dependency field (`:58`). A per-task lock guards each write (`:28`, `:477-478`). The SessionStart hook prints the open tasks of the worktree (`plugins/dotbabel/bin/dotbabel-task.mjs:7`).
- **Stacks.** `pr-stack graph` and `pr-stack plan` build a graph from `gh pr list` (`plugins/dotbabel/bin/dotbabel-pr-stack.mjs:14-15`, `:403`) and order it by pull request number (`plugins/dotbabel/src/pr-stack.mjs:339-353`).
- **Fleet.** The first edit of a file claims it, and a peer's edit is denied (`docs/fleet.md:25-35`). The merge token is taken on a rebase, an attestation, or a merge (`:444-470`). Merges are recorded as events (`:324-341`). Heavy test commands queue for CPU lanes (`:189-191`). Session identity and liveness come from the Claude Code session registry and `/proc` (`plugins/dotbabel/src/fleet/registry.mjs:2-3`, `docs/fleet.md:165-171`).
- **Judgment steps.** Rules or model judgment written in skill prose: review triage (`skills/review-pr/SKILL.md:83-89`), reviewer dispatch (`skills/post-pr-review/SKILL.md:112-126`), and the retry after a failed phase (`skills/pr-conductor/SKILL.md:76-94`).

## Component Boundaries

Target responsibilities:

- **`task-state.mjs`** gains `depends_on`, schema version 2, and the clone-wide slug check (KD-4).
- **Work-graph module (new)** collects the tasks of every worktree and the clone registry, resolves references, sorts them (KD-7), and reports cycles. Its functions are pure. The `git` and `gh` calls stay in the bin, as `pr-stack` keeps them (`plugins/dotbabel/bin/dotbabel-pr-stack.mjs:10`).
- **Fleet.** `registry.mjs` becomes the host-adapter seam, for session identity and liveness. `token.mjs` gains the reservation queue (KD-6). `lanes.mjs`, `cpushare.mjs`, and `heavy.mjs` become the platform-adapter seam.
- **Decider module (new)** holds `decide()`, the built-in rule of each step, and the adapters. The limits of each step (§5) live in `decide()`, so no adapter can cross them.
- **Exporter (new)** writes files only (KD-3).

## Shared State

| State          | Writers                                  | Synchronization                                                               |
| -------------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| Task files     | One session at a time per task           | The existing per-task lock (`plugins/dotbabel/src/task-state.mjs:28`)         |
| Clone registry | Many sessions on one machine             | An atomic write, a temp file and a rename, under a lock                       |
| Fleet state    | The fleet hooks and `dotbabel fleet`     | The existing rules (`docs/fleet.md:63-65`). The queue joins the token record. |
| Run receipt    | The conductor, through `pr-stack record` | Append-only (`plugins/dotbabel/src/run-receipt.mjs:2-7`)                      |

## Target Architecture

The three layers of §3, shaped by the key decisions below.

### Key Decisions

- **KD-1 — The task index is computed on read.** Each graph read collects the task files of every worktree of the clone. The task files stay the only source of truth, so no copy can go stale. A small machine-level registry maps each repository to its clones, for cross-repo dependencies only. Decided on 2026-10-12, over a write-through index file.
- **KD-2 — A cross-repo dependency resolves offline by default.** A task in another local clone resolves from its files. A GitHub pull request or issue resolves through `gh` only when the user passes `--online`, and its state is `unknown` otherwise. Decided on 2026-10-12.
- **KD-3 — Exports write files only.** A2A task JSON and OTLP JSON spans go to a path the user names, with no network and no SDK. Decided on 2026-10-12, over an opt-in push to an OTLP endpoint.
- **KD-4 — Task slugs are unique per clone.** `dotbabel task new` refuses a slug that any worktree of the clone already uses, so a same-repository dependency is a bare `<slug>`. The check reuses the worktree scan of KD-1. Decided on 2026-10-12, over `<branch>:<slug>`. This resolves Q-1 in §5.
- **KD-5 — The decider is a CLI, binding within fixed limits.** Skills run `dotbabel decide` and follow its JSON answer, as they run `pr-stack gate --gate budget` today (`skills/pr-conductor/SKILL.md:76-80`). `decide()` is the library function behind the CLI. Each step has limits that no decider can cross (§5). Decided on 2026-10-12, over an advisory-only answer.
- **KD-6 — The merge queue is a reservation, not a wait.** A blocked session joins the queue, and its deny reason shows its position. When the token frees, only the queue head may take it, until its reservation expires (REL-2). The order is the dependency order from the Phase 1 graph, then arrival time. Nothing waits inside a hook, which has a 10-second timeout (`docs/fleet.md:82`), so ARCH-1 holds. Decided on 2026-10-12, over a wait in `fleet-shell-prefix.sh`.
- **KD-7 — The work graph has its own topological sort.** `topoOrder` is typed for the pull request stack graph: it sorts pull request numbers, breaks ties by pull request number (`plugins/dotbabel/src/pr-stack.mjs:339-353`), and takes its cycles from `buildStackGraph` (`:335`, `:364`). The work graph sorts task references, with a stable tie-break by reference, and `pr-stack.mjs` stays untouched. Decided on 2026-10-12, over extracting a shared sort. It corrects an earlier claim that Phase 1 could reuse `topoOrder` unchanged.
- **KD-8 — The repository consents, and the user holds the key.** A repository's committed `.dotbabel.json` enables a model decider, which is the owner's consent to send its data out. Each user supplies the adapter's key outside the repository. Without a key, the built-in rule answers. Decided on 2026-10-12, over a user-scope-only switch, which would let a contributor send a private repository's code out without the owner's consent.
- **KD-9 — A model adapter earns each step.** A model adapter answers a step only after that step's experiment, under a locked rule like the Jev triage rule (DOC-7), returns ADOPT. Until then it runs in shadow mode: its answer is logged beside the built-in answer, and the skill follows the built-in. Decided on 2026-10-12, over a switch the owner turns on without an experiment.
