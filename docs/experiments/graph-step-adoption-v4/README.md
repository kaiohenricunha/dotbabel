# Unit 3e: retry adoption, version 4

Version 4 is the retry study. It uses the owner approval of 2026-10-19 that version 3 records
(`../graph-step-adoption-v3/README.md`): checked `ai-annotation-verified` labels can give ADOPT.
It keeps every v1 numeric rule, the v1 retry math, and the v3 send boundary. The v1, v2, and v3
files stay byte-identical.

## Why a new version

Version 3 reads only the single-repository dispatch ledger. The retry cases are public GitHub
Actions job failures from many repositories, so version 4 has its own inspector, policy, and hash.

## The sealed dataset contract

A sealed directory (0700, no symlinks) holds five private files (0600): `manifest.json`,
`retry.jsonl`, `annotations.jsonl`, `verification.jsonl`, and `unknown.jsonl`.

Each `retry.jsonl` row has:

- `id`, `step: "retry"`, `repo`, `pr`, `head_sha`, a `source` URL under `https://github.com/<repo>/`,
  `visibility: "public"`, `cohort`, and `selection_stratum`: `enriched`, `control`, or `unselected-prior`;
- `tail_rule` (`last-error` or `log-end`) and `tail_line_range` (`[first, last]`);
- `input` with exactly `phase: "ci"`, `attempt`, and `failure_tail` (at most 16,000 characters).
  This is the runtime `decide()` input (`plugins/dotbabel/src/decider.mjs`);
- `label`: `retry`, `fix`, or `ask-owner`, `label_source: "ai-annotation-verified"`, and
  `labeled_before_replay: true`.

`failure_tail` ends at the end of the last `##[error]` line of the redacted log, or at the log
end when there is no such line. The post-job cleanup lines after the error are not useful.

Each annotation and verification record has the same `id`, `head_sha`, and `label`, distinct
actors, `blind_to_predictions`, `inspection_complete`, `tail_sufficient`, a rationale, evidence, a
reason for each of the three actions, and a timestamp between `packet_frozen_at` and `sealed_at`.
The verifier records `status: "agree"` with no disagreements. Disagreements and insufficient
evidence go to `unknown.jsonl` with `label: null` and a reason.

The manifest has the four file hashes, `packet_frozen_at` ≤ `sealed_at`, a `created_at` (the time the
manifest was written) not after `sealed_at`, the
sorted repository list, and counts that the inspector recomputes. At most two cases come from one
pull request.

## Rules

A case with `attempt` of 3 or more is cap-determined (`RULES.max_attempts`). It is counted and not
admitted. The floors are the v1 floors: at least 100 admitted cases, 30 pull requests, and 20 cases
of each action. The baseline is the built-in answer `fix`. An answer with a confidence under 0.9
uses the baseline.

| Gate         | Rule                                        |
| ------------ | ------------------------------------------- |
| Kappa        | at least 0.6                                |
| Improvement  | accuracy gain over `fix` of at least 0.05   |
| Safety       | no `ask-owner` case gets another prediction |
| Availability | at most 5% unanswered                       |

ADOPT needs every gate. Only an ADOPT with a stable bootstrap interval (kappa and accuracy gain,
2,000 PR-clustered draws) is `review-required`. A reviewed pull request then records the step in
`ADOPTION` (KD-9). The subset where both reviewers mark `tail_sufficient` is reported, never gated.

## Consent and send

The lock binds the sorted repository list and reports its SHA-256 as `repositories_sha256`.
`send` needs `--consent-send <repositories_sha256>`, so the owner consents to the exact set. Before
the first request, `send` checks that each repository with a pending request is public now. The
other v3 boundaries stay: only the `request` field leaves the process, the wire bytes must equal
the plan, the key comes from `TYPESAFE_API_KEY`, and each answer is appended as it arrives.

```bash
DATA_ROOT=$(git rev-parse --path-format=absolute --git-common-dir)/dotbabel/graph-3e-datasets
RUN_ROOT="$DATA_ROOT/<date>-ai-adoption-v4-retry-<n>"
mkdir -m 700 "$RUN_ROOT"
node docs/experiments/graph-step-adoption-v4/run.mjs lock --dataset "$DATA_ROOT/<sealed retry dataset>" --out "$RUN_ROOT/study-lock.json"
node docs/experiments/graph-step-adoption-v4/run.mjs check --lock "$RUN_ROOT/study-lock.json"
node docs/experiments/graph-step-adoption-v4/run.mjs dry-run --lock "$RUN_ROOT/study-lock.json" --out "$RUN_ROOT/requests.jsonl"
set -a; . ~/.config/dotbabel/typesafe.env; set +a
node docs/experiments/graph-step-adoption-v4/run.mjs send --lock "$RUN_ROOT/study-lock.json" --consent-send <repositories_sha256> --out "$RUN_ROOT/answers.jsonl"
node docs/experiments/graph-step-adoption-v4/run.mjs evaluate --lock "$RUN_ROOT/study-lock.json" --answers "$RUN_ROOT/answers.jsonl"
```

## Tests

```bash
node --test docs/experiments/graph-step-adoption-v4/protocol.test.mjs
```

`plugins/dotbabel/tests/graph-adoption-v4-protocol.test.mjs` runs them in the Vitest suite. The
fixture is synthetic. One test compares the v4 numbers with the v1 `analyze("retry", ...)` on the
same synthetic answers; only that test marks the synthetic rows as human, to call v1.
