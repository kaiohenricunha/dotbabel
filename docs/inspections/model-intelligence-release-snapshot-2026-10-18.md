# Release snapshot implementation inspection — 2026-10-18

## Native dry-run clock diagnosis

The first real public snapshot --check succeeds, but the following native-backed dry run returns release_evidence_time_invalid. Candidate one is an invalid or future native timestamp: against it, the existing Claude adapter records each real observation with its own current ISO clock, and the isolated selector probes all succeed with turnExecuted false (sources/runtime/claude.mjs:217 and sources/runtime/process.mjs:318). Candidate two is a check clock captured before source collection: confirmed at snapshot/index.mjs:27, where the default now argument is evaluated before awaiting collect, and snapshot/core.mjs:88, where a negative age is rejected. Every newly collected observation occurs after that early default clock. A regression advances the clock during collection and reproduces the failure. The correction obtains the default check time after collection; an explicitly supplied operational clock remains unchanged. It does not add a tolerance, weaken the future-time check or change snapshot identity.

## Source scope

The release evidence records selector compatibility and accepted capability support for deterministic release generation. It does not establish a current account's entitlement, available quota or effective MAIN configuration. The shared live routing boundary rejects release-scoped catalogs. Native selector collection reuses the credential-free isolated Claude adapter; the provider recording and accepted documentation keep their original dates. A failed required source or changed runtime version/mapping preserves the committed snapshot.
