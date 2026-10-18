# P20 recommendation boundary

The pure recommendation module consumes the existing resolver result, optional normalized
observation, a separately established class assessment, and the native runtime recipe. It imports
no source/catalog module and performs no I/O. It neither chooses another model nor runs a recipe.
As-run comparisons distinguish keep, change, escalation and de-escalation; reconstructed, stale
or unknown observations cannot claim the user's current configuration.

The CLI reuses resolveRequest and loads the same catalog once. Optional explicit observation
input uses the existing makeObservedConfiguration validator. Exact pinned queries to the public
resolver establish the observed and recommended configuration classes. This reuses the existing
capability rules, keeps all policy floors, and adds no per-provider ranking table. A configuration
missing sufficient evidence has no class assessment. The observation file is a supplied record;
no live observation is collected and no task is replayed.

The initial module-import regression fails before implementation. Observation and stale-comparison
regressions then fail before adding the bounded observation input and freshness boundary.
The first CLI import uses an incorrect evidence builder name and fails existing resolve tests;
reading the actual exported makeObservedConfiguration and fixing the import restores them.
Thirty focused tests pass after that correction. The original resolve envelope stays unchanged
unless an internal caller explicitly asks for already-loaded resolver inputs.

The complete diff review catches a cross-verb usage regression introduced by a broad flag-list
replacement: snapshot --check reads a comma expression instead of its evidence-file key. Candidate
one is the argument parser; other snapshot flags parse correctly. Candidate two is the changed
guard expression visible in the diff. A new public CLI regression fails before restoring the exact
key; invalid check/evidence-file combinations again return 64 before any I/O.

The first executed pure-module mutation run scores 62.03%. Additional observation, axis equality,
resolution status, class comparison, native recipe and copy-isolation boundaries raise the same
158-mutant scope to 90.51%, with no timeouts or uncovered mutants. The 85% gate stays unchanged.
The initial external mutation sandbox lacks a parent node_modules lookup for subprocess tests;
linking the same installed dependencies at its owning parent repairs the environment without
excluding tests or changing the runner. A later test initially attempts to mutate the frozen public
resolver result; clone that test input before constructing malformed configurations.
