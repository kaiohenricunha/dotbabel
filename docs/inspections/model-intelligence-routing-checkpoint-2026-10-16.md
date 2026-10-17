# Model Intelligence and Adaptive Routing — implementation checkpoint

## Scope and authorization

Owner attachment: `2a2431bf-6f1e-4b66-aeb4-4c8782304813/pasted-text-1.txt`, all 14 sections. End state remains the full original spec plus optional project-local adaptive main-session routing. No requirement is reduced to the first working subset.

Autonomy: `$yolo until the end of this goal --for 12h --merge`, repository `kaiohenricunha/dotbabel`, start 2026-10-16 23:30:49 UTC, expiry 2026-10-17 11:30:49 UTC. Includes scoped pushes/PRs/merges subject to gates. Owner explicitly requests surgical spec amendments. Other skill stops remain; runtime permissions are unchanged.

## Grounded initial gap assessment

Baseline `0e766b5`: domain, requirement, compat, policy, source adapters and catalog are implemented. `plugins/dotbabel/bin/dotbabel-models.mjs:52` exposes refresh/status/migrate only. `docs/specs/model-intelligence/spec/6-implementation-plan.md:406` starts the unimplemented resolver units. No resolver/materialize/snapshot/recommend directory exists at baseline. All 25 acceptance criteria are planned. Design dashboard completion does not prove implementation.

Specified but missing: P-10/P-11 composition, enforcement and explanations; P-12–P-17 materialization/release/workflow projections; P-18/P-19 migration and owner decisions; P-20–P-23 recommendation, observation, remaining adapters and consolidated CLI.

New: explicit project activation and separate routing opt-in; task classification with independent effort intent; main-session per-turn runtime application; manual provenance; exactly-once forwarding; effective-state evidence; representative engineering task fixtures and simultaneous enabled/disabled repositories.

Two explanations for the previous poor mutation score were considered. Weak tests predict executed but surviving mutations. Runner name mismatch predicts zero selected tests. PR #486 source and an isolated rerun prove the second mechanism: repaired runner scores 90.91%, 2.56 tests per mutant, zero zero-test survivors. This is a runner compatibility repair, not permission to lower thresholds. PR #486 closed during this run; `origin/main` at `7ef7831` includes the identical repair through #492. No original worktree was modified.

## Current work and evidence

Worktree `.claude/worktrees/model-intelligence-complete`, branch `feat/model-intelligence-project-activation`, created from `origin/main` at `0e766b5`. Task `model-intelligence-complete` records the full done conditions in its Git worktree metadata. Initial activation tests failed because the module was missing. After implementation, 13 tests pass outside the sandbox, including concurrent project processes; sandboxed child process streams are empty and do not provide valid integration evidence.

PR #486 isolated verification worktree `.claude/worktrees/mi-runner-verification`, detached `58961fab33db88e0314738f845c8f0656c538b02`. `npm ci` installs actual Vitest 5.0.0. Runner and dogfood tests: 13 pass. `npx stryker run --mutate 'plugins/dotbabel/src/model-intelligence/policy/**/*.mjs'`: 90.91%, 222 killed, 28 timeout, 21 survived, 4 no coverage, zero zero-test survivors. Log `/tmp/mi-runner-policy-mutation.log`. Merge gate returned pass, head CI run 38506769659 succeeded; merge attempt failed because the owner closed #486 while the equivalent repair landed in #492. Do not reopen it.

## Requirement ledger / remaining work

| Owner section    | Completion evidence required                                       | Current state                                    |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| 1 existing state | source/history/worktree/PR/test inspection                         | inspected; further source reads follow each unit |
| 2 architecture   | one pure shared resolver and regression proof                      | foundations retained; resolver absent            |
| 3 project opt-in | schema, CLI, concurrent isolation and disabled-path checks         | implementation/tests in progress                 |
| 4 main prompt    | real prompt selects both axes before execution                     | not implemented                                  |
| 5 linked spec    | linked architecture, criteria and phases                           | authored; validation pending                     |
| 6 classifier     | strategy evaluation and representative fixtures                    | not implemented                                  |
| 7 runtimes       | installed contracts and real Claude/Codex effective-state evidence | docs researched; local proof pending             |
| 8 controls       | manual axes/floors/pins/exactly-once/approval tests                | not implemented                                  |
| 9 CLI            | activation, explain, status and coded JSON                         | activation in progress; other surfaces pending   |
| 10 original plan | every P-10 through P-23 check and migration decision               | pending                                          |
| 11 acceptance    | active executable metadata and real runtime evidence               | 25 original criteria still planned               |
| 12 workflow      | coherent tested PRs and durable commits/checkpoints                | current checkpoint; no new PR yet                |
| 13 done          | requirement-by-requirement final audit                             | unproven; initiative incomplete                  |

## Next executable steps

Validate and finish activation/spec unit; integrate latest main including the runner repair; commit and open its scoped PR. Then write P-10/P-11 resolver composition/enforcement tests before implementation, following the supplied catalog and policy shapes. Add routing classification after the spec boundary is stable; do not wait for every artifact migration to start independent classifier work.

The abandoned peer task's worktree `.claude/worktrees/peer-collaboration-complete` is preserved and is outside this scope. No peer changes are imported here. Original model-intelligence and other sessions' worktrees are untouched.
