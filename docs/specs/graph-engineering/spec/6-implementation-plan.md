# §6 — Implementation Plan

> Phases, workstreams, prompts, tests, migrations, rollback.

## 6.1 Phased Rollout

| Unit | Phase | Scope                                                                                                                                   | Needs                         |
| ---- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1a   | 1     | Task schema version 2 with version-1 reads, `--depends-on` and `--drop-depends-on`, the clone-wide slug check (KD-4), and cycle refusal | —                             |
| 1b   | 1     | The work-graph module, and `task graph` and `task next` for the same repository                                                         | 1a                            |
| 1c   | 1     | The clone registry, cross-repo references, and `--online` pull request and issue references (KD-2)                                      | 1b                            |
| 2-0  | 2     | A research document: hooks, session identity, and liveness per CLI, and CPU pinning per operating system                                | —                             |
| 2a   | 2     | The host-adapter seam with the Claude Code adapter, with no behavior change, and the doctor report                                      | —                             |
| 2b   | 2     | The merge queue (KD-6)                                                                                                                  | 1b, for the order             |
| 2c   | 2     | The platform-adapter seam, plus the host and platform adapters that 2-0 verifies                                                        | 2-0                           |
| 3a   | 3     | The decider module and `dotbabel decide` with the built-in rules only, receipt version 2, the `decider` configuration key, and doctor   | —                             |
| 3b   | 3     | The skills call `dotbabel decide` with the built-in rules only, so behavior does not change                                             | 3a                            |
| 3c   | 3     | The Jev adapter in shadow mode (KD-9)                                                                                                   | 3a                            |
| 3d   | 3     | Exports (KD-3)                                                                                                                          | 1b; 3a for the decision spans |
| 3e   | 3     | Adoption per step, after the step's experiment returns ADOPT                                                                            | 3b, 3c                        |

- Phase 1, unit 2-0, and units 3a to 3c can run at the same time.
- Each phase adds its code and schema files to `linked_paths` when it starts (R-1).
- 3a edits `plugins/dotbabel/bin/dotbabel-pr-stack.mjs` and `schemas/dotbabel.config.schema.json` on top of `main`: the merge-verification work that touched them shipped as #465 (§2).
- 3a and 3d add new bins, so they also edit `package.json` and the dispatcher, `plugins/dotbabel/bin/dotbabel.mjs` (§2 Boundaries).

## 6.2 Workstream Breakdown

| Workstream              | Units              | Interface to the others                                                                                            |
| ----------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| W1, work graph          | 1a, 1b, 1c         | `dotbabel task next --json` gives the dependency order that the 2b queue uses. The task states feed the 3d export. |
| W2, coordination        | 2-0, 2a, 2b, 2c    | The host and platform adapter descriptors (§5), which `dotbabel doctor` reports                                    |
| W3, decider and exports | 3a, 3b, 3c, 3d, 3e | `dotbabel decide` (§5). Model Intelligence may call `decide()` later as an optional input (§2).                    |

## 6.3 Prompt Sequence

Each unit writes its tests first. A test name below is the exact name the test must carry.

### 1a — Task schema version 2 and dependency edges

- **Command:** `/plan`
- **Read first:** `plugins/dotbabel/src/task-state.mjs`, `plugins/dotbabel/bin/dotbabel-task.mjs`, `schemas/dotbabel.task-state.schema.json`, `plugins/dotbabel/tests/task-state.test.mjs`, `plugins/dotbabel/tests/task-cli.test.mjs`, and §5 of this spec.
- **Tests first:**
  - `task-state.test.mjs`: "reads a version-1 task as version 2 with no dependencies" (AC-1, REL-4)
  - `task-cli.test.mjs`: "task new refuses a slug that another worktree of the clone uses" (AC-2)
  - `task-cli.test.mjs`: "task update refuses an edge that closes a cycle" (AC-3)
- **Files:** modify `task-state.mjs`, `dotbabel-task.mjs`, the task-state schema, and `docs/cli-reference.md`. Create `plugins/dotbabel/src/work-graph.mjs` with the worktree scan and the cycle check, and add it to `linked_paths`.

### 1b — `task graph` and `task next`

- **Command:** `/plan`
- **Read first:** `plugins/dotbabel/src/work-graph.mjs`, `plugins/dotbabel/bin/dotbabel-task.mjs`, `plugins/dotbabel/src/pr-stack.mjs:339-364` (the stack sort, for reference only), `plugins/dotbabel/tests/task-cli.test.mjs`, and §5.
- **Tests first:**
  - `work-graph.test.mjs`: "task next lists a as ready and b as blocked by a" (AC-4)
  - `work-graph.test.mjs`: "a topological order keeps every edge"
  - `work-graph.test.mjs`: "graph and next finish within 1 second for 20 worktrees and 200 tasks" (AC-6, PERF-1)
  - `work-graph.test.mjs`: "a graph read names an unreadable task file and goes on" (REL-3)
  - `task-cli.test.mjs`: "the session-start context lists ready and blocked tasks"
- **Files:** modify `work-graph.mjs`, `dotbabel-task.mjs`, `docs/cli-reference.md`, and `docs/hooks.md`, because the session-start context gains the ready and blocked tasks of the worktree.

### 1c — Cross-repo references

- **Command:** `/plan`
- **Read first:** `plugins/dotbabel/src/work-graph.mjs`, `plugins/dotbabel/src/fleet/ledger.mjs:32-33`, `plugins/dotbabel/src/fleet/token.mjs:80-92`, `docs/fleet.md:40-46`, and §5.
- **Tests first:**
  - `work-graph.test.mjs`: "an offline pull request reference is unknown and blocks without calling gh" (AC-5)
  - `work-graph.test.mjs`: "the clone registry drops a path that no longer exists"
- **Files:** modify `work-graph.mjs` and `dotbabel-task.mjs`, which holds the `--online` flag and the `gh` calls. Create the clone-registry module.

### 2-0 — Host and platform research

- **Command:** `/think`
- **Read first:** `plugins/dotbabel/src/agents.mjs`, `plugins/dotbabel/src/fleet/registry.mjs`, `plugins/dotbabel/src/fleet/lanes.mjs`, `plugins/dotbabel/src/fleet/cpushare.mjs`, `docs/fleet.md`, and `docs/specs/model-intelligence/research/phase-0-findings.md` as a precedent.
- **Deliverable:** `docs/specs/graph-engineering/research/phase-2-0-hosts.md`. For each CLI, it gives the support state of each host capability (§5) with its evidence. For each operating system, it gives `pin` and `cpuShare`. It becomes a DOC entry. It has no tests.

### 2a — Host-adapter seam

- **Command:** `/plan`
- **Read first:** `plugins/dotbabel/src/fleet/registry.mjs`, `plugins/dotbabel/src/fleet/policy.mjs`, `plugins/dotbabel/bin/dotbabel-doctor.mjs`, `plugins/dotbabel/tests/fleet-registry.test.mjs`, and the 2-0 document when it exists.
- **Tests first:**
  - `fleet-registry.test.mjs`: "the Claude Code host adapter reports identity and liveness as supported"
  - `fleet-registry.test.mjs`: "a host without an adapter reports every capability as unsupported"
  - `dotbabel-doctor.test.mjs`: "doctor lists each host adapter's capability states" (OPS-2)
- **Files:** modify `fleet/registry.mjs`, `dotbabel-doctor.mjs`, and `docs/fleet.md`. Create the host-adapter module.

### 2b — Merge queue

- **Command:** `/plan`
- **Read first:** `plugins/dotbabel/src/fleet/token.mjs`, `plugins/dotbabel/src/fleet/format.mjs`, `plugins/dotbabel/bin/dotbabel-fleet.mjs`, `plugins/dotbabel/tests/fleet-token.test.mjs`, and `docs/fleet.md:444-517`.
- **Tests first:**
  - `fleet-token.test.mjs`: "a blocked session sees its queue position, and only the head takes a freed token" (AC-7)
  - `fleet-token.test.mjs`: "a head that does not retry loses its reservation after 10 minutes" (AC-8, REL-2)
  - `fleet-token.test.mjs`: "the queue orders sessions by the work graph, then by arrival"
  - `fleet-token.test.mjs`: "queue.off turns the queue off without a restart"
  - `fleet-token.test.mjs`: "the queue check adds at most 50 ms to a token hook call" (PERF-2)
  - `fleet-token-cli.test.mjs`: "fleet token leave removes this session from the queue"
- **Files:** modify `fleet/token.mjs`, `fleet/format.mjs`, `dotbabel-fleet.mjs`, and `docs/fleet.md`.

### 2c — Platform adapters

- **Command:** `/plan`
- **Read first:** `plugins/dotbabel/src/fleet/lanes.mjs`, `plugins/dotbabel/src/fleet/cpushare.mjs`, `plugins/dotbabel/src/fleet/heavy.mjs`, `plugins/dotbabel/hooks/fleet-shell-prefix.sh`, `plugins/dotbabel/tests/fleet-lanes.test.mjs`, and the 2-0 document.
- **Tests first:**
  - `fleet-lanes.test.mjs`: "the Linux platform adapter reports pin and cpuShare as supported"
  - `fleet-lanes.test.mjs`: "an unsupported platform turns the lanes off, and doctor says so"
- **Files:** modify `lanes.mjs`, `cpushare.mjs`, `heavy.mjs`, `fleet-shell-prefix.sh`, and `docs/fleet.md`. Create the platform-adapter module, and add each host adapter that 2-0 verifies.

### 3a — The decider and `dotbabel decide`

- **Command:** `/plan`
- **Read first:** `skills/review-pr/SKILL.md:83-95`, `skills/post-pr-review/SKILL.md:112-128`, `skills/pr-conductor/SKILL.md:76-94`, `plugins/dotbabel/src/run-receipt.mjs`, `schemas/dotbabel.run-receipt.schema.json`, and §5.
- **Tests first:**
  - `decider.test.mjs`: "the built-in review-triage rule matches the fast path and the full validation"
  - `decider.test.mjs`: "a critical or missing severity always gets full-validation for any adapter answer" (AC-9)
  - `decider-cli.test.mjs`: "decide exits 64 on an unknown step"
  - `run-receipt.test.mjs`: "reads a version-1 receipt as version 2" (REL-4)
  - `decider-boundary.test.mjs`: "no merge gate module imports the decider module" (AC-12, SEC-2)
  - `runtime-deps.test.mjs`: "the package has four runtime dependencies" (AC-13, OPS-1)
  - `dotbabel-doctor.test.mjs`: "doctor reports the decider's adapter, consent, and key presence, never the key" (OPS-2)
- **Files:** create the decider module and `plugins/dotbabel/bin/dotbabel-decide.mjs`. Modify `plugins/dotbabel/bin/dotbabel.mjs`, `package.json`, `run-receipt.mjs` and its schema, `dotbabel-pr-stack.mjs` (`record`), `dotbabel-doctor.mjs`, and `schemas/dotbabel.config.schema.json`. The merge-verification changes to `dotbabel-pr-stack.mjs` and the config schema are on `main` (#465).

### 3b — The skills call `dotbabel decide`

- **Command:** `/plan`
- **Read first:** `skills/review-pr/SKILL.md`, `skills/post-pr-review/SKILL.md`, `skills/pr-conductor/SKILL.md`, `scripts/build-plugin.mjs`, and the 3a contract in §5.
- **Tests first:**
  - `skills-decide.test.mjs`: "each judgment step's skill runs dotbabel decide"
- **Files:** modify the three skills, regenerate their copies with `scripts/build-plugin.mjs`, and update `examples/minimal-consumer/.claude/skills/`.

### 3c — The Jev adapter in shadow mode

- **Command:** `/plan`
- **Read first:** `docs/experiments/jev-finding-triage/lib.mjs`, for the request shape and the backoff, the decider module, §5, and DOC-11.
- **Tests first:**
  - `decider.test.mjs`: "an adapter timeout returns the built-in answer with fallback true and exit 0" (AC-10, REL-1)
  - `decider.test.mjs`: "without the repository's consent the adapter is never called" (SEC-3)
  - `decider.test.mjs`: "in shadow mode the skill follows the built-in answer" (KD-9)
  - `run-receipt.test.mjs`: "records each decision with its shadow answer" (OPS-3)
- **Files:** create the Jev adapter module, and modify the decider module.

### 3d — Exports

- **Command:** `/plan`
- **Read first:** `plugins/dotbabel/src/work-graph.mjs`, `plugins/dotbabel/src/run-receipt.mjs`, §5 Exports, DOC-12, and DOC-13.
- **Tests first:**
  - `export.test.mjs`: "the A2A export maps open, phase-set, and closed tasks" (AC-14)
  - `export.test.mjs`: "the OTLP export names its convention version"
  - `decider.test.mjs`: "a canary key never reaches the receipt, an export, or a log line" (AC-11, SEC-1)
- **Files:** create the exporter module and `plugins/dotbabel/bin/dotbabel-export.mjs`. Modify `plugins/dotbabel/bin/dotbabel.mjs` and `package.json`.

### 3e — Adoption per step

- **Command:** `/think`
- **Read first:** `docs/experiments/2026-10-12-jev-finding-triage.md`, `docs/experiments/jev-finding-triage/analyze.mjs`, the decider module, and the shadow answers in the run receipts.
- **Work:** run the step's experiment under its locked rule. On ADOPT, a reviewed pull request records the step's thresholds and links the experiment report. A configuration switch alone cannot adopt a step (KD-9, A-7). Retry and dispatch each need their own experiment and locked rule first.
- **Tests first:**
  - `decider.test.mjs`: "an adapter answers a step only when that step is adopted"

## 6.4 Testing Strategy

| Unit                    | Kinds applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | N/A + reason                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| W1, work graph          | Unit. Contract: schema version 2, the clone registry file, and REL-4. Property: a topological order keeps every edge, and every cycle is found. Golden: a fixture repository. Integration: real git worktrees in a temporary directory. Mutation: Stryker on each new module, run locally. Load: PERF-1.                                                                                                                                                                                                                                                                                                                                                         | Statistical: N/A, no model. Post-deploy: N/A, nothing runs after a command exits. |
| W2, coordination        | Unit. Contract: the deny text and the token record. Property: the queue order, and one holder at a time. Golden: the adapter descriptors. Integration: two sessions with a fake registry. Mutation: Stryker, run locally. Load: PERF-2. Post-deploy: the doctor report.                                                                                                                                                                                                                                                                                                                                                                                          | Statistical: N/A, no model.                                                       |
| W3, decider and exports | Unit. Contract: the `decide` input and output, receipt version 2, the configuration, the A2A export, and the OTLP export. Property: the limits hold for any adapter output. Golden: the built-in rules equal today's skill rules. Integration: a fake adapter server, for the REL-1 timeout. Mutation: Stryker, run locally. Statistical, required for each adapter step: the step's locked rule, as in DOC-7 (`docs/experiments/2026-10-12-jev-finding-triage.md:11-35`), with a bootstrap that resamples pull requests 2,000 times, and the built-in rule as the baseline. Post-deploy: the agreement between shadow and built-in answers in the run receipts. | Load: N/A, no hot path.                                                           |

## 6.5 Migration Sequence

Readers ship before writers. Every step is additive.

1. The task reader accepts versions 1 and 2. Then the writer writes version 2.
2. The token reader accepts records with and without a queue. Then the queue writer ships.
3. The receipt reader accepts versions 1 and 2. Then decisions are written.
4. The configuration schema gains an optional `decider` key. Without it, the adapter is `builtin`.
5. The skills call `dotbabel decide` with the built-in rules only. Then the shadow adapter ships. Then each step is adopted on its own.

## 6.6 Rollback Plan

| Scenario                           | Action                                                                                             | Notes                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The work graph is wrong            | Stop using `task graph` and `task next`.                                                           | Tasks keep working.                                                                   |
| A downgrade after schema version 2 | The older dotbabel reports version-2 task files as invalid, with exit 2. Re-create the open tasks. | The session-start hook fails open.                                                    |
| The merge queue misbehaves         | `touch $XDG_STATE_HOME/dotbabel/fleet/queue.off` (default `~/.local/state`)                        | As `lanes.off` does for the lanes (`docs/fleet.md:264-267`). No restart is necessary. |
| A decider gives wrong answers      | Set `decider.adapter` to `builtin` in `.dotbabel.json`.                                            |                                                                                       |
| The adapter's API is down          | Nothing: the built-in rule answers (REL-1).                                                        |                                                                                       |
| An export is wrong                 | Delete the files.                                                                                  | Exports change no state (KD-3).                                                       |
