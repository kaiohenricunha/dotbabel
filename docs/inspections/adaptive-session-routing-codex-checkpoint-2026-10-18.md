# Codex native boundary checkpoint — 2026-10-18

## Full assignment

The original Model Intelligence and Adaptive Session Routing attachment remains active. The autonomous merge grant starts 2026-10-18 03:23:34 UTC and expires 15:23:34 UTC. Activation #496, resolver #499 and classifier #501 are merged. Core #502 merges as 6e53b38 after its review fix, current criteria and exact-head CI39099359823 pass on Node 20 and Node 22. Its own worktree is removed after moving the unchanged full task and actual installed dependencies here. Original P-12 through P-23, applicable P-8b and the final full-spec audit remain open.

## Implemented boundary

The Codex unit contains caller-owned per-thread exactly-once submission, bounded non-evicting deduplication, no replay after uncertain writes, independent manual controls, state-race detection, native completion boundaries, original input and permission preservation, shared-resolver modality requirements and a bounded subprocess transport. It never treats acknowledgement as effective execution. Native server approval requests go to the caller; missing/failing handlers never approve. The caller remains responsible for UI, native account, observations and runtime capability verification.

The 82 unit/protocol tests pass. A new attachment regression proves an unknown modality must stop before capability loading; the wrapper now validates inside the already project-gated lazy loader before invoking discovery. The separate audit records both candidate causes and the reproduced failure. Mutation improves from a failed 63.84% run to 88.52%: 493 killed, eight timeouts, 59 surviving, six uncovered and one invalid runtime mutant. Removing timeout credit still yields 87.10%, above 85. No threshold or scope exclusion changes. Final PR quality and active criteria follow the new integration test and metadata.

## Native proof and acceptance

The real isolated portable experiment repeats two ordinary prompts through the final runtime source after the core merge and modality fix. Both complete on one thread; selected model/effort match native thread/read after completion, each original user message appears once, inputs remain unchanged and no reroute or transport diagnostic occurs. Effective state remains unknown at acknowledgement. The proof includes source hashes and controlled prompt hashes, no credentials or account catalog. Initial non-Git fixture Stop-hook failures are documented and excluded; no hook is changed or bypassed.

AC-5 and AC-12 are now active. AC-12 runs a real authenticated native integration test only with DOTBABEL_MODELS_TIER3=1. Without explicit opt-in it skips and cannot pass criterion verification. Full review, head-pinned live criteria, exact-head CI and merge remain necessary. The managed terminal client, setup/status/dry-run CLI, runtime descriptor activation and Claude mods remain separate units. Stock Codex CLI transparent interception is still unverified; no unsupported claim is made.

## Final local delivery proof

The public portable real-turn experiment passes after integrating core 8f4afe5 and the modality correction. Final quality exits 0 with warnings, no environment error and every configured execution passing: 5,213 tests pass, 15 skip, changed lines 100%, changed branches 96.04%. Eleven active adaptive criteria pass, including an actually executed AC-12 native test; six original criteria pass. The first criterion attempt correctly reports AC-12 unconfirmed because the runner strips the opt-in environment variable. Repeating with the sanctioned --pass-env DOTBABEL_MODELS_TIER3 explicitly forwards permission and runs the native test, which passes. No filter, criterion or policy is weakened. The fast profile also exits 0. All remaining original and Claude work remains open.
