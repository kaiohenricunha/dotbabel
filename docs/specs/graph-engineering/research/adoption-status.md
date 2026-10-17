# Model adapter adoption — 2026-10-16

| Step          | Locked evidence                                                                                      | Disposition                       |
| ------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| review-triage | [Completed triage experiment](../../../experiments/2026-10-12-jev-finding-triage.md), run 2026-10-13 | REJECT; remain in shadow mode     |
| retry         | No locked experiment or labeled dataset exists                                                       | UNMEASURED; remain in shadow mode |
| dispatch      | No locked experiment or labeled dataset exists                                                       | UNMEASURED; remain in shadow mode |

The triage run measured kappa 0.069 against a 0.6 floor and auto-decided 6.5%
against a 20% floor. Its 2,000 PR-clustered bootstrap samples do not rescue
either failed gate. Reusing those results does not require another API call.

`ADOPTION` in `plugins/dotbabel/src/decider.mjs` records these states. The
adapter descriptor reports the model steps as `unverified`. No configuration
field can adopt a step. A repository can consent to shadow requests, but
skills always follow the built-in answer. Tests cover this boundary.

Unit 3e is conditional work, not permission to reinterpret REJECT as ADOPT.
Before any later promotion, each step needs its own locked experiment, a
representative labeled dataset, and a passing result. Retry and dispatch do
not inherit triage thresholds or evidence. A reviewed change must cite the
result and add the step's adopted thresholds. No live experiment runs in this
continuation, and the repository remains on its built-in default.
