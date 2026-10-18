# Unit 3e AI-label protocol compatibility — 2026-10-18

## Decision and evidence scope

Admit the existing checked AI labels only to a separately versioned **AI-proxy agreement study**.
Keep the original human protocol and its adoption gate unchanged. Version 2 permits offline source
validation, study locking, typed request preparation, and answer analysis. It has no live sender.
No key is read and no Jev request occurs in this work unit.

The public corpus has 124 agreed cases across 99 PR groups: 47 additions and 77 none. It retains
33 public disagreements as unknown. This closes the dispatch sample floor, not the human-evidence
gap. A future AI study cannot claim independent-human accuracy or promote the runtime adapter.

## Grounded compatibility audit

| Candidate cause                             | Supporting evidence                                                                                                                | Evidence against or limit                                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insufficient public samples                 | The earlier public final-head cohort had only 81 agreed rows.                                                                      | The sealed historical supplement now brings the public ledger to 124 rows, 99 PR groups, and 47/77 classes; all sample floors pass.                                    |
| The evaluator rejects the actual provenance | `../graph-step-adoption/protocol.mjs:79` requires `independent-human`. The unchanged evaluator labels all 124 AI rows `unlabeled`. | The source validators reconstruct the original inputs and exact independent-role agreement. The labels are valid checked AI evidence, with a different evidence scope. |

The chosen cause is the provenance mismatch. Renaming labels would create a false human claim.
Changing the original criterion in place would change a locked study. Version 2 therefore has a
separate policy and hash, preserves `ai-annotation-verified`, and caps all outcomes at shadow-only.

`protocol.mjs:36` requires distinct actors, exact labels, prediction blindness, complete inspection,
and per-candidate reasons. `protocol.mjs:48` checks packet/input identities and freeze chronology.
`protocol.mjs:57` invokes the full sealed-parent reconstruction and binds the public ledger and
unknowns. `protocol.mjs:90` creates the new lock; `protocol.mjs:102` checks it against the current
implementation and original evidence before every operation.

## Limits and controls

All agreed public rows from both frozen source cohorts enter the study. No old disagreement is
revisited, majority-selected, or removed to meet a class count. The cohorts remain identifiable,
with at most one final head and one added historical head per PR. Bootstrap draws group by PR.
The sample is conditional on AI-role agreement; the 33 unresolved cases remain visible.

Distinct agents can share training, models, assumptions, or errors. Full inspection and agreement
do not measure human accuracy. The historical baseline uses declared frozen collection facts;
it does not establish which reviewers were actually assigned at that historical moment.

Every numeric rule is imported unchanged from v1. Synthetic conformance tests compare precision,
recall, improvement, availability, and every bootstrap interval against v1. The production evaluator
never rewrites a real AI label as human. `analysis.mjs:43` rejects duplicate or out-of-population
answers and ignores stale protocol, lock, sample, malformed, or fallback answers. Even perfect
agreement returns `AI_AGREEMENT_PASS`, not `ADOPT`; `adoption_eligible` stays false.

The original public manifest still states `protocol_compatible: false`, referring to v1. The new
lock expresses v2 compatibility without editing that sealed artifact. All raw parent evidence
stays local, including private rows in the old mixed parent. Exported requests contain only public
typed state and binding hashes. This runner rejects `--send` and contains no network operation.

## Offline preflight and verification

The real lock admits **124 requests across 99 PR groups**, with 47 additions, 77 none, and all
33 unknowns preserved. It records 81 final-head and 43 historical-head cases. Both parent policy
hashes, the full public manifest, sidecars, and all 14 local implementation files are bound.
The exported plan has exactly the corresponding public typed state, with no gold or evidence fields.
No model key is accessed and the runner reports **zero network requests**.

| Identity                   | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| v2 protocol                | `b4b11ab10f7617e46de11bcd8138a749580dca8312138e746164811f410f4736` |
| New study lock             | `5b06cb587c8c96702986c827873dfa611b18bff53197bc943da0b05182d0bfa2` |
| Offline request plan       | `aa3808683a6b5a115f239162ade4f8ede90c97c7eaaa8c5e2148b0c282d333f0` |
| Unchanged public manifest  | `10ad671d973f2c776f1164cb8c1842b3c04434f35e951e26ee008c73e7a3fc75` |
| Parent protocol identity   | `f3079d8d3fa6697de4bf0e1fe68f7001a9ab586c85b64532008814e9fbf0952a` |
| Unchanged v1 protocol file | `26089a2eb676ead4f77d9cd966695a7ad9f14ff1c69c38e38b7490977b14820b` |
| Unchanged v1 runner file   | `8b3f98d3b64b0df7a0a5689eb296b0554faab513c5e630f4b2d70542cd7325a6` |

The new private run is `dotbabel/graph-3e-datasets/2026-10-18-ai-label-protocol-v2-01` in the
common Git directory. The lock and request plan use mode 0600 in a mode-0700 directory. No dataset
or request plan enters Git. Reusing a filename fails rather than replacing a locked artifact.

All **66 research tests** pass. Both Vitest CI wrappers pass. The new integration builds complete
synthetic parents, admits exactly 100 agreed rows, preserves two disagreements, rejects an
underpowered study before request export, and rejects live send. A fetch guard enforces offline
execution. Perfect synthetic answers pass numeric agreement gates while remaining shadow-only.
The full repository suite is not run locally; exact-head CI supplies that merge evidence.

The commands below ran in order and exited zero. The final ten output lines are retained for each.
`DATA_ROOT` and `RUN_ROOT` have the exact values shown in the README commands.

```text
$ node --test docs/experiments/graph-step-adoption/protocol.test.mjs docs/experiments/graph-step-adoption/run.test.mjs docs/experiments/graph-3e-datasets/prepare.test.mjs docs/experiments/graph-3e-datasets/recovery.test.mjs docs/experiments/graph-3e-datasets/labels.test.mjs docs/experiments/graph-3e-datasets/baseline.test.mjs docs/experiments/graph-3e-datasets/historical.test.mjs docs/experiments/graph-step-adoption-v2/protocol.test.mjs
  ...
1..66
# tests 66
# suites 0
# pass 66
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 17285.424298
```

```text
$ node docs/experiments/graph-step-adoption-v2/run.mjs lock --dataset "$DATA_ROOT/2026-10-18-public-dispatch-verified-01" --consent-public-repo kaiohenricunha/dotbabel --out "$RUN_ROOT/study-lock.json"
  },
  "unknown": 33,
  "sample_floors_met": true,
  "label_source": "ai-annotation-verified",
  "human_labels": false,
  "adoption_eligible": false,
  "private_request_rows": 0,
  "parent_protocol_compatible": false,
  "requests": 124
}
```

```text
$ node docs/experiments/graph-step-adoption-v2/run.mjs check --lock "$RUN_ROOT/study-lock.json"
  "label_source": "ai-annotation-verified",
  "human_labels": false,
  "adoption_eligible": false,
  "private_request_rows": 0,
  "parent_protocol_compatible": false,
  "compatible": true,
  "requests": 124,
  "protocol_hash": "b4b11ab10f7617e46de11bcd8138a749580dca8312138e746164811f410f4736",
  "lock_sha256": "5b06cb587c8c96702986c827873dfa611b18bff53197bc943da0b05182d0bfa2"
}
```

```text
$ node docs/experiments/graph-step-adoption-v2/run.mjs dry-run --lock "$RUN_ROOT/study-lock.json" --consent-public-repo kaiohenricunha/dotbabel --out "$RUN_ROOT/requests.jsonl"
{
  "dry_run": true,
  "requests": 124,
  "network_requests": 0,
  "adoption_eligible": false
}
```

```text
$ node docs/experiments/graph-step-adoption-v2/run.mjs evaluate --lock "$RUN_ROOT/study-lock.json"
  "cohorts": {
    "offline-locked-baseline": 81,
    "public-historical-review-head-baseline": 43
  },
  "unanswered": 124,
  "decision": "INCONCLUSIVE",
  "reason": "sample-floor",
  "metrics": null,
  "bootstrap": null
}
```

```text
$ node docs/experiments/graph-step-adoption/run.mjs evaluate --in "$DATA_ROOT/2026-10-18-public-dispatch-verified-01/public-dispatch.jsonl"
      "exclusions": {
        "unlabeled": 124
      },
      "decision": "INCONCLUSIVE",
      "reason": "sample-floor",
      "metrics": null,
      "bootstrap": null
    }
  ]
}
```

```text
$ node /home/kaiocunha/projects/kaiohenricunha/dotbabel/node_modules/vitest/vitest.mjs run plugins/dotbabel/tests/graph-adoption-experiment.test.mjs plugins/dotbabel/tests/graph-adoption-ai-protocol.test.mjs

 RUN  v4.1.11 /home/kaiocunha/projects/kaiohenricunha/dotbabel/.claude/worktrees/graph-3e-provenance-v2


 Test Files  2 passed (2)
      Tests  2 passed (2)
   Start at  08:52:39
   Duration  25.88s (transform 191ms, setup 219ms, import 132ms, tests 28.88s, environment 1ms)

```

The final PR quality profile exits zero. Checked syntax and lint commands pass. Coverage is not
triggered for these research-only paths; unavailable or unconfigured metrics are not called passes.
Automated semantic rows remain skipped; manual review checks frozen selection, chronology, actor
separation, unknown retention, stale-answer handling, payload isolation, and the adoption boundary.
No suppressions, policy reductions, runtime changes, schema changes, workflow changes, or spec edits
occur. Explicit Markdown, formatting, whitespace, and staged credential/data scans also pass.

```text
$ node plugins/dotbabel/bin/dotbabel.mjs quality check --profile pr --base origin/main
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.lint [checked] — check passed
  info correctness.tests [not_triggered] — changed files did not match: plugins/dotbabel/src/**

.:javascript / regression
  info coverage.no_regression [not_triggered] — changed files did not match: plugins/dotbabel/src/**
```

## Remaining Unit 3e work

This goal prepares the reviewed compatibility boundary before any Jev replay. A separate live
sender must retain all lock, consent, visibility, floor, and payload boundaries. AI-proxy results
can guide research but cannot satisfy the unchanged human adoption protocol. Production adoption
needs independent-human evidence or a separate approved policy change and reviewed disposition.
Retry remains at one verified case; this dispatch-only protocol does not invent its 99 missing
failure states. The runtime retry and dispatch entries remain `UNMEASURED`.
