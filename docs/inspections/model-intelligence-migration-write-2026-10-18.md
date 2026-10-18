# P18 migration write and scoped floors

The migration writer preserves native model/effort fields and exact artifact bodies. It adds
canonical declarations only from reviewed per-artifact decisions, or from explicit `inherit`.
An alias-derived proposal remains report-only. Unknown and class-F artifacts stay unchanged.
`--decisions` accepts a bounded JSON array with sourcePath, artifactKind, category and compute;
`--batch` selects one DOC-1 category. Decisions outside the discovered canonical inventory,
duplicates, invalid declarations and incompatible dual declarations fail before any write.
This is migration input, not a second runtime model catalog. P19 supplies reviewed batch inputs.

Writes use the existing Linux descriptor-anchored filesystem and shared root lock, then compare
original bytes before each atomic replacement. Every intermediate file retains working legacy
controls. The complete batch is prevalidated; a concurrent edit stops subsequent replacement.
There is no unsafe rollback over user edits. Check and analysis do not acquire or create locks.

## Scoped policy boundary

Policy floors select exact canonical source paths and artifact kinds, with no globs or aliases.
All layers accumulate minima; stronger previous floors survive weaker later floors. The shipped
security agent and security-review selectors carry Frontier minima. Unrelated artifacts have no
global minimum. Schema and pure runtime validation share the same selector boundaries.

## Regression diagnoses

The first public decision-file test fails while the library tests pass. Candidate one is invalid
JSON input; the same valid JSON reaches the library successfully. Candidate two is the CLI's
undefined path helper and undefined POLICY exit enum. Actual imports expose resolve and the
exit enum exposes VALIDATION; correcting those names makes the public check/write/check pass.

The inherited-selector test fails before strict object validation. Candidate one is path matching;
the path itself is valid. Candidate two is inherited object properties accepted by the pure normalizer.
`policy/scopes.mjs` reads the selector fields after counting own keys; restrict entries/scopes to
plain or null-prototype objects before reading fields. This is the chosen correction.

The dynamic release security test loses model/effort despite a satisfied scoped floor. Candidate
one is resolver scope matching; its resolved result contains the required native configuration.
Candidate two is `materialize/runtime/claude.mjs` dynamicBaseline, which tests only the global
floor and strips native axes even when a scoped floor applies. Preserve native axes whenever
composition reports an applied scoped floor. The regression checks emitted native metadata.

The actual four-check migration fixture reaches validation with a new concrete generated model,
while canonical `model: haiku` remains unchanged. Candidate one is an obsolete native-model
validator; broadening its alias gate would hide the more important compatibility change.
Candidate two is the release adapter dropping its legacy pin as soon as canonical intent appears
(`claude-build.mjs` checks requirement === null, and `claude.mjs` does the same). This violates
the transitional bridge in §6.5: adding semantic intent must not change working native controls.
Preserve the original native pin while the legacy declaration remains; keep its resolver floor
check and no-default-effort rule. Only a separately verified migration removes that bridge.

An already-canonical report initially labels a known declaration as unresolved because it still
processes its legacy proposal. The parser proves canonical intent exists; missing intent is ruled
out. Restrict the unresolved proposal branch to artifacts without canonical declarations.

A cyclic YAML metadata fixture reproduces stack overflow in the writer's `noRefs: true` dump.
Malformed YAML is ruled out because the shared YAML parser reads the graph successfully.
Preserve YAML references with the dumper's normal reference support; the body remains exact.
This avoids recursive expansion while preserving unrelated authored metadata.

The first full regression also catches two existing canonical precedence cases: explicit dynamic
intent must not freeze old native axes, and explicit inherit must discard shadowed native axes.
A universal legacy bridge is therefore too broad. Restrict retained native compatibility pins to
absent canonical intent and mandatory floor migrations. Existing dynamic/inherit tests then pass.
Explicit canonical pins still reject a conflicting retained native selector.

The initial mutation dry run catches a second deterministic golden identity change in the core
materializer. Regeneration verifies unchanged native body bytes before recording the new policy
provenance. The first executed mutation scope measures 69.39%, with 209 actual semantic tests.
Add the writer boundary tests, scope monotonicity/validation cases and the existing route and
projection regression suites before repeating the same module scope plus the changed release
builder. The 85% threshold stays unchanged. Three performance benchmarks are outside mutation
only; the ordinary regression still runs them.

Concurrent fast quality fails Markdown lint inside `.stryker-tmp/.../node_modules/markdownlint/`.
Canonical Markdown passes formatting and the previous complete lint. The failing files belong to
an active generated mutation sandbox, not authored source. Finish mutation and remove this unit's
own sandbox before final lint; do not change the lint gate or classify an untested baseline as clean.

## Coarse alias proposal versus verified capability

An approved Deep floor with retained `model: opus` fails `compat/migrate.mjs:58` because
`compat/index.mjs:260` compares the canonical class with the coarse alias proposal for equality.
Candidate one is a real capability conflict. The accepted release catalog and public resolver
can establish that the exact retained selector satisfies Deep; its native value need not change.
Candidate two is treating MI_PROPOSAL_DEFAULTED as an upper capability bound. The compat layer
itself documents that this mapping is a report-only inference, not the authored per-artifact intent.
Keep the conservative conflict without evidence. Allow it only when the shared resolver proves
that exact retained native configuration satisfies the canonical declaration and all floors.
This proves structural compatibility, not live account availability or empirical model ranking.

The first compatibility integration attempts to import the resolver consumer into the compat leaf.
The existing module-boundary regression rejects that dependency. Keep the leaf's domain/requirement
imports unchanged: the caller computes an explicit boolean proof and supplies verified paths to the
pure report. The evidence consumer and offline loader stay separate. No resolver code is duplicated.

Two original negative fixtures assume `haiku` can never satisfy Frontier. Current accepted capability
facts and the shared class rules invalidate that assumption; it is not a genuine pin disagreement.
Replace those fixtures with an explicit canonical `sonnet` pin against retained `haiku`. The same
negative assertions and criterion names remain: incompatible native controls must report conflict.
Add positive exact-selector compatibility and negative missing/weak/floor/pin/source-identity cases.
This changes neither an acceptance assertion nor a threshold. It replaces a stale capability assumption
with a conflict that remains real even when provider capabilities improve.

A completed-write report initially keeps `pending` states despite `compliant: true`. The write result
now records the original batch under `planned`, clears completed pending paths, and marks each
completed artifact canonical. A regression fails before the correction.

Runtime/schema selector tests also catch accepted glob-looking paths despite the documented exact
selector contract. Reject wildcard metacharacters in both validators; never interpret them as patterns.

Canonical-pin boundary tests expose two further validation gaps before publication. First, equal
workload classes can hide different exact native selectors in the original class-only comparison.
Compare known explicit native model/agent-effort pins before accepting any caller capability proof;
proof cannot discard contradictory exact controls. Second, a check without a decision file skips
comparison of an existing canonical declaration. Validate that declaration before the no-new-decision
branch. Both regressions fail before correction, and matching native pins remain valid.

The mutation measurement is stopped before each new provenance/pin correction rather than reported
as final evidence for changed code. The completed earlier expanded measurement remains 87.52%
(1,265 killed, 18 timed out, 170 survived, 13 uncovered over 1,466 mutants). Its killed-only score
also exceeds 85%. Final expanded measurement includes the separate compatibility consumer and leaf.

The final ordinary suite passes 5,580 tests with 18 explicit skips. Its shell suite finds a stale
presentation assertion in `tests/bats/models-migrate-dryrun.bats:49`: the fixture now tests different
native pins, while the expected prose still describes a class-only disagreement. Candidate one is
lost conflict reporting; `compat/index.mjs:267` still returns the conflict and both semantic labels.
Candidate two is stale expected text after the fixture correction; the CLI prints the native-pin
diagnostic. Keep the rejection and verify both labels in the public JSON report, plus the actual
native-pin explanation in human output. No product behavior or acceptance threshold changes.

The first final PR quality attempt exits 2 with failed test and missing coverage evidence, not a pass.
It runs alongside the expanded mutation measurement. Its compile/test/coverage legs report routing
p95 28–36 ms against 25 ms, resolver p95 14.34 ms against 10 ms, and one native subprocess timeout.
Candidate one is a scoped-floor implementation regression; the same source passes all 5,580 ordinary
tests immediately before this concurrent load. Candidate two is CPU contention from overlapping
full-suite coverage and mutation workers. Do not infer a baseline defect or relax deadlines. Run
unchanged quality checks serially after the mutation workers finish, retaining this failure record.

The final eight-module mutation measurement completes with the unchanged 85% gate: 86.96%,
1,601 killed, 86 timed out, 221 survived and 32 uncovered over 1,940 mutants. It executes 391 semantic
tests; three timing benchmarks are excluded only from mutation and execute in the ordinary suite.
The killed-only score is 82.53%; do not describe that stricter calculation as passing 85%. Standard
Stryker includes timeouts in its score. This measurement is not evidence that every mutant dies
through a semantic assertion. The JSON report and earlier unsuccessful measurements are retained.

The first shell-serial retry still overlaps tools internally: `quality/runner.mjs:146` defaults to
two jobs, and `quality/index.mjs:125` passes that default. Its normal test leg passes, but the
coverage leg reports routing p95 37.68 ms against 25 ms, so coverage evidence is unavailable and
the quality result is exit 2. Candidate one remains a product latency regression; candidate two is
internal test/coverage overlap. Use the existing `--jobs 1` option to execute identical checks
sequentially. Do not alter test filters, thresholds, deadlines, profiles or measured source.

One tool job alone still fails routing p95 (26.27 ms against 25 ms). Vitest independently starts
parallel test files from the host's 16 available CPUs. The installed runner explicitly reads
VITEST_MAX_WORKERS at `node_modules/vitest/dist/chunks/index.B89dZ0-N.js:14514`. Run the unchanged
quality profiles with one tool job and one Vitest file worker through the existing per-run
--pass-env mechanism. Every test, integration race, coverage threshold and timing assertion remains
active. This resource configuration changes no repository policy or native runtime configuration.

The single-file-worker verification passes with no environment error: all 21 PR executions and
all 20 fast executions exit 0 (WARN is advisory). The ordinary suite and its coverage run each
pass 5,595 tests with 18 explicit external-integration skips. Routing p95 is 2.63 ms normally and
3.79 ms with coverage, against the unchanged 25 ms assertion. Changed-line coverage is 97.41%;
changed-branch coverage is 94.16%. Seventeen active original criteria pass after integration with
P-20, and all ten migration/recommendation/example shell cases pass. The shell fixture executes
the actual index, skills, build and project-sync checks against a real isolated migrated repository.
The final merge preserves all eight mutation-measured product modules byte-for-byte.

## Four-role review corrections

The full architecture, security, compliance and documentation fleet reviews commit
cbb28d69f4cc83db9d6245b6d1e7d926d02e4820 once. Four findings identify two independent defects.
Three roles reproduce the same accumulated-floor limit mismatch; documentation returns no finding.
The built-in review-triage decisions require full validation for every finding.

For the combined-list failure, candidate one is malformed project policy. The per-layer validator
accepts 128 exact declarations, which disproves that explanation. Candidate two is a boundary
mismatch: `policy/index.mjs` accumulates four valid layers while `resolver/compose.mjs:22` applies
one layer's 128 limit again. A failing regression proves 512 valid combined declarations cannot
resolve. Preserve the 128 per-layer limit and allow the resolver's combined four-layer bound.

For release confidence, candidate one is an invalid capability snapshot. The same valid snapshot
passes the structural validator and rejects an authored floor. Candidate two is incomplete mandatory
constraint detection at `materialize/runtime/claude.mjs:31`: its low-confidence gate overlooks
policy and scoped minima on dynamic declarations. A failing regression reproduces the successful
unsafe projection. Include all effective policy/scoped floors in this existing release rejection.
The autonomous contract authorizes these corrections. No thresholds, runtime permissions, owner
intent or preserved native controls change.

The eight-module post-review rerun is stopped without a passing verdict. Five measured modules
remain byte-identical to the completed 86.96% report, verified by SHA-256. Only
`materialize/runtime/claude.mjs`, `resolver/compose.mjs` and `policy/scopes.mjs` change in the review
correction. Measure those three complete modules with the same 393 semantic tests and unchanged
85% gate. Preserve the earlier full report and the stopped-run log; do not combine them into a
fabricated single-run report or count an interrupted measurement as a pass.
