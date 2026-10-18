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
