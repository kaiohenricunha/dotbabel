# Unit 3e public dispatch sample completion — 2026-10-18

## Result

The public request ledger now has **124 verified dispatch cases across 99 PRs**: 47 need reviewer
additions and 77 need none. It meets the unchanged floors of 100 cases, 30 PR groups, and 20 cases
per class. It contains zero private request rows. No model request or adoption change occurs.

The ledger combines 81 earlier agreed public final-head cases with 43 newly agreed historical-head
cases. Their source cohorts remain explicit. All 29 earlier public disagreements remain unknown;
four new independent disagreements also remain unknown. The 157 frozen inputs therefore yield
124 agreed labels and 33 unresolved labels. No prior disagreement is relabeled or removed.

Protocol compatibility remains **false**. An actual offline protocol-v1 evaluation rejects all
124 checked AI labels as `unlabeled`, answers zero requests, and returns `INCONCLUSIVE`. That
protocol accepts only actual `independent-human` labels. These labels use their truthful source,
`ai-annotation-verified`. Raw sample sufficiency does not establish evaluator eligibility, model
quality, or adoption. Retry remains at one verified `fix` case, with 99 additional cases needed.

## Grounded assessment

The existing replay command permits one consented public repository
(`../graph-step-adoption/run.mjs:83`). The earlier mixed cohort's 146 agreed rows cannot supply that
public-only run. Its public subset has 81 rows; the private subset cannot fill the public gap.
See [the earlier report](labeling-report.md) for that collection and its preserved unknowns.

Two explanations for the public shortfall were assessed:

| Candidate cause                                    | Evidence for                                                                                                                                        | Evidence against or limit                                                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| No additional genuine public decision states exist | The final-head pool has only 112 eligible public snapshots; 110 can be pinned and 81 obtain exact independent agreement.                            | Archived reviews identify 261 unsampled intermediate heads across 185 merged public PRs.                            |
| Final-head sampling omits usable historical states | GitHub reviews bind full intermediate commit IDs and timestamps. Complete comparisons can reconstruct a distinct offline baseline for those states. | Many historical states already include every reviewer or have incomplete comparisons. They cannot all become cases. |

The chosen path is a separate historical supplement. It preserves the original final-head cohort,
uses genuine recorded review heads, and makes no claim about historical assigned reviewers. It
changes neither a numeric gate nor the original baseline profile function.

## Frozen source collection

The source policy freezes all 261 candidates before annotation. It uses the original seed and the
SHA-256 rank of repository, PR, and head. It excludes every earlier sampled state, regardless of
its label outcome, as well as final heads. It targets 60 complete eligible inputs and permits at
most one additional state per PR. The collector checks actual GitHub repository visibility.

All 261 candidates are processed. The result is 47 complete inputs across 47 PRs, 10 incomplete
diffs retained as unknown, 194 all-included profiles excluded, and 10 further states excluded by
the one-added-state-per-PR limit. The source pool is exhausted; the target remains 60. No target,
class threshold, or selection rule is reduced after seeing labels.

Each input retains its source review, full historical head, real current PR head, comparison base,
merge base, complete changed-file patches, and frozen collection facts. The current PR head is
never rewritten to impersonate a historical snapshot. The comparison must contain the reviewed
head and the complete commit list. Missing patches, bounded-file-limit failures, and truncated
comparisons stay unknown. The baseline uses the same declared collection facts as the earlier
cohort; it does not claim that those facts governed the historical review.

`historical.mjs:32-47` constructs the ordered pool. `historical.mjs:50-72` checks the source head
and comparison and computes the unchanged profile. `historical.mjs:86-137` collects privately;
`historical.mjs:139-188` reconstructs the pinned inputs and every ordered selection outcome during
validation, including unknowns and exclusions.

## Independent annotations

Two fresh agents receive identical frozen packets, with the complete patches and protected paths.
Neither sees the other agent's proposed labels, earlier annotation ledgers, PR commentary, or model
predictions. They inspect all 47 inputs and provide per-candidate reasons, source references, actual
UTC timestamps, and inspection-complete flags. Large patches are read in bounded chunks.

Each agent supplies a label for all 47 inputs. Exact comparison finds 43 agreements and four
disagreements. The four remain unknown, with both original decisions preserved. Empty additions
require positive complete inspection by both actors. No label is selected by majority vote or to
reach a class count. The new agreed cohort has 20 additions and 23 none across 43 PRs.

`historical.mjs:191-243` compares the blind packets with the original patches and facts, reuses the
strict independent-label reconciliation, and retains canonical sidecars. Gold validation rebuilds
the agreed rows and counts from the original source and raw labels.

## Public ledger and local evidence boundary

`combine-public` records both source cohorts and selects only rows for the repository verified as
public. It rejects repeated PR/head states. The resulting ledger has at most two states per PR:
one original final head and one additional historical head. The locked bootstrap still groups
cases by PR, not by individual row.

`public-dispatch.jsonl` is the distinct public request surface. Its 124 rows all name
`kaiohenricunha/dotbabel`; no private repository's row enters it. Canonical sidecars and proofs have
resolvable local references. The source archives remain local and can contain private parent
evidence from the earlier mixed collection. Keep that evidence bundle local; any later replay
must use the exact public request ledger and retain the public-repository consent boundary.

The combiner and validator are in `historical.mjs:257-310`. They validate both sealed parents,
reconstruct the public rows and sidecars, and check hashes, permissions, classes, and PR counts.
Every directory uses mode 0700 and every retained file uses mode 0600. No dataset enters Git.

## Retry source availability

An additional independent inventory examines the two explicitly scoped project Git artifact stores.
It inventories 84 files outside excluded subtrees and scans 20 archival logs. Four retained failure
artifacts have original failure text but lack the required operational phase, full head, and
consecutive-counter/reset-chain links. It finds zero new complete retry states. Raw CLI transcripts,
credentials, environment files, fixtures, prediction ledgers, and the already audited dataset tree
are excluded from this inventory.

The earlier search also covers 2,186 PR bodies and 2,279 comments without pagination gaps. Original
logs, phase, head, and the actual consecutive counter remain necessary together. CI failures,
numbered run summaries, deliberate diagnostic failures, and missing cause evidence cannot fill
those gaps. No failure state, label, or attempt count is fabricated.

The private inventory is `2026-10-18-retry-artifact-inventory-02.json`, with SHA-256
`d8ed13debdfcc9fd691fbc7a60a69ab170745672b687ec41a6014f9e1bcfb529`.
Retry still needs 99 rows, 29 additional PR groups, and class shortfalls of 20 `retry`, 19 `fix`,
and 20 `ask-owner`. That source gap remains explicit.

## Artifact identities

All runs live below the common Git directory, in `dotbabel/graph-3e-datasets/`.
The parent final-head gold manifest remains unchanged at
`cc6ff84f857766ef9832b5ed489617bb654bfdb224b38418ccfe3750a00a744d`.

| Run                                        | Manifest SHA-256                                                   | Hashed files |
| ------------------------------------------ | ------------------------------------------------------------------ | -----------: |
| `2026-10-18-public-historical-inputs-01`   | `bc79e4086b1e1930b8c33351ec4b49b58fd9df15b71d0da6903a013dfa05d476` |          514 |
| `2026-10-18-public-historical-verified-01` | `ab138629f13a0471d2b08ac91bde558322b52f3c506d689610650fd3a4605b31` |          597 |
| `2026-10-18-public-dispatch-verified-01`   | `10ad671d973f2c776f1164cb8c1842b3c04434f35e951e26ee008c73e7a3fc75` |        1,497 |

The historical source policy hash is
`c9255e175b32aee25625a700200f6be61fb1d558b6b588df51b28bedebe209f7`.
It covers the declared policy, unchanged numeric rules, profile function, source-pool constructor,
and historical input constructor. It does not replace the evaluator protocol identity.
Protocol v1 remains
`f3079d8d3fa6697de4bf0e1fe68f7001a9ab586c85b64532008814e9fbf0952a`.

## Review finding

The initial validator checks file hashes and each accepted input, but does not reconstruct every
selection outcome. Two possible causes are assessed: byte corruption would fail the existing hash
check; a resealed omission can pass it because ordered selection outcomes are not rebuilt. A
regression test removes a complete eligible case and updates its manifest hashes and counts. The
initial validator wrongly accepts it. A second case falsely marks that retained complete input as
an unknown. The validator now rebuilds the ordered outcomes from every retained source response,
including the target stop and per-PR limit, and rejects both changes. The unchanged real frozen
runs still validate. No source policy, input, label, hash, or numeric rule changes.

The integration test also retains a private case in a mixed parent archive and proves that only
the public rows enter the request ledger. The private archive remains local.

## Verification

All seven research files pass: **57 tests, zero failures**. The repository's Vitest wrapper also
passes. The real CLI validates the input run, historical gold, and combined public ledger. The
offline protocol-v1 evaluation returns the expected `INCONCLUSIVE` result without model calls.

The PR quality profile exits zero. Checked compile and lint commands pass. Coverage rules are
not triggered for these research files; missing authoritative metrics remain `not_configured`.
Automated semantic rows remain `skipped`; a manual review examines source selection, counter
provenance, label blindness, error handling, private data boundaries, and retained references.
No policy changes or suppressions are added. Formatting and explicit Markdown checks pass.
A staged-content scan finds zero credential patterns and zero private dataset files.

The full repository suite is not run locally. Exact-head CI supplies the merge evidence.
The following commands ran in this order; each exits zero. Paths identify local tool and private
artifact locations, not committed datasets. Each block retains the last ten output lines.

```text
$ node --test docs/experiments/graph-step-adoption/protocol.test.mjs docs/experiments/graph-step-adoption/run.test.mjs docs/experiments/graph-3e-datasets/prepare.test.mjs docs/experiments/graph-3e-datasets/recovery.test.mjs docs/experiments/graph-3e-datasets/labels.test.mjs docs/experiments/graph-3e-datasets/baseline.test.mjs docs/experiments/graph-3e-datasets/historical.test.mjs
  ...
1..57
# tests 57
# suites 0
# pass 57
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 583.126944
```

```text
$ node /home/kaiocunha/projects/kaiohenricunha/dotbabel/node_modules/vitest/vitest.mjs run plugins/dotbabel/tests/graph-adoption-experiment.test.mjs

 RUN  v4.1.11 /home/kaiocunha/projects/kaiohenricunha/dotbabel/.claude/worktrees/graph-3e-public-history


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  01:09:39
   Duration  716ms (transform 11ms, setup 16ms, import 5ms, tests 600ms, environment 0ms)

```

```text
$ node docs/experiments/graph-3e-datasets/historical.mjs validate "/home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-18-public-historical-inputs-01"
  "structural_valid": true,
  "rows": 47,
  "groups": 47,
  "candidates": 261,
  "unknown": 10,
  "excluded": 204,
  "labels_present": false,
  "replay_performed": false,
  "policy_hash": "c9255e175b32aee25625a700200f6be61fb1d558b6b588df51b28bedebe209f7"
}
```

```text
$ node docs/experiments/graph-3e-datasets/historical.mjs validate-gold "/home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-18-public-historical-verified-01"
        }
      },
      "ready": false
    }
  },
  "unknown": 4,
  "protocol_compatible": false,
  "replay_performed": false,
  "hashed_files": 597
}
```

```text
$ node docs/experiments/graph-3e-datasets/historical.mjs validate-public "/home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-18-public-dispatch-verified-01"
      "ready": true
    }
  },
  "unknown": 33,
  "private_request_rows": 0,
  "sample_floors_met": true,
  "protocol_compatible": false,
  "replay_performed": false,
  "hashed_files": 1497
}
```

```text
$ node docs/experiments/graph-step-adoption/run.mjs evaluate --in "/home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-18-public-dispatch-verified-01/public-dispatch.jsonl"
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
$ node plugins/dotbabel/bin/dotbabel.mjs quality check --profile pr --base origin/main
.:javascript / hard
  info correctness.compile [not_triggered] — changed files did not match: plugins/dotbabel/src/**
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.lint [checked] — check passed
  info correctness.tests [not_triggered] — changed files did not match: plugins/dotbabel/src/**

.:javascript / regression
  info coverage.no_regression [not_triggered] — changed files did not match: plugins/dotbabel/src/**
```

## Remaining work

One of the two step datasets now meets the public sample floors: dispatch. Retry remains 1/100.
A reviewed protocol revision must admit the actual checked AI provenance, bind both source
policies and hashed sidecars, retain the public consent boundary, and preserve every numeric gate
before any replay. Retry additionally needs genuine retained failure states with complete counter
provenance. Unit 3e remains open; no model quality or adoption result is claimed.
