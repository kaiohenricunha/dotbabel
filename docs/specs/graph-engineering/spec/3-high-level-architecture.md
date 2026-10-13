# §3 — High-Level Architecture

> System view: components, data stores, external dependencies, deployment.

## System Overview

Three layers run on the user's machine. Each component is a CLI command or a hook that runs and exits.

1. **Work graph (Phase 1).** Task files gain `depends_on` edges. The graph view is computed on each read from the task files of every worktree of the clone (KD-1), and a topological sort orders the work, as `pr-stack` does for stacks (KD-7).
2. **Coordination (Phase 2).** The fleet's claims, merge token, event feed, and CPU lanes run behind host adapters, for session identity and liveness, and platform adapters, for CPU pinning. Phase 2 also adds a merge queue that the Phase 1 graph orders.
3. **Decider (Phase 3).** Three judgment steps run `dotbabel decide`, a CLI over the library function `decide()` (KD-5). The built-in rule answers by default, and model adapters are opt-in. Decisions go to the run receipt. An export command writes task states and decisions to files (KD-3).

### Constraints

- **ARCH-1:** No server or daemon. Every component is a CLI command or a hook that runs and exits.
- **ARCH-2:** No new runtime npm dependency. Today the package has four: `ajv`, `ajv-formats`, `js-yaml`, and `prettier` (`package.json`).
- **ARCH-3:** The code this spec adds makes no network call in its default path: graph reads, the clone registry, the built-in decider, and exports. Network access happens only in an opt-in adapter or behind an explicit flag, such as `--online` (KD-2). The existing `gh` calls in the event feed (`docs/fleet.md:324-325`) and in `pr-stack` stay as they are. Amended on 2026-10-12.
- **ARCH-4:** Every host, platform, and decider adapter declares `supported`, `unsupported`, or `unverified`, and `unverified` never counts as `supported`. This reuses the Model Intelligence descriptor (`docs/specs/model-intelligence/spec/5-interfaces-apis.md:221-248`).

## Data Stores

| Store                                                                                                      | Role                                                                                                                                                                            | Access Pattern                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Task files, `<git-dir>/dotbabel/tasks/<slug>.json` (existing, `plugins/dotbabel/src/task-state.mjs:11-16`) | The only source of truth for each task. Phase 1 adds `depends_on`.                                                                                                              | Written by `dotbabel task`. Read from every worktree of the clone on each graph read (KD-1). |
| Clone registry, `$XDG_STATE_HOME/dotbabel/graph/` (new)                                                    | Maps a repository key to its clone paths on this machine, for cross-repo dependencies. The key is the normalized `origin` URL, as for the fleet ledger (`docs/fleet.md:43-46`). | Updated when a task is written. Read when a dependency names another repository.             |
| Fleet state, `$XDG_STATE_HOME/dotbabel/fleet` (existing, `plugins/dotbabel/src/fleet/ledger.mjs:32-33`)    | Claims, the merge token, and merge events. Phase 2 adds the merge queue.                                                                                                        | Read and written by the fleet hooks and `dotbabel fleet`.                                    |
| Run receipt, under the git common directory (existing, `plugins/dotbabel/src/run-receipt.mjs:133`)         | The conductor's phase attempts. Phase 3 adds decider decisions.                                                                                                                 | Append-only.                                                                                 |
| Export files (new, Phase 3)                                                                                | A2A task JSON, and OpenTelemetry spans as OTLP JSON.                                                                                                                            | Written on request to a path the user names. No network (KD-3).                              |

## External APIs / Dependencies

| Service                                                                                            | Purpose                                                                                            | Rate Limits / Constraints                                                                   |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `gh`, the GitHub CLI (existing, `plugins/dotbabel/bin/dotbabel-pr-stack.mjs:403`)                  | Pull request state for stacks, and for pull request dependencies when `--online` is passed (KD-2). | Uses the user's own `gh` login, and GitHub's API rate limits apply.                         |
| A decider adapter's API (opt-in). Jev is first, at `https://api.typesafe.ai/v1/systemone` (DOC-7). | Typed answers at the three judgment steps.                                                         | The user's own key and per-repository consent. Any failure falls back to the built-in rule. |

## Deployment

- Runs locally on the user's machine, on Node 20 or later (`package.json` `engines`).
- The user installs the hooks into each host's settings, as for the fleet hooks today (`docs/fleet.md:67-70`).
- Phase 2 starts with research on each CLI's hooks, session identity, and liveness. Claude Code is the first host adapter, and the other CLIs report `unsupported` until verified (ARCH-4).
- CPU lanes run on Linux today (`docs/fleet.md:171`, `:190`). Other systems arrive through platform adapters in Phase 2.
