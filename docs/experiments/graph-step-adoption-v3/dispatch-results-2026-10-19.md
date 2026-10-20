# Dispatch step: Jev results under protocol v3 — 2026-10-19

**Decision: REJECT.** Jev did not add one reviewer in 124 cases, so its recall is 0. The dispatch
step keeps the built-in rule. `ADOPTION.dispatch` in `plugins/dotbabel/src/decider.mjs` records
REJECT and links this report. Nothing changes in the skills.

## Run

| Item            | Value                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| Protocol        | `graph-step-adoption-v3` at `4b43060` (#527)                                  |
| Protocol hash   | `6ca5ea9f86c01dec310187e511657c5bef6a1de71ad51bf251de4971baba929d`            |
| Lock SHA-256    | `2f20915ecb39dbab4dbb68bb03fb37a40113759c9c0524d87986d074a579c2fe`            |
| Answers SHA-256 | `764f484d9d6a1800de057fa7588a08311c5097ec1337d796f09dbbbf95d68f72`            |
| Dataset         | `2026-10-18-public-dispatch-verified-01` (private, outside Git)               |
| Model           | `jev-1.13.0` at `https://api.typesafe.ai/v1/systemone`                        |
| Labels          | `ai-annotation-verified`; owner-approved as adoption evidence on 2026-10-19   |
| Consent         | the owner gave fresh send consent for `kaiohenricunha/dotbabel` on 2026-10-19 |

The lock was made on the merged `main`, before any Jev request. The send posted 124 requests, and
all 124 have a usable answer. No request failed.

## Sample

| Item                    | Value                                              |
| ----------------------- | -------------------------------------------------- |
| Collected               | 157 cases                                          |
| Agreed labels (locked)  | 124 cases, 99 pull requests                        |
| Classes                 | 47 cases need an additional reviewer; 77 need none |
| Unknown (disagreements) | 33, kept out of the sample                         |
| Cohorts                 | 81 final-head baseline; 43 historical review-head  |

All sample floors pass: at least 100 cases, 30 pull requests, and 20 cases in each class.

## Results

| Gate         | Rule (v1, unchanged)  | Point | 95% interval (2,000 PR draws) | Pass |
| ------------ | --------------------- | ----- | ----------------------------- | ---- |
| Precision    | at least 0.8          | 1     | [1, 1]                        | yes  |
| Recall       | at least 0.9          | 0     | [0, 0]                        | no   |
| Recall gain  | at least 0.1          | 0     | [0, 0]                        | no   |
| Availability | at most 5% unanswered | 0%    | —                             | yes  |

Precision is 1 only because no prediction names a reviewer: with no positive prediction, the v1
formula gives precision 1. Every locked profile already includes `security-auditor`, so the
built-in rule adds no reviewer either, and the predictions are empty in all 124 cases.

## Why Jev adds no reviewer

The adapter adds a candidate only when Jev's `noul` for it is at least 0.9, and the protocol uses
the built-in answer when the answer's confidence is below 0.9 (`RULES.confidence`). In this run:

- 0 of 124 answers name a candidate.
- The answer confidence is between 0.50 and 0.77, with a median of 0.65. No answer reaches 0.9.

Jev's probabilities for `This diff needs <reviewer>.` stay near the middle. The input has only the
file names, the changed-line count, and the reviewer names (`jevRequest` in
`plugins/dotbabel/src/jev-adapter.mjs`). That input is possibly too thin for a confident answer. A
later study can test a richer input, but it needs a new protocol version and a new lock. This
result does not tune a threshold after the fact.

## Limits

The labels are checked AI annotations, not human labels. Distinct annotator and verifier actors do
not make them statistically independent. This REJECT does not depend on that limit: Jev's answers
add no reviewer, so no label set can give the recall that the rule needs.

## Reproduce

`decider.mjs` is one of the bound implementation files, and this report's pull request changes it.
So `check` on this lock passes only at `4b43060`. Check out that commit, then run:

```bash
DATA_ROOT=$(git rev-parse --path-format=absolute --git-common-dir)/dotbabel/graph-3e-datasets
RUN_ROOT="$DATA_ROOT/2026-10-19-ai-adoption-v3-dispatch-02"
node docs/experiments/graph-step-adoption-v3/run.mjs evaluate --lock "$RUN_ROOT/study-lock.json" --answers "$RUN_ROOT/answers.jsonl"
```
