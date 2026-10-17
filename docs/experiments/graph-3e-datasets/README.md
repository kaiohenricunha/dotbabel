# Unit 3e dataset preparation

This research tool collects evidence and validates checked AI annotations. It never calls a model,
replays a decision, changes adoption, or modifies the locked protocol. Dataset files stay outside Git.
No dependency installation is needed. Collection needs existing read access through `gh`.

## Collection

Resolve the common Git directory with `git rev-parse --path-format=absolute --git-common-dir`.
Create the parent directory with mode 0700. Use a new run directory for each collection.
All output directories use 0700; all output files use 0600 and exclusive creation.

The local configuration contains `sources`, an array of explicit evidence archive paths, and
`repositories`, an array of objects with these fields:

| Field      | Meaning                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `name`     | GitHub `owner/repository`                                                 |
| `facts`    | Local repository-specific facts JSON with `protected_paths`               |
| `receipts` | Local conductor receipt directory                                         |
| `metadata` | Optional gzip JSON PR arrays; otherwise read merged PR metadata with `gh` |

Archived metadata must include `number`, `headRefOid`, `files`, `changedFiles`, `additions`, and
`deletions`. Source arrays are deduplicated by PR number. Explicit additional metadata wins over the
earlier snapshot. The public listing is capped at 1,000 records; record any source truncation.

Run these commands in order. Replace the paths with private absolute paths:

```bash
node docs/experiments/graph-3e-datasets/prepare.mjs collect /private/config.json /private/new-run
node docs/experiments/graph-3e-datasets/prepare.mjs recover /private/new-run
node docs/experiments/graph-3e-datasets/prepare.mjs recover-more /private/new-run
node docs/experiments/graph-3e-datasets/prepare.mjs recover-retry /private/new-run
node docs/experiments/graph-3e-datasets/prepare.mjs stage /private/new-run
```

`recover` reads PR metadata, paginated reviews, commit comparisons, and facts at the historical merge
base. `recover-more` also checks archived finding commit references and substantive review anchors.
Finding dispositions are never action labels. The collector does not read earlier Jev answer files.
Recovery uses four concurrent read-only requests and caches each result. Existing cache files are
never overwritten. A failed request remains unknown; a new run can retry it.

Final-head metadata only selects a recovery pool. A primary input uses the original anchored review
head, its changed files and line count, and an explicit reviewer roster at that head. The baseline
profile follows the unchanged protected/docs/small/full rules in `graph-step-adoption/protocol.mjs`.
Historical repository-specific facts determine protected paths. The observed roster takes precedence
over the reconstructed baseline, including documented overrides. An all-included roster is excluded.
Unverified historical rosters and unsupported historical reviewer inventories stay unknown.
The candidate inventory is the protocol's four named specialist roles, minus the observed roster.

Receipt failures stay unknown unless original failure text can be linked to the phase, consecutive
failure attempt, and head. A lifetime receipt `n` is not the consecutive failure count. A pass or an
explicit `USER_ALLOWED_RETRY` resets that count; other skips do not. Attempt three is excluded.
Stop-phase blocks and arbitrary CI failures do not become retry decisions. PR comments can identify
further evidence, but later attempt summaries cannot replace original logs. Scrub any recovered
failure excerpt before saving it. Extend collection with an explicit source adapter when a real
transcript/log link exists; this tool does not search private session directories or infer missing
logs from reason codes.

## Annotation and verification

Use `annotation-input.jsonl` as the input ledger. Write `annotations.jsonl` and `verification.jsonl`
outside Git, each with one record per case ID and mode 0600. Do not show Jev predictions to either
agent. A separate AI session checks every proposed label, rather than only a sample.

Annotation records contain `id`, `head_sha`, `label`, `annotator`, `rationale`, `evidence`, and
`blind_to_predictions: true`. Record per-candidate reasons, the annotation time, and inspection scope.
An empty dispatch label also requires `inspection_complete: true`, backed by inspection of the
pinned diff and sufficient same-head review evidence. Missing findings alone never establish it.

Verification records contain `id`, `head_sha`, the verifier's `label`, `verifier`, `rationale`,
`evidence`, `blind_to_predictions: true`, `disagreements`, and `status`. The verifier must differ from
the annotator. Only `status: "agree"` with the same label can enter the primary dataset. Preserve
disagreement history even when a later check resolves it. Unresolved cases stay unknown.

Use actual provenance: `label_source: "ai-annotation-verified"`. It is not a human label.
Additional reviewers must come from the candidate list and must not already appear in the profile.
The role rubric distinguishes architecture boundaries, declaration/enforcement checks, security,
and documentation needs. It does not equate the compliance reviewer with a legal expert.

```bash
node docs/experiments/graph-3e-datasets/prepare.mjs finalize /private/new-run
node docs/experiments/graph-3e-datasets/prepare.mjs seal /private/new-run
node docs/experiments/graph-3e-datasets/prepare.mjs validate /private/new-run
```

`finalize` writes `retry.jsonl`, `dispatch.jsonl`, `unknown.jsonl`, and the original-profile exclusions.
`seal` creates the manifest, then validates it. Do not write more files inside a sealed run.
Validation checks schemas, IDs, duplicate states, label values, evidence paths, original commit/profile
provenance, separate verification, private permissions, SHA-256 hashes, counts, classes and PR groups.
Exit zero means structural validation succeeded. Check `sample_floors_met` separately: false is not
readiness. The unchanged floors remain 100 cases, 30 PR groups, and 20 cases per class for each step.
The manifest records each shortfall. No answers means INCONCLUSIVE under the existing evaluator.

## Compatibility proposal for the integration session

Keep `independent-human` for actual human labels. Add a distinct `ai-annotation-verified` source only
after review of a new protocol version. Require a resolvable, hashed annotation sidecar and a separate
verification sidecar for every admitted AI row. Validate actor separation, matching case/head/label,
prediction blindness, pre-replay timing, evidence references, and resolved agreement. Reject unknowns,
unresolved disagreements, missing negative-label inspections, and reconstructed-only historical
profiles. Bind the sidecar hashes and a label-policy version to the frozen dataset manifest and
protocol identity. Include this provenance policy in the versioned protocol hash material: the current
hash only covers `RULES`, the model name and the request function, not the human-only eligibility code.

Change the collector and evaluator together in that later protocol review. Retain all numeric
thresholds. Freeze the accepted labels before replay, report AI labels separately from human labels,
and do not backdate human provenance. Protocol v1 currently rejects these AI rows as `unlabeled`.
This preparation changes neither its code nor its hash.

## Offline tests

```bash
node --test docs/experiments/graph-step-adoption/protocol.test.mjs docs/experiments/graph-step-adoption/run.test.mjs docs/experiments/graph-3e-datasets/prepare.test.mjs
```

Synthetic data appears only in isolated tool tests. It never enters an experimental dataset.

## Local failure recovery and wider review collection

Use `recovery.mjs` to read explicit Claude transcript directories and preserve relevant tool outputs.
Resolve those directories through `dotbabel handoff`; do not search the home directory.
The recovery configuration contains `repositories`, each with a GitHub `repo` name and explicit
`session_roots`. The scanner reads top-level UUID transcripts in those directories.
It never executes a recovered command. It excludes conflicting tool results and request blobs.
The scanner retains source hashes, line references, sanitized tool events, literal roster requests,
and attestation logs from scratch directories explicitly referenced by source commands.
A roster request alone does not confirm a historical dispatch.

```bash
node docs/experiments/graph-3e-datasets/recovery.mjs scan /private/recovery-config.json /private/recovery-run
node docs/experiments/graph-3e-datasets/recovery.mjs link /private/recovery-run /private/sealed-parent /private/retry-links.json
node docs/experiments/graph-3e-datasets/recovery.mjs expand-dispatch /private/recovery-run /private/sealed-parent
node docs/experiments/graph-3e-datasets/recovery.mjs pin-dispatch /private/recovery-run
node docs/experiments/graph-3e-datasets/recovery.mjs seal /private/recovery-run /private/sealed-parent
node docs/experiments/graph-3e-datasets/recovery.mjs validate /private/recovery-run /private/sealed-parent
```

The explicit retry link map supplies a parent case `id` and an `invocation_tool_id`.
Use `log_ref` for a retained original log. Alternatively, supply `failure_tool_id`,
`original_log_path`, and an optional `header_tool_id` for original tool-output excerpts.
The collector checks the invocation, PR, commit prefix, original log path, receipt timestamp,
operational phase, and consecutive attempt. Diagnostic runs and capped attempts remain excluded.
An independently recovered header stays outside the failure excerpt supplied to a model.

Review expansion reads every PR in the parent metadata pool, including final-head exclusions.
It considers each distinct review head with an explicit same-head specialist roster.
It retrieves pinned comparisons and historical facts before creating an annotation input.
Missing patches, incomplete review pagination, unsupported rosters, and failed reads stay unknown.
The comparison uses the retained PR base and the original review head; it does not establish a
different historical target branch that the source records do not preserve.

The outputs `retry-annotation-input.jsonl` and `dispatch-annotation-input.jsonl` contain **unlabeled
inputs**, not new verified primary rows. `recovery-manifest.json` hashes the private bundle and binds
the unchanged parent manifest and protocol. Keep failed intermediate runs separate from the sealed run.
The parent dataset remains unchanged. Independent annotations, separate verification, sufficient
samples, and protocol provenance compatibility are still required before replay.

Run the recovery tests with the existing preparation and protocol tests:

```bash
node --test docs/experiments/graph-step-adoption/protocol.test.mjs docs/experiments/graph-step-adoption/run.test.mjs docs/experiments/graph-3e-datasets/prepare.test.mjs docs/experiments/graph-3e-datasets/recovery.test.mjs
```

See [the recovery report](recovery-report.md) for the actual source coverage and remaining gaps.
