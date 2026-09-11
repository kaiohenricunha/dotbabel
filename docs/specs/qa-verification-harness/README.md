# qa-verification-harness — Engineering Spec

> Give every lifecycle stage an executed-behavior gate: acceptance criteria as the test oracle at the spec stage, a PR gate that maps each criterion to a run test with cited evidence, and a post-deploy smoke test that reaches the deployed system. Together with a follow-up SLO spec, the target is to move dotbabel's QA assessment from 6/10 to 10/10.
>
> Created: 2026-09-10. Sections completed: 2026-09-11.

## Status

| #   | Section                     | Status   |
| --- | --------------------------- | -------- |
| 1   | Problem / Motivation        | [x] done |
| 2   | Scope                       | [x] done |
| 3   | High-Level Architecture     | [x] done |
| 4   | Data Flow / Components      | [x] done |
| 5   | Interfaces and APIs         | [x] done |
| 6   | Implementation Plan         | [x] done |
| 7   | Non-Functional Requirements | [x] done |
| 8   | Risks and Alternatives      | [x] done |

The metadata status in `spec.json` stays `draft` until the owner approves the spec. This is a brownfield spec. [current-state/analysis.md](current-state/analysis.md) holds the grounded audit of the QA surface that dotbabel ships today.

## Quick Start

1. **Why:** [`spec/1-problem-motivation.md`](spec/1-problem-motivation.md) explains the 6/10 assessment and its six gaps.
2. **What is in and out:** [`spec/2-scope.md`](spec/2-scope.md) lists the nine items and the five settled decisions.
3. **How it fits together:** [`spec/3-high-level-architecture.md`](spec/3-high-level-architecture.md) and [`spec/4-data-flow-components.md`](spec/4-data-flow-components.md) cover the layers, six flows, and key decisions KD-1 through KD-16.
4. **Exact contracts:** [`spec/5-interfaces-apis.md`](spec/5-interfaces-apis.md) defines the criterion schema, the `dotbabel criteria` command, the evidence comment, and the new reason codes.
5. **How to build it:** [`spec/6-implementation-plan.md`](spec/6-implementation-plan.md) holds seventeen prompts in six phases, each with its failing tests listed first.
6. **Limits and risks:** [`spec/7-non-functional-requirements.md`](spec/7-non-functional-requirements.md) and [`spec/8-risks-alternatives.md`](spec/8-risks-alternatives.md).
7. **Self-test:** `spec.json` declares sixteen acceptance criteria that this spec's own implementation must pass.

## What to Expect

This summary is for project owners and managers.

**The outcome.** A change that claims to meet a requirement must also show proof that the requirement was tested. After a release, the live system is checked before anyone calls the release done.

**What changes for teams:**

1. **Requirements become testable promises.** Each spec states its acceptance criteria in plain "given, when, then" language, and each criterion names the tests that prove it. New specs get criteria by default, and existing specs keep working unchanged.
2. **"Done" needs proof.** Before a pull request can merge, the review step runs the tests behind each criterion and records the results for that exact version of the code. A new push makes the old proof invalid. Only proof from trusted maintainers counts.
3. **Test quality gets checked.** The AI reviewer flags tests that check nothing or only repeat the code. Where a team already uses mutation testing, a score shows whether the tests would catch real bugs. The AI can flag a problem, but it can never approve a change.
4. **Risky areas get stricter checks.** Teams mark critical folders, and any change there runs the full test suite. Data checks run when relevant files change, so nobody has to remember to run them.
5. **New projects are safer by default.** New projects get security-hardened CI workflows, an optional check before each push, and an optional test run at the end of each AI session.
6. **Releases are checked against the live system.** After a deploy, smoke checks confirm that the live system responds correctly. On a failure, the team gets a rollback recommendation, and nothing rolls back without a person.

**What it does not do.** It does not monitor service levels or error budgets, which a follow-up spec covers. It installs no testing tools. It cannot decide which criteria are worth writing. It never merges or rolls back on its own.

**How to know it worked:**

- Every merged pull request whose spec has criteria carries proof for its final commit.
- Upgrading breaks 0 of the 38 existing specs in the local survey.
- The AI test review reaches at least 80% precision and 70% recall on a 40-case benchmark before launch.
- New code keeps at least 85% coverage and at least an 85 mutation score.
- A post-deploy smoke verdict arrives within 5 minutes.
- The pre-push check finishes within 2 minutes or steps aside.

**Delivery.** The work is 17 units in 6 phases. Each phase can ship on its own as a minor release. The first phases deliver the highest value, requirements and pull request proof, and post-deploy checks come last. Every unit has a documented way to switch it off.

**Risks to watch:**

- Tests that silently run nothing. A guard exists.
- Flaky tests that block merges. Nothing retries automatically, and flaky tests go to quarantine.
- Weak criteria. The spec guidance and mutation scores push back.
- Low adoption, because criteria are optional. The spec skill adds criteria by default.

**Decisions for the owner:**

- Approve the spec to start phase 1.
- Confirm the evidence storage choice, which was adopted under delegation (KD-2).
- Schedule the SLO follow-up spec.

## Research Sources

See [research/sources.md](research/sources.md) for indexed source documents.
