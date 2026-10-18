# Unit 3e: checked AI-label compatibility, version 2

This is an offline, dispatch-only AI-proxy agreement study. It accepts the truthful
`ai-annotation-verified` source after validating the complete retained evidence. It does not
change the independent-human protocol in `../graph-step-adoption/`, rename AI labels as human,
or authorize production adoption. The runner has no live-send operation and reads no model key.

The result measures agreement with the checked AI annotations. Distinct annotator and verifier
actors do not establish statistical independence. Shared models and blind spots can produce
correlated mistakes. Agreement is not evidence of independent-human accuracy.

## Locked evidence

The input is the sealed public ledger from `../graph-3e-datasets/historical.mjs combine-public`.
Both parent cohorts remain explicit: the original final-head baseline and the historical review-head
supplement. The inspector reconstructs their source inputs, baseline profiles, complete patch
packets, independent labels, exact agreements, sidecars, unknowns, file hashes, and private modes.
The packet freeze must precede both labels. Every admitted annotation must cover every candidate,
declare complete inspection, and remain blind to predictions. Reused actors and future labels fail.

The lock binds the public manifest, ledger, annotation sidecar, verification sidecar, unknown ledger,
both source policy hashes, all directly or transitively imported local implementation files, and every v1
numeric rule. It also records the original protocol identity and the explicit public repository.
The original sealed manifests retain their v1 incompatibility flag. No source dataset is edited.

`check` reconstructs the evidence each time. A changed source file, dataset, policy, rule, sidecar,
unknown, or lock cannot silently reuse answers. Answer records must match the protocol hash,
lock SHA-256, and individual sample hash. Unknown answers and duplicate answer IDs fail.

The local parent archive can contain private evidence. Keep it local. The exported request plan
contains only the public row ID, binding hashes, and the typed `jevRequest` payload. It contains no
gold label, annotation, rationale, source patch, local path, or parent evidence. A future sender must
send only the `request` field, verify current public visibility, and require fresh explicit consent.

## Commands

Run these from the repository root. Use a new private output directory; files never overwrite.
The existing public dataset remains outside Git.

```bash
DATA_ROOT=$(git rev-parse --path-format=absolute --git-common-dir)/dotbabel/graph-3e-datasets
RUN_ROOT="$DATA_ROOT/2026-10-18-ai-label-protocol-v2-01"
mkdir -m 700 "$RUN_ROOT"
node docs/experiments/graph-step-adoption-v2/run.mjs lock --dataset "$DATA_ROOT/2026-10-18-public-dispatch-verified-01" --consent-public-repo kaiohenricunha/dotbabel --out "$RUN_ROOT/study-lock.json"
node docs/experiments/graph-step-adoption-v2/run.mjs check --lock "$RUN_ROOT/study-lock.json"
node docs/experiments/graph-step-adoption-v2/run.mjs dry-run --lock "$RUN_ROOT/study-lock.json" --consent-public-repo kaiohenricunha/dotbabel --out "$RUN_ROOT/requests.jsonl"
node docs/experiments/graph-step-adoption-v2/run.mjs evaluate --lock "$RUN_ROOT/study-lock.json"
```

`lock` and `check` can describe an underpowered valid study. `dry-run` refuses it before writing
requests. The current public corpus passes with 124 agreed cases across 99 PR groups: 47 additions
and 77 none. All 33 public disagreements remain unknown. No class target or source target changes.

For later, separately obtained answers:

```text
node docs/experiments/graph-step-adoption-v2/run.mjs evaluate --lock LOCK --answers ANSWERS_JSONL
```

Each answer needs `id`, `protocol_hash`, `lock_sha256`, `sample_hash`, a candidate-only `answer`
array, a finite `confidence` in `[0,1]`, and `fallback: false`. Invalid or stale responses count as
unanswered. The evaluator keeps the confidence threshold, built-in baseline, sample and class
floors, availability gate, precision, recall, recall gain, 2,000 PR-clustered bootstrap draws, and seed.

Results are `INCONCLUSIVE`, `AI_AGREEMENT_PASS`, or `AI_AGREEMENT_FAIL`. Every result remains
`adoption_eligible: false` and `promotion: shadow-only`, even with perfect agreement and stable
intervals. The immutable human protocol still decides its own adoption evidence. A later promotion
requires independent-human evidence or a separately approved adoption-policy change.

## Tests

```bash
node --test docs/experiments/graph-step-adoption-v2/protocol.test.mjs
```

`plugins/dotbabel/tests/graph-adoption-ai-protocol.test.mjs` brings these tests into the repository's
Vitest/CI suite. Its synthetic source fixture crosses real subprocess and filesystem boundaries.
It includes exactly 100 admitted cases, two retained disagreements, both source policies, complete
patch packets, and two states per PR where available. Synthetic fixture labels are not real research
observations. The tests compare v1 and v2 numeric results on that synthetic fixture only.

See [the compatibility review](compatibility-review.md) for the grounded decision, real offline
preflight, retained identities, test evidence, and the remaining Unit 3e work.
