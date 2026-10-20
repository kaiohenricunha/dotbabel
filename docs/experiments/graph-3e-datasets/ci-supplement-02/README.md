# Retry dataset tooling: public GitHub Actions failures (unit 3e)

This folder holds the code that built the private retry datasets
`2026-10-20-retry-verified-v4-01` and `2026-10-20-retry-verified-v4-02`. The data stays outside Git, under
`$(git rev-parse --path-format=absolute --git-common-dir)/dotbabel/graph-3e-datasets/`. Directories there are
0700 and files are 0600.

All labels are AI labels from two blind runs of the same model family. They are not human labels, and their
agreement is not statistical independence.

## Results

| Dataset | Rows | PRs | retry | fix | ask-owner | Unknown | Floors (100 / 30 / 20 each) |
| ------- | ---- | --- | ----- | --- | --------- | ------- | --------------------------- |
| v4-01   | 177  | 177 | 50    | 118 | 9         | 151     | ask-owner short by 11       |
| v4-02   | 245  | 245 | 53    | 173 | 19        | 183     | ask-owner short by 1        |

The retry step of unit 3e is recorded as INCONCLUSIVE (sample floor). Nothing was sent to Jev.

Every row has `attempt` 1, so neither dataset exercises the attempt cap. In v4-02, 13 of the 19 ask-owner rows
are pull-request label gates from five repositories. Report ask-owner with and without those rows.

## Pipeline

Set `COHORT_ROOT` to the private cohort directory, and `PILOT_RUBRIC` to the frozen rubric, before you run a step.

1. `node acquire.mjs discover`, then `node acquire.mjs collect`: read-only GitHub API collection of the contract
   in `collection-contract.json`. Transient refusals (rate limits, 5xx, stream errors) wait and retry. A refusal
   is not evidence about a CI failure.
2. `node acquire.mjs control <amendment> <output> [earlier outputs...]`: hash-ordered sample of traces that matched
   no keyword. Later draws continue the same order.
3. `python3 -I build-packets.py`, then `python3 -I verify-packets.py`: freeze and verify the review packets.
   `PACKET_ROUND=2` writes the round-2 files without touching round 1.
4. Blind review with `review-kit/`: one annotator and one verifier per batch, in separate workspaces. The verifier
   of batch k starts only after the annotator of batch k is accepted. `accept.sh <role> <NN>` checks a batch
   (`check-batch.mjs`, `review-check.mjs`) and logs it; `REVIEW_DIR` selects the review folder.
5. `node blind-audit.mjs <tasks_dir>`: flag any verifier tool call that touched annotator outputs or shared
   scratch files.
6. `node build-seal.mjs <out>` (one round) or `node build-seal-rounds.mjs <parent> <out>` (two rounds): only
   agreed actions become rows. Disagreements, double unknowns, capped counters and duplicate execution
   identities go to `unknown.jsonl`. `seal.mjs` checks every protocol-v4 rule before it writes.

## Lessons recorded during the run

- Subagents share one session scratch directory. Give each blind reviewer a private temporary folder inside its
  own workspace, or decision files can leak between reviewers.
- A job-log endpoint can be rate limited while `GET /rate_limit` still shows quota. Read `X-Ratelimit-Reset`
  from the refused response.
- Keyword screening must ignore test-runner progress lines and read only decision lines: the setup section, the
  300 lines before each `##[error]`, and the log tail.

## Tests

```bash
node --test docs/experiments/graph-3e-datasets/ci-supplement-02/*.test.mjs
```
