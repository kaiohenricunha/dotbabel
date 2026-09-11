# §1 — Problem / Motivation

> Why does this exist? What's broken? Why now?

**Settled.** Seeded from the 2026-09-10 QA assessment ([DOC-1](../research/qa-practice-report.md), [DOC-2](../current-state/analysis.md)) and kept consistent with the scope decisions in §2.

## The Question

"Did this change deliver the behavior the spec promised, and where is the executed proof?"

## Why

dotbabel's delivery pipeline turns an idea into a plan or a spec, splits the spec into work units, implements each unit as a pull request, and runs the pull request through `pr-conductor`. The reviews on that path read the code. None of them compares the spec's intent against executed behavior (DOC-1).

The 2026-09-10 assessment scored dotbabel's QA support at **6/10** (DOC-2). Six problems account for the gap:

1. **The spec stage has no test oracle.** `spec.json` requires `acceptance_commands`, and the validator checks only the shape of that field. No acceptance-criteria field exists. Behavioral criteria live in prose, and nothing maps a criterion to a test. The intent versus reality review can only compare two static artifacts.
2. **The PR gate executes tests but is blind to criteria.** `pre-pr`, `review-pr` step 11, and `local-attest` run real tests, and the merge gate stays red on an unrun test plan. The test plan is author-written, though. No gate checks that each criterion has a test, that the test passes, or that the test asserts behavior.
3. **Agent-written tests can mirror agent-written code.** When one agent writes the implementation and its tests, the tests encode what the implementation does, bugs included. `quality-review` rejects such tests in prose only, and the `mutation.changed_score` rule has no built-in runner.
4. **Post-merge verification is near absent.** `release-conductor verify` checks the release workflow, the npm registry, and the GitHub release. `deploy-status` compares deployed SHAs with `origin/main`. Nothing runs a health check or a synthetic transaction against the deployed system, and SLOs appear in one checklist line.
5. **Declared QA configuration is dead or prose-only.** No code reads `verification_commands`. Only `merge-pr` prose consumes `regression_paths`. The Python adapter has no built-in test plan.
6. **Consumers inherit less QA than this repository uses.** `dotbabel init` ships the executing skills, and `dotbabel quality` runs in any repository. Consumers get no CI test workflow, no scheduled deep audit, and no test-running hook.

## What

A QA verification harness that gives each lifecycle stage an executed-behavior gate. Each gate refuses to pass on assertion alone and cites the test name, the run output, and the acceptance criterion that the test maps back to.

- **Spec stage:** acceptance criteria in `spec.json` become the test oracle for every work unit.
- **PR stage:** a verification step maps each criterion to an executed test, judges test quality, and holds the merge gate on a missing or failing mapping.
- **Post-merge:** a post-deploy smoke test reaches the running system. SLO checks move to a follow-up spec, as recorded in §2.
- **Supporting work:** regression checks triggered by paths in the quality configuration, a Python test adapter, consumer CI templates, and a pre-push hook.

## Why Now

dotbabel's premise is that agents cite their work: `ground-first` for analysis, `fix-with-evidence` for bug fixes, and SHA-pinned attestations for CI. Behavior is the remaining area where a claim of correctness can pass without executed evidence. The 2026-09-10 assessment made the gap concrete and ranked the fixes by leverage (DOC-2).

<!-- Add any deadline, incident, or consumer request that raises urgency. -->
