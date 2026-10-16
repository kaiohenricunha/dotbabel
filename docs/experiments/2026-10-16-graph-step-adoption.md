# Graph step adoption — locked experiment and evidence availability — 2026-10-16

## Question and status

Can Jev improve retry actions or additional reviewer selection over the built-in rules?

**Retry: INCONCLUSIVE. Dispatch: INCONCLUSIVE. No step is adopted.**
These are sample-floor decisions, not measurements of model performance. No vendor
request runs, and no fabricated answer or label enters the primary set.
The existing triage result remains REJECT.

The initial implementation has 11/12 units locally. This work prepares and tests
Unit 3e and evaluates the evidence available today. It does not claim that the
missing labeled retry experiment has run.

## Locked protocol

`graph-step-adoption/protocol.mjs` defines version 1 before any retry/dispatch
model output. Its hash is
`f3079d8d3fa6697de4bf0e1fe68f7001a9ab586c85b64532008814e9fbf0952a`.

The minimum primary set is 100 answered, independently labeled examples from
30 pull requests, with at least 20 examples in each retry action or each
dispatch positive/negative class. These floors prevent a one-class or small
corpus from producing an adoption decision. They do not guarantee external
validity. Labels must precede model replay; record source evidence and the
original head SHA. Model-generated labels are not independent human labels.

Retry must reach kappa 0.6, improve accuracy over the built-in answer by at least
five percentage points, and never continue a case labeled ask-owner.
At-cap cases are mechanically determined and excluded from this learned decision.

Dispatch must reach precision 0.8 and recall 0.9, and improve recall over the
built-in additions by at least ten percentage points. An input with every
candidate already in the profile offers no additional-reviewer decision and is
excluded. The production boundary still preserves security-auditor.

Both steps use confidence 0.9, built-in fallback below that confidence, and an
answer failure rate of at most 5%. Missing, malformed, stale-protocol or
changed-sample answers cannot count. The evaluator binds each answer to the
complete sample hash, including its pre-replay label.

Point estimates decide ADOPT/REJECT only after the sample floor passes.
The evaluator resamples whole pull requests 2,000 times with seed 20261016 and
reports 95% intervals. Passing estimates with intervals below an adoption
threshold stay in shadow mode. Any adoption still needs a reviewed source
change with the experiment report and regression tests. The evaluator never
changes production configuration.

## Evidence collected

Read-only GitHub collection examines all **391 merged dotbabel pull requests**
available on this date. It retains 109 dispatch opportunities from current
profile rules:

| Profile                        | PRs |
| ------------------------------ | --: |
| full-protected                 | 223 |
| full-size                      |  50 |
| small-code                     |  87 |
| docs-only                      |  22 |
| Incomplete snapshots, excluded |   9 |

The 273 full-profile records cannot add a reviewer. Nine snapshots have missing
or potentially truncated file lists and cannot determine a profile safely.
The [public corpus](graph-step-adoption/dispatch-corpus.jsonl) retains the exact
109 input states, source URLs, original head SHAs, and explicit null labels.
It contains public paths and counts, no file contents or review text.

The ten local conductor receipts contain one failed operational phase.
Its receipt deliberately omits the failure text that the retry input requires
(`plugins/dotbabel/src/run-receipt.mjs:16`). The two stop-phase blocks are
not retry decisions. This leaves **zero complete retry inputs**.
A failed GitHub Actions job is not substituted for a conductor action or label.

No independent gold labels exist for the dispatch corpus. No model answers
exist for either step. The primary counts are therefore zero, and the locked
floor returns INCONCLUSIVE for each step. The API key is also absent from this
session. Running a vendor call would not repair the missing labels.

## Commands and proof

Environment: Node 22.22.2, local worktree `feat/graph-engineering-complete`.
No new dependencies are installed for this experiment.

Read-only collection:

```bash
gh pr list --repo kaiohenricunha/dotbabel --state merged --limit 1000 --json number,headRefOid,additions,deletions,files,mergedAt > /tmp/graph-public-all-merged-prs.json
node docs/experiments/graph-step-adoption/run.mjs collect --repo kaiohenricunha/dotbabel --prs /tmp/graph-public-all-merged-prs.json --facts docs/repo-facts.json --receipts /home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/receipts --out /tmp/graph-adoption-all-samples.jsonl
```

The collection exits 0, reports 391 source PRs, 109 samples, zero labels,
and one receipt excluded for missing failure text. Receipt history is local;
another clone need not reproduce those ten receipts.

Reproduce the decision and dry run from the committed public corpus:

```bash
node docs/experiments/graph-step-adoption/run.mjs evaluate --in docs/experiments/graph-step-adoption/dispatch-corpus.jsonl
node docs/experiments/graph-step-adoption/run.mjs replay --in docs/experiments/graph-step-adoption/dispatch-corpus.jsonl --out /tmp/graph-adoption-requests-proof.jsonl
node --test docs/experiments/graph-step-adoption/protocol.test.mjs docs/experiments/graph-step-adoption/run.test.mjs
npx vitest run plugins/dotbabel/tests/graph-adoption-experiment.test.mjs
```

The output paths must be new. Files use exclusive creation and mode 0600.
Dry-run output contains zero requests until labels exist. The test fixtures use
synthetic answers solely to test ADOPT/REJECT boundaries. Those answers are
never experimental evidence.

The initial test run fails because the protocol module does not exist.
A later regression test proves a one-class corpus incorrectly reaches replay.
Class-balance checks fix that failure; all 22 offline tests then pass.
The Vitest wrapper runs those real subprocess contracts in repository CI.

## Next evidence required

1. Capture original retry inputs locally at failure time, with explicit review
   of any text before later upload. Do not add failure text to normal receipts.
2. Independently label enough retry actions and dispatch additions against their
   pinned source states. Preserve ambiguous cases as unknown.
3. Lock and hash the labeled corpus before replay. Never alter thresholds after
   seeing model output.
4. Use an authorized key and repository consent for a real run only after the
   complete primary sample floor can be met. Replay refuses smaller or
   one-class labeled corpora before calling a model.
5. Evaluate the real answers, retain REJECT/INCONCLUSIVE steps in shadow mode,
   and promote only the steps supported by the reviewed evidence.
