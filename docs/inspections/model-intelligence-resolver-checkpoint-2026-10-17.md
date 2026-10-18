# Model Intelligence resolver checkpoint

## Scope and authorization

The full owner attachment remains authoritative. The previous push/merge grant expires 2026-10-18 00:31:31 UTC. The direct goal continuation permits local implementation but does not renew that grant. No new push or merge occurs without authorization. PR #496 is open at ae7e471d59dadb2e0e584c621275a20c583ab7ca. Run 39089363277 passes Node 20, Node 22 and criteria. Review replies/resolution, deferred test-plan disposition, fresh review-complete evidence and merge remain open.

## Local implementation

Worktree `.claude/worktrees/model-intelligence-resolver`, branch `feat/model-intelligence-resolver`, baseline f368fe6. The pure resolver composes floors and pins, preserves inheritance and uncertainty, and separates selection from enforcement. It performs no I/O, environment or clock reads. Adapters preserve factual reasoning/tool capabilities; catalog normalization retains identity and capability evidence. Model names do not imply capability classes.

The read-only CLI resolves an artifact or explicit class from cached evidence. Canonical declaration errors never fall back to legacy values. JSON exposes the shared ResolverResult; human output does not print rejected opaque pin values. `--artifact-kind` selects the binding contract, with command as the default. AC-8 through AC-11 are activated because their exact tests pass. Other pending criteria stay pending.

## Evidence

TDD reproduces missing implementation, stale availability overriding a fresh denial, unsafe selected axes, and opaque pin disclosure. All are corrected. Combined resolver/CLI/boundary tests: 61 pass. Earlier adapter/catalog regression: 113 pass. All 15 models Bats checks pass. The initial valid mutation run scores 65.83%; meaningful boundary tests raise it to 85.44% (616 killed, 98 surviving, 7 uncovered, zero timeout), above the unchanged 85 threshold. Average: 8.52 tests per mutant. The architecture test excludes only Stryker-generated helper functions, retaining every application import and function.

An isolated real Codex 0.163.0 discovery and subsequent resolution both exit 0. The result selects native model/Medium reasoning, reports enforcement unknown and observation_unavailable, and executes no inference turn. This proves diagnostic resolution, not live routing or ranking accuracy. Final lint, acceptance and quality verification remain before review and landing.

## Remaining scope

Integrate the activation branch and latest main while preserving both CLI surfaces. Verify active acceptance commands, relevant regressions, lint, coverage and PR quality. Review and land through IMPL-12 after authorization returns. P-12 through P-23 and independent classifier/Claude mod/Codex App Server routing remain open, including real effective-state proof, manual axes, floors, exactly-once input, hysteresis, projections, snapshots, migrations, recommendations, remaining adapters and final requirement audit.

## Integrated verification — 2026-10-18

Resolver implementation commit: a3d8ae0. Local integration of activation and current main: 396ede5. Both CLI surfaces are retained; the only merge conflict belongs to these two units from this session. Combined feature/adapter/catalog tests pass 171 cases; all 15 models Bats cases pass. Direct read-boundary cases then directly verify the CLI orchestration, including malformed policies/frontmatter, missing/non-file/oversized artifacts, exact size, inheritance, legacy conflicts and absence of network calls.

The first final PR quality run fails changed-line coverage at 81.39%. Direct file-boundary tests raise it to 98.70%; changed-branch coverage is 95.54%. The next quality run exits 0 with warning verdict, environment_error=false, and all configured executions exit 0. Its test and coverage legs each report 4,991 passed and 14 skipped across 198 files. Final core mutation verification again scores 85.44%, with 616 killed, 98 surviving, 7 uncovered and no timeouts. All six active original-spec criteria (AC-8/9/10/11/26/27) pass. No other criterion is claimed complete.

The new default classifier starts independently in `.claude/worktrees/adaptive-session-routing-classifier`, branch `feat/adaptive-session-routing-classifier`, based on 396ede5. Its missing-module baseline is recorded; nineteen contextual/uncertainty/bounded-input tests now pass. Ten authored fixtures compare lexical and contextual rules without model calls; this is not held-out accuracy or model-ranking evidence. Classifier mutation/quality, routing core, runtime adapters and full initiative acceptance remain open.
