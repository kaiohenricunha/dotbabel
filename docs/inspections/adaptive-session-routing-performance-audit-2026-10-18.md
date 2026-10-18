# Routing performance audit — 2026-10-18

Candidate A: concurrent full-suite load inflates wall time. The unchanged 500-model benchmark passes alone and under mutation, but the PR profile records p95 72.02 ms and coverage records 34.95 ms against the unchanged 25 ms requirement. This explains variability, but reducing or bypassing the required measurement is not acceptable.

Candidate B: redundant evidence evaluation. `resolver/index.mjs:23` constructs every candidate before filtering an explicit model pin; `route.mjs:58` performs a retention probe with that pin. `resolver/candidates.mjs:7` serializes each evidence value against itself even when only one authoritative record exists. These repeat work without adding evidence.

Choose B. Keep the normal full-catalog choice. Restrict candidate construction for an exact pin to that model and the separately observed model, preserving independent observed-floor assessment. Fast-path one usable evidence record without changing its availability requirement. Keep duplicate/conflict, confidence, stale evidence, manual precedence and all floors unchanged. The existing failing 1,000-call performance regression remains the acceptance check; no threshold, test exclusion or wall-clock substitution changes.

The final relevant-source mutation run passes at 86.47% across 850 mutants: 735 killed, 114 surviving, one uncovered and zero timeouts. Routing/prepare remain at 91.04%. All 584 combined Model Intelligence and routing tests pass before classifier review integration. Logs: `/tmp/ar-core-performance-green.log`, `/tmp/ar-core-performance-mutation.log`. The full quality profile must still verify the unchanged 25 ms limit after the optimization.
