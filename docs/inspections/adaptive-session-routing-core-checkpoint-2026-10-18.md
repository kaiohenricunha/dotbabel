# Adaptive routing core checkpoint

## Scope and authorization

The full owner attachment remains unchanged: original Model Intelligence P-10 through P-23, applicable P-8b, per-project activation and main-session routing in supported Claude/Codex modes, full required verification and documentation. The owner renews autonomous work with merges from 2026-10-18 03:23:34 UTC until 15:23:34 UTC. Full access is active. PR #496 merges at ac27cdd after exact-head CI and fresh criteria/review/test-plan evidence. Its worktrees are cleaned; the full initiative task moves here and remains open.

## Current implementation

Worktree `.claude/worktrees/adaptive-session-routing-core`, branch `feat/adaptive-session-routing-core`, starts from 449ad83. Shared constraints are copied into the separate resolver branch before publication so it does not ship a known hidden-model selection defect. The routing consumer remains here: pure `route.mjs` and project-gated `prepare.mjs`, with no native execution or global configuration write. The classifier remains in its own branch.

## Grounded audit and decision

A real P-11 diagnostic chooses an internal model. Cause A: the stable lexical tie can choose a smaller identifier among equivalent policy classes. Replacing that tie with native-name heuristics would create another model ranking. Cause B: native visibility is retained but never restricts automatic eligibility. Installed Codex 0.163.0 marks internal entries hide and ordinary entries list; both can expose five effort controls. Cause B is the missing constraint. The shared resolver now consumes normalized listed eligibility, modality facts, operation capabilities and adapter-owned native effort semantics; explicit controls remain independent and floors remain binding. No model-name mapping enters semantic policy.

Installed protocol schema: `/tmp/mi-codex-schema-0163`. Turn/start model and effort override this turn and later turns; effort is an advertised nonempty string, not a universal closed enum. Raw public metadata is `/tmp/mi-codex-debug-models-0163.json`. No credential files are inspected or owned.

## Verification so far

TDD starts with nine failing resolver tests and one passing explicit-hidden-pin case. The final shared-constraint file has 39 passing tests. Routing starts with missing modules; later tests reproduce incomplete effort-intent acceptance, preparation against an unsupported mechanism and absent changed-axis output before each fix. The routing file has 24 passing tests, including 1,000 warm classification/routing calls against 500 model records, with p95 at most 25 ms. The prior combined suite passes 547 tests before two later routing cases; rerun final combined proof before delivery.

The first resolver mutation run fails at 83.11%, below 85%. Added behavior and failure-boundary tests raise a concurrent run to 91.79%, but its 40 timeouts require a less-concurrent final run in the resolver worktree. That final run passes at 86.68%, with 950 killed, 145 surviving, one uncovered and zero timeouts. No threshold changes or ignored application code. The fast quality profile exits 0 with warning verdict, no environment error and every configured execution exiting 0; later edits still need final PR-quality verification.

A fresh isolated Codex refresh and cached resolution select gpt-5.5/medium, excluding hidden entries. The public routing function proposes the same configuration using a simulated supported-control descriptor. No native inference turn runs, so this is diagnostic evidence only. Logs: `/tmp/ar-core-native-refresh.json`, `/tmp/ar-core-native-resolve.json`, `/tmp/ar-core-native-route.json`.

## Remaining work

Finish independent resolver/classifier delivery, route mutation/quality and current acceptance verification. Extend shared runtime capability contracts without claiming unsupported native interception. Implement and prove real Claude mods and retained Codex App Server turns, exactly-once submissions, manual provenance and observation. Add task diagnostics and truthful active status. Original projections, snapshots, migrations, recommendations, observation, remaining adapters, builds and final full requirement audit remain open. No full-spec completion claim is permitted.

## Review and capability progress — 2026-10-18

Activation is merged in #496. Resolver PR #499 is open at 2eab1ce, with a full four-role review receipt. The fleet finds a repository class-table override, missing observed enforcement on unresolved selection and a missing invocation type declaration. Regression tests reproduce both behavior defects; fixes in `.claude/worktrees/pr-499` pass 494 Model Intelligence tests. The review branch integrates newly landed main bf83e20 by a normal merge, preserving the graph work. Final policy/resolver mutation and quality remain pending. No replies resolve findings until the fix push succeeds.

The routing core also extends the existing descriptor with optional mechanism-specific mainSession support, control axes, observation and manual-selection provenance. Existing five-block descriptors remain valid. Missing capabilities stay unverified. Model and effort observation/provenance are independent. New contract tests plus existing adapter contract tests pass 60 cases (16 new, 44 existing). No production runtime gains verified routing from adding this contract. Router/prepare mutation is running against the 24 routing tests; this does not mutate the contract validator, which the original P-5 matrix covers with contract/golden tests.

Local native schema also exposes thread model/reasoningEffort and config origins; actual turn observation still needs a real run. Official Claude mod type metadata includes BaseHookInput.effort.level after native silent downgrade, and PostModelSwitch source fields. These are research leads, not installed-version capability claims or evidence of executed turns.

## Completed local core verification

The initial routing mutation run fails at 71.07%. Added tests cover independent confidence, stale/expired current-model retention, declaration precedence, all pin layers, exact changed axes, unknown/manual provenance, default filesystem activation in concurrent projects and coded preparation failures. Integrating the reviewed resolver also reproduces a known observed floor violation falling through to preserved execution; the router now blocks that unsatisfied outcome. All 40 routing tests pass after a final malformed-classification boundary regression.

The final routing/prepare mutation run passes at 91.04%: 254 killed, 25 surviving, zero uncovered and zero timeouts across 279 mutants. The shared isClassificationUsable predicate rejects missing or invalid semantic outputs before capability loading. The threshold remains 85. The optional main-session capability contract adds 16 tests; its regression with the existing adapter contract passes 60 tests. The core-only acceptance scenarios AC-3/6/8/13/14 now become active; normal execution, runtime-specific preservation and real-session criteria remain planned. Full core quality and acceptance checks follow before publication. PR #499 merges as 774d7699cee5a893e5ae666489c01ca4d85e530e after exact-head CI run 39096164126 passes both Node 20 and Node 22 jobs. The criteria job is skipped; six original criteria pass locally with head-pinned evidence. Its three review threads are resolved and its merge gate passes. Original P-12 through P-23 remain open.

## Final local commands

`npx vitest run plugins/dotbabel/tests/adaptive-session-routing.test.mjs` exits 0 with 40 passing tests. `npx stryker run --mutate 'plugins/dotbabel/src/adaptive-session-routing/route.mjs,plugins/dotbabel/src/adaptive-session-routing/prepare.mjs' --concurrency 2` exits 0 at 91.04%, without uncovered mutants or timeouts. Logs: `/tmp/ar-core-classification-boundary-green.log`, `/tmp/ar-core-route-mutation-final.log`. Full final quality and post-integration acceptance remain required.

## Delivery checkpoint after classifier merge

Classifier #501 merges at f5f9b93 after its full review and exact-head CI. This branch preserves that main state by normal merges. The final pre-cold-turn PR profile exits 0 with warning verdict, no environment error and all configured executions exiting 0: 5,125 tests pass, 14 skip, changed lines 100%, changed branches 97.08%. The unchanged 500-model wall-clock benchmark measures p95 5.99 ms, below 25 ms. The fast profile also exits 0. All nine active adaptive criteria and six original criteria pass. A real isolated public prepareRoute dry run proposes a configuration only for enabled A, never reads disabled B's prompt, loads only A and preserves both project files. Native application remains outside this unit.

A new regression distinguishes a verified cold thread from a warm conversation. Initial inherited defaults have no prompt cache before any turn executes; retaining them provides no continuity benefit. current.turnExecuted=false skips only that retention probe, while manual pins, unknown provenance and all floors remain binding. True, absent and unverified values retain the prior conservative behavior. All 41 routing tests pass. Final mutation and PR-quality verification follow this small boundary amendment before publication.

## Final core delivery proof

After the cold-turn regression, routing/prepare mutation passes at 91.23%: 260 killed, 25 surviving, no uncovered mutants or timeouts across 285 mutants. The final PR profile exits 0 with warning verdict, no environment error and every configured execution exiting 0: 5,126 tests pass and 14 skip. Changed lines are 100%; changed branches 97.10%. The wall-clock 500-model p95 is 9.16 ms over 1,000 calls. File-size warnings remain and unconfigured measurements are not claimed as passes; the mandatory semantic review follows. Nine active adaptive criteria and six original criteria pass again. The public prepareRoute dry run retains project isolation and writes no configuration. Logs: `/tmp/ar-core-cold-turn-green.log`, `/tmp/ar-core-cold-turn-mutation.log`, `/tmp/ar-core-final-quality-pr-3.json`, `/tmp/ar-core-delivery-ar-criteria.json`, `/tmp/ar-core-delivery-mi-criteria.json`, `/tmp/ar-core-delivery-feature.json`.

The separate Codex boundary prototype now has real controlled evidence of automatic model application on a verified cold first turn, then a different effort on the same native thread. Both ordinary prompts complete with one original user message each. The native bridge, its documentation and packaging remain separate from this core unit; no runtime-application criterion is promoted here. Claude and original P-12 through P-23 remain open.
