# Resolver review audit

The owner authorizes autonomous fixes and merges until 2026-10-18 15:23:34 UTC. The full review of PR #499 posts three findings at 2eab1ce. The review worktree also preserves newly landed main commit bf83e20 through a normal merge; no history is rewritten.

## Repository-controlled class semantics

Candidate A is a weakened floor during precedence composition. The effective floor remains frontier, and `policy/index.mjs:427` deliberately delegates capability checks to the resolver. Floor comparison is not the observed failure.

Candidate B is an unauthorized class-table override. `policy/index.mjs:410` accepts classes from every layer, although the comment at line 408 relies on a schema that the loader does not apply. `cli/resolve.mjs:64` reads project JSON and merges it directly. An empty frontier rule then makes any candidate satisfy that class. Choose B: enforce shipped-only class ownership in the shared merge boundary, preserving legitimate floors, preferences and pins. Verify both pure policy and real configuration-file ingestion.

## Missing observed violation

Candidate A is absent, stale or reconstructed observation. The reproduction supplies an as-run observation and fresh capability facts, so these uncertainty guards do not explain it.

Candidate B is the early empty-candidate return at `resolver/index.mjs:40`. Observation assessment runs only after selecting a replacement. Choose B: preserve resolution failure while assessing observed compliance independently on unresolved paths. A known below-floor observation remains unsatisfied even when no replacement exists. Unknown observations remain unknown, and a rejected conflicting pin never becomes compliant.

## Documentation

The invocation amendment lists supported constraints, but the ResolverInput interface omits the optional invocation field. Add its exact types. This correction changes no runtime behavior.

Regression tests must fail before the fixes. Final scoped tests, mutation, quality, acceptance and exact-head CI remain required before merge.

## Verification

All three review findings are corrected. The new policy, real file-ingestion and observed-floor tests each fail before their fixes. The corrected Model Intelligence suite passes 494 tests; all 15 models Bats checks pass. Expanded policy/resolver mutation passes at 87.55%: 1,209 killed, 167 surviving, five uncovered, zero timeouts across 1,381 mutants. A rejected brace-pattern invocation mutates no file and runs no tests; it is not evidence. The corrected explicit comma-separated patterns find six source modules and execute 139 selected tests during the initial run.

The PR quality profile exits 0 with a warning verdict and no environment error; every configured execution exits 0. Test and coverage legs each pass 5,033 tests and skip 14. Changed-line coverage is 100%; changed-branch coverage is 97.10%. The skips are not native routing evidence. Fresh acceptance, head-pinned CI and addressed review threads remain required before merge.
