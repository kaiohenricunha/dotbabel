# Unit 3e: owner-approved AI-label adoption, version 3

Version 3 lets checked AI labels support an ADOPT result for the dispatch step. It adds a live
Jev sender. The v1 human protocol (`../graph-step-adoption/`) and the v2 AI-proxy study
(`../graph-step-adoption-v2/`) stay byte-identical, so the locks made with them stay valid.

## Owner approval

On 2026-10-19 the owner approved this adoption-policy change. In version 2, every result is
shadow-only (`../graph-step-adoption-v2/README.md:66-68`). In version 3, `ai-annotation-verified`
labels can give ADOPT. The owner gave this approval because human labeling is not available.
The owner also gave fresh consent to send the locked dispatch requests to `api.typesafe.ai`.

The approval does not change the meaning of the labels. They are AI labels, not human labels.
Distinct annotator and verifier actors do not make them statistically independent. Shared models
can make correlated mistakes, so an ADOPT result measures agreement with checked AI annotations.

## What version 3 keeps and what it changes

| Item                    | Version 2                      | Version 3                                                    |
| ----------------------- | ------------------------------ | ------------------------------------------------------------ |
| Numeric rules (`RULES`) | v1 rules                       | v1 rules, unchanged                                          |
| Evidence inspection     | `inspectDataset`               | the same v2 function, imported                               |
| Metrics and bootstrap   | v1 dispatch math               | the same math; the tests compare it with v2 on equal answers |
| Decision                | `AI_AGREEMENT_PASS` or `_FAIL` | `ADOPT` or `REJECT`, as v1 decides                           |
| Promotion               | always `shadow-only`           | `review-required` on ADOPT with a stable interval            |
| Live send               | none                           | `send`, with fresh consent, the key, and a visibility check  |

An ADOPT with a fragile bootstrap interval stays shadow-only, as in v1. A `review-required`
result does not enable the step. A reviewed pull request must record the step's thresholds
in `plugins/dotbabel/src/decider.mjs` and link the report (KD-9).

The lock binds the v3 policy, the v1 rules, the v1 and v2 protocol hashes, and the bytes of every
v2 and v3 implementation file. A changed file makes the lock, and every answer made with it, invalid.

## The send boundary

`send` posts only the `request` field of each locked plan row. That field holds the model name,
the typed questions, and the public dispatch input. It holds no label, rationale, annotation,
local path, or parent evidence. Before the first request, `send`:

1. checks the lock again against the current files and evidence;
2. needs `--consent-send` to name the locked repository;
3. needs `TYPESAFE_API_KEY` in the environment;
4. checks that `gh api repos/<repo>` reports `public` now;
5. refuses an existing output file unless `--resume` is given.

Each answer record carries the protocol hash, the lock hash, and the sample hash. A failed request
is written with `fallback: true` and counts as unanswered. `send` appends each record when it
arrives, so an interruption keeps the paid answers. `--resume` sends again each row that `evaluate`
would reject, with the same answer check. At the end, `send` keeps the latest record for each row.
The key never goes into the output or the error text.

## Commands

Run these from the repository root. Use a new private output directory: files never overwrite.

```bash
DATA_ROOT=$(git rev-parse --path-format=absolute --git-common-dir)/dotbabel/graph-3e-datasets
RUN_ROOT="$DATA_ROOT/<date>-ai-adoption-v3-dispatch-<n>"
mkdir -m 700 "$RUN_ROOT"
node docs/experiments/graph-step-adoption-v3/run.mjs lock --dataset "$DATA_ROOT/2026-10-18-public-dispatch-verified-01" --consent-public-repo kaiohenricunha/dotbabel --out "$RUN_ROOT/study-lock.json"
node docs/experiments/graph-step-adoption-v3/run.mjs check --lock "$RUN_ROOT/study-lock.json"
node docs/experiments/graph-step-adoption-v3/run.mjs dry-run --lock "$RUN_ROOT/study-lock.json" --consent-public-repo kaiohenricunha/dotbabel --out "$RUN_ROOT/requests.jsonl"
set -a; . ~/.config/dotbabel/typesafe.env; set +a
node docs/experiments/graph-step-adoption-v3/run.mjs send --lock "$RUN_ROOT/study-lock.json" --consent-send kaiohenricunha/dotbabel --out "$RUN_ROOT/answers.jsonl"
node docs/experiments/graph-step-adoption-v3/run.mjs evaluate --lock "$RUN_ROOT/study-lock.json" --answers "$RUN_ROOT/answers.jsonl"
```

`send` exits 1 when a request has no usable answer. Run it again with `--resume`.

## Scope

Version 3 covers dispatch only. Retry needs its own sealed dataset of at least 100 cases across 30
PRs, with at least 20 cases of each action. That dataset does not exist yet. A retry study needs
a later version with its own policy hash.

## Tests

```bash
node --test docs/experiments/graph-step-adoption-v3/protocol.test.mjs
```

`plugins/dotbabel/tests/graph-adoption-v3-protocol.test.mjs` runs these tests in the Vitest suite.
The fixture labels are synthetic and are not research observations. The send tests use a fake
transport, so the tests make no network request.
