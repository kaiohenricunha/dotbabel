# QA Practice Report

> Merged from the QA discussion of 2026-09-10. Indexed as DOC-1.

## What QA is

Quality Assurance (QA) is the practice that verifies that software meets its requirements and quality standards before it reaches users. It uses testing, reviews, and process controls.

## When QA happens

QA is not one phase that starts when the code is done. It is a process that runs across the full lifecycle. The old model had one dedicated QA gate after implementation. The modern "shift left" view spreads QA across every stage.

| Stage                   | QA activity                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Requirements and design | Acceptance criteria, edge cases, and the meaning of "done". A bad spec found here is the cheapest possible fix.            |
| Implementation          | Unit tests, table-driven tests, and linters that run locally.                                                              |
| Pull request            | Code review, static analysis, coverage checks, and the CI suite with unit and integration tests. Usually the hardest gate. |
| Post-merge, pre-release | Contract tests, end-to-end tests against a staging environment, load tests, and security scans.                            |
| Release                 | A canary or blue-green rollout with smoke tests against production.                                                        |
| Production              | SLOs, alerting, and error budgets. Observability is a QA activity even when nobody calls it that.                          |

In teams with a dedicated QA person, that person usually writes the end-to-end and exploratory suites and joins at the requirements stage, not at the end. In teams without one, the engineers do the same work, which is why the PR gate carries so much weight.

The cost curve is the main argument to push QA earlier. A bug found in a spec review costs minutes. The same bug found in production costs an incident.

## Where QA fits in the dotbabel pipeline

The pipeline: an idea becomes a plan or a spec, the spec splits into smaller work units, each work unit becomes a PR, and the PR goes through `pr-conductor` with a security review, a code quality review, and a PR intent versus reality review. QA maps onto three places. The first is the one most often missing.

1. **Spec stage: acceptance criteria as the test oracle.** Each work unit states observable, verifiable behavior: given X, the system does Y. These criteria make everything downstream checkable. Without them, the intent versus reality review can only compare the intent as written against the code as written, and both are static artifacts. With them, the same review can compare the intent against the executed behavior, which is a much stronger claim.
2. **PR stage: a distinct kind of check.** The security, code quality, and intent versus reality reviews all read the code. None of them runs anything. QA asks whether the code behaves correctly when it executes, and that needs test output, not a reading of the diff. A verification review asks three questions per acceptance criterion. Does a test exist? Does it pass? Does it assert behavior rather than mirror the implementation? The last question matters most for agent-written code. When the same agent writes the implementation and the tests, the tests tend to encode what the implementation does, bugs included. Tests derived from the spec, not from the code, are the guard.
3. **After merge: integration and production.** End-to-end tests against a real environment, smoke tests after each deploy, then SLOs and alerting. Static review cannot reach this area at all.

## The shape of the gate

dotbabel's premise is that agents cite their work. A QA gate should refuse to pass on assertion alone. It does not accept "the code handles the empty-list case". It requires the test name, the run output, and the criterion that the test maps back to. This is the discipline of `fix-with-evidence`, applied to behavior instead of diagnosis.
