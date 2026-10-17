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

## Activation unit evidence update — 2026-10-17

Activation implementation commit `0b0b981`; main integration commit `cca5ef7`. Main includes the verified runner repair through #492 and release #490. Renewed authorization starts 2026-10-17 04:23:33 UTC and expires 2026-10-17 16:23:33 UTC; merge yes, same scope and stops.

The first PR quality run is invalid: dependency reinstallation overlapped execution and caused missing package files. Dependencies are fully installed before subsequent runs. The second completed PR quality run exits 0 with warning verdict and no environment error. A final run after failure-boundary changes is pending; no failing gate is waived.

Activation now has 26 passing tests, including malformed input, maximum size, I/O failures, live-lock refusal and concurrent project isolation. The repaired Stryker runner scores 87.66%, 129 killed, 6 timeout, 16 survived, 3 uncovered, zero zero-test survivors. The threshold remains 85. Last successful scoped coverage before expanded fault tests: 96.49% lines, 86.95% branches, 100% functions, 91.78% statements. All 12 existing models Bats tests pass. Both original-spec AC-26/AC-27 and linked-spec AC-1/AC-2 pass; all remaining criteria remain planned.

The documented CLI feature run on an isolated project proves enable, routing opt-in, status, routing disable and engine disable. It changes no global runtime settings. `npm run lint` passes; 10 specs validate. No initiative PR has been opened yet.

Resolver worktree `.claude/worktrees/model-intelligence-resolver`, branch `feat/model-intelligence-resolver`, starts at `f368fe6`. P-10's missing-module baseline is recorded; 15 composition tests now pass. P-11 initially fails six enforcement/explanation cases as expected; implementation is in progress. Current resolver fixtures use supplied capability facts. Existing adapter evidence still lacks the reasoning/tool-call fields the shipped class rules require, so that pipeline gap must close before claiming useful end-to-end resolution.

Final activation PR-quality run: exit 0, warning verdict, environment_error=false. The configured lint, test and coverage executions each exit 0; unavailable semantic/complexity tools and large existing spec files remain reported, not called passes. The source review fixes configuration-size overflow and distinguishes unavailable reads from malformed JSON. No policy threshold is weakened. The source/tests and checkpoint receive a follow-up commit before the first push.
