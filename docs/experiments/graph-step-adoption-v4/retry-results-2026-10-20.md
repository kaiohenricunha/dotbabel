# Retry step: results under protocol v4 — 2026-10-20

**Decision: INCONCLUSIVE (sample floor).** The sealed retry dataset has 9 agreed `ask-owner`
cases, and the v1 floor is 20 for each action. v4 refuses to make a request plan for an
underpowered sample, so no retry request went to Jev. The retry step keeps the built-in rule.
`ADOPTION.retry` in `plugins/dotbabel/src/decider.mjs` records INCONCLUSIVE and links this report.

## Run

| Item             | Value                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| Protocol         | `graph-step-adoption-v4` at `f88b479` (#529, #530)                          |
| Protocol hash    | `f69617c51fb8c31d073750ee9ebc3c1f8ee5efe33ca69b08bf7f8d6120f2f5b1`          |
| Lock SHA-256     | `d41bdbeec5f739aed2c420c013ce9047774ae2b564470f292317c4df181e50ee`          |
| Dataset          | `2026-10-20-retry-verified-v4-01` (private, outside Git)                    |
| Manifest SHA-256 | `3d98d3a775c8290cbbefd061446e4b4dfc5f32b8761e9e001718fd2ee01fa825`          |
| Labels           | `ai-annotation-verified`; owner-approved as adoption evidence on 2026-10-19 |
| Jev requests     | 0: `dry-run` exits 2 with `sample floor is not met`                         |

The dataset session sealed the dataset at 2026-10-20T03:42:21Z. The review packets were frozen at
02:37:32Z, and every annotation and verification is between those two times.

## Sample

| Item              | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Collected         | 328 cases                                                 |
| Agreed (admitted) | 177 cases, 177 pull requests, 97 repositories             |
| Classes           | retry 50, fix 118, ask-owner 9                            |
| Unknown           | 151: 132 insufficient evidence, 19 reviewer disagreements |
| Cap-determined    | 0                                                         |
| Floors            | rows, PRs, retry, and fix pass; **ask-owner gap 11**      |

| Stratum          | Cases | retry | fix | ask-owner |
| ---------------- | ----- | ----- | --- | --------- |
| enriched         | 96    | 45    | 47  | 4         |
| control          | 28    | 2     | 21  | 5         |
| unselected-prior | 53    | 3     | 50  | 0         |

The cohorts are `ci-supplement-02` (100), `recent-public-ci-20261019` (53), and
`ci-supplement-20261019` (24).

## Limits

1. Every admitted case has `attempt` 1. The dataset cannot test the attempt cap or any answer for
   a later attempt.
2. Both reviewers marked the tail as sufficient on 133 of 177 cases (47 retry, 80 fix, 6
   ask-owner).
3. `tail_rule` is `last-error` on 176 cases and `log-end` on 1.
4. The annotator and the verifier are separate blind runs of `claude-opus-5-5`. Their agreement is
   not statistical independence.
5. Reported by the dataset session, not checked here: two annotators wrote decision files to a shared scratch area. The dataset session quarantined the
   files before any verifier read them and audited all 24 verifier transcripts. The audit and
   decision-log hashes are in the manifest `provenance`.
6. The enriched and control strata cannot estimate prevalence.

## Where the ask-owner cases come from

5 of the 9 agreed `ask-owner` cases come from the 28-case control stratum, and 4 from the 96
keyword-picked cases. They are pull-request label or merge gates, a 402 `insufficient_balance`
response, and a cloud-proxy credential. A keyword screen for missing secrets did not find this
class. A new collection that targets pull-request gate workflows and billing or quota responses
could close the gap. That collection needs a decision from the owner; it was not started.

## Reproduce

`decider.mjs` is one of the bound implementation files, and this report's pull request changes it.
So `check` on this lock passes only at `f88b479`. Check out that commit, then run:

```bash
DATA_ROOT=$(git rev-parse --path-format=absolute --git-common-dir)/dotbabel/graph-3e-datasets
RUN_ROOT="$DATA_ROOT/2026-10-20-ai-adoption-v4-retry-02"
node docs/experiments/graph-step-adoption-v4/run.mjs check --lock "$RUN_ROOT/study-lock.json"
node docs/experiments/graph-step-adoption-v4/run.mjs evaluate --lock "$RUN_ROOT/study-lock.json"
```
