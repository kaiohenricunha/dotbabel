# Unit 3e blind labels and sample expansion — 2026-10-18

## Result

The eight recovered inputs have separate blind annotations and verification. Five labels agree:
one retry action and four dispatch labels. Three retry inputs remain unknown because the retained
failure excerpts do not distinguish a code fault from a transient failure.

A separate offline-baseline dispatch cohort now has **146 accepted labels across 146 PRs**:
48 require additions and 98 require none. It meets the unchanged floors of 100 rows, 30 PR groups,
and 20 rows per class. Of 180 pinned inputs, 33 have independent disagreements and one has
insufficient evidence. All 34 remain unknown; no agreement was manufactured.

**Retry remains incomplete: 1 row across 1 PR, labeled `fix`.** It needs 99 additional rows,
29 additional PR groups, and class shortfalls of 20 `retry`, 19 `fix`, and 20 `ask-owner`.
The observed-roster dispatch cohort remains separate at 27 rows across 27 PRs, with 19 additions
and 8 none. Its shortfalls are 73 rows, 3 PR groups, 1 additions case, and 12 none cases.

These are verified AI annotations, not human labels. Protocol v1 admits only `independent-human`
(`../graph-step-adoption/protocol.mjs:72-83`). Both datasets therefore remain incompatible with
that evaluator. No Jev replay occurs, and retry/dispatch adoption remains `UNMEASURED`
(`plugins/dotbabel/src/decider.mjs:5-8`). Sample readiness does not establish model quality or adoption.

## Original eight inputs

Two separate agents inspect identical frozen packets without proposed labels or model predictions.
Each writes its own decision, rationale, source references, timestamp, and inspection scope.
The integrator requires separate actors, matching commits, valid actions, prediction blindness,
and exact label agreement. Both inspections must be complete for an empty dispatch label.

The original retry inputs retain their original phase, commit, failure text, and receipt-derived
consecutive counter. One identifies a deterministic code failure. The other excerpts lack the
exception/assertion or enough failure context. Missing cause evidence does not mean `retry` or
`ask-owner`. The four dispatch inputs use complete pinned comparisons and confirmed same-head
reviewer rosters. Their labels include two nonempty additions and two empty additions.

The original parent remains byte-for-byte unchanged. The new sealed run retains the recovery,
raw independent labels, unresolved cases, and canonical sidecars with resolvable evidence paths.
See `labels.mjs:25-62` for the agreement and unknown rules.

## Wider dispatch source coverage

The all-state GitHub metadata pool contains 2,186 PRs: 430 public and 1,756 private. Explicit API
totals match the listing counts. The observed-roster search inspects all 2,186 review histories,
including PRs excluded by the final-head baseline. It finds no usable new complete observed-roster
inputs beyond the four recovered earlier. Three remaining review heads have missing comparison
patches and stay unknown. No incomplete review pagination is present in that search.

The original locked collector computes a baseline directly from PR paths, changed lines, and
supplied facts (`../graph-step-adoption/run.mjs:24-40`); it does not require an observed historical
reviewer roster. The separate offline cohort follows that question. It makes no claim about the
reviewers actually assigned at the historical time and does not pool rows with the observed cohort.

The collection policy is frozen before labels. It uses repository configuration order, then the
SHA-256 rank of seed, repository, PR, and head. It selects the first 180 complete eligible merged
inputs. It excludes incomplete metadata and all-included profiles before annotation. There are
112 eligible public snapshots and 298 private snapshots. Four pinned source attempts remain unknown;
1,776 snapshots are excluded. The resulting input set has 110 public and 70 private PRs.
The frozen facts are explicit collection inputs, not a claim about historical facts.

Each input pins the full head, base, merge base, comparison, metadata, and facts. Validation
reconstructs its profile and candidates and rejects changed heads, missing patches, truncated commit
lists, or file/line disagreements. See `baseline.mjs:19-60` and `baseline.mjs:127-158`.

Two annotators label disjoint input partitions. Separate verifiers inspect all supplied patches.
Verification assignments change for throughput and prior source exposure before any label comparison;
the hashed routing record preserves those reasons and exact case assignments. Three inputs receive
fresh checks from a verifier with no earlier PR body/comment exposure. All earlier checks remain
secondary evidence. Verifier selection never depends on agreement. Unknowns retain both decisions.

The accepted public subset has 81 rows: 27 additions and 54 none. It is 19 rows short of a
public-only experiment. The private subset has 65 rows: 21 additions and 44 none. The combined
cohort meets the sample floors. This does not authorize private input transmission to a model or
establish that either individual repository meets the 100-row floor.

## Retry evidence and remaining collection

A separate GitHub search examines bodies and 258 comments for 100 targeted PRs. Two original
operational failure logs can be pinned to full commits. A contemporaneous comment numbers them
Run 1 and Run 2, but it does not prove the consecutive phase failure counter or a reset boundary.
They remain unknown. An ordinal is not a receipt counter, and a later diagnosis is not an original log.
The private `eligibility-audit.json` records both candidate explanations and the chosen missing-state
cause. Other candidates lack the full decision head or original failure cause.

The wider all-state search retrieves all 2,186 PR bodies and 2,279 comments, with no unavailable
sources or incomplete comment pagination. It indexes 509 phase/failure-marker leads. A high-signal
scan finds three sources: two descriptions of conductor tooling and one successful attestation
quotation. Two phase/failure fenced excerpts duplicate an acceptance-criteria test failure, without
an identified conductor phase state or consecutive counter. No additional eligible retry input is
admitted. The source index is a retrieval heuristic; it does not prove that no other source exists.
A phase/failure marker is a source lead only. Arbitrary CI failures, diagnostic probes, successful
runs, descriptions of tooling, and summaries without original failure/state evidence do not enter
the primary retry dataset. Future genuine runs must retain the original phase failure output,
full decision commit, receipt chain, and reset boundary before independent labeling.

## Private artifact locations and identities

All evidence lives below the common Git directory, in `dotbabel/graph-3e-datasets/`.
Directories have mode 0700; files have mode 0600. No dataset or private diff enters Git.
Each sealed manifest binds the retained file inventory with SHA-256 hashes.

| Run                               | Manifest SHA-256                                                   | Hashed files |
| --------------------------------- | ------------------------------------------------------------------ | -----------: |
| `2026-10-17-preparation-01`       | `4064606f4c20120dd3393b0827fdfb2124d448d79b822ebc9e1caa9bdc6d2543` |          670 |
| `2026-10-17-recovery-03`          | `055c22bd0f8652f8bbf25fe76067fadc4456832ee8a7d6cd0350f0025b19ed68` |          180 |
| `2026-10-18-verified-01`          | `f47646f24c873f9e47a6287f2cc4750c230e6c519516b1da6b7cb0e5cd20d722` |          862 |
| `2026-10-18-baseline-inputs-01`   | `183d0a90d26d39ce0f2eb645b28802e32aacdd2bd706e7c67c0c5ef31ff959ab` |          557 |
| `2026-10-18-all-retry-sources-01` | `a404c7da343cc26cf7361aa221ac520585e515c69193375315e50baa8ab0a3ad` |          115 |
| `2026-10-18-baseline-verified-01` | `cc6ff84f857766ef9832b5ed489617bb654bfdb224b38418ccfe3750a00a744d` |          770 |

The offline input policy hash is
`edd80373adbf1983e08400a347d3a7353409fa7557a8cf28e357164a3851c29a`.
The unchanged protocol v1 hash is
`f3079d8d3fa6697de4bf0e1fe68f7001a9ab586c85b64532008814e9fbf0952a`.
The offline policy identity covers its declared selection policy, numeric rules, profile function,
input constructor, and candidate-selection function. It does not replace protocol v1.

## Verification

The full repository suite is not run locally for this research-only change. The targeted research
suite and its actual Vitest wrapper run. The wrapper preserves the explicit TAP reporter required
by Node 24. Tests use synthetic inputs only inside isolated temporary directories.

All five commands below exit zero. The first has 54 passing research tests; the wrapper has one
passing test. The three real feature commands validate the sealed evidence and labels.
`DATA_ROOT` is set with the command used in the actual feature checks:

```bash
DATA_ROOT=$(git rev-parse --path-format=absolute --git-common-dir)/dotbabel/graph-3e-datasets
```

The last ten output lines for each command follow.

```text
$ node --test docs/experiments/graph-step-adoption/protocol.test.mjs docs/experiments/graph-step-adoption/run.test.mjs docs/experiments/graph-3e-datasets/prepare.test.mjs docs/experiments/graph-3e-datasets/recovery.test.mjs docs/experiments/graph-3e-datasets/labels.test.mjs docs/experiments/graph-3e-datasets/baseline.test.mjs
  ...
1..54
# tests 54
# suites 0
# pass 54
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 553.208914
```

```text
$ node /home/kaiocunha/projects/kaiohenricunha/dotbabel/node_modules/vitest/vitest.mjs run plugins/dotbabel/tests/graph-adoption-experiment.test.mjs

 RUN  v4.1.11 /home/kaiocunha/projects/kaiohenricunha/dotbabel/.claude/worktrees/graph-3e-recovery


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  00:23:43
   Duration  702ms (transform 13ms, setup 18ms, import 6ms, tests 581ms, environment 0ms)

```

```text
$ node docs/experiments/graph-3e-datasets/prepare.mjs validate "$DATA_ROOT/2026-10-18-verified-01"
      "exclusions": {
        "unlabeled": 27
      },
      "decision": "INCONCLUSIVE",
      "reason": "sample-floor",
      "metrics": null,
      "bootstrap": null
    }
  }
}
```

```text
$ node docs/experiments/graph-3e-datasets/baseline.mjs validate "$DATA_ROOT/2026-10-18-baseline-inputs-01"
  "by_repo": {
    "kaiohenricunha/dotbabel": 110,
    "kaiohenricunha/squadranks": 70
  },
  "unknown": 4,
  "excluded": 1776,
  "labels_present": false,
  "replay_performed": false,
  "policy_hash": "edd80373adbf1983e08400a347d3a7353409fa7557a8cf28e357164a3851c29a"
}
```

```text
$ node docs/experiments/graph-3e-datasets/baseline.mjs validate-gold "$DATA_ROOT/2026-10-18-baseline-verified-01"
          "additions": 0,
          "none": 0
        }
      },
      "ready": false
    }
  },
  "unknown": 34,
  "hashed_files": 770
}
```

The semantic review checks actor separation, cancellation and bounded work, source error handling,
private output ownership, frozen sampling, and unknown propagation. No runtime API or adoption
state changes. Source-read failures remain explicit unknowns; no recovered command executes.
Canonical proof references resolve inside each exported run. The routing check rejects a selected
verifier that differs from the predeclared assignment. No new dependency or suppression is added.

The PR quality profile exits zero. Syntax, configured lint, and file-size checks pass. Coverage
and configured runtime tests do not trigger because no runtime source changes. Unconfigured
complexity, duplication, typing, security, and dead-code measurements are not passes. The semantic
items require the manual review described above. Explicit Prettier checks pass for all four research
Markdown files; direct Markdownlint checks use the repository rules and report zero errors for four
files. This direct check avoids the worktree glob exclusion.

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

## Next work

Retry needs more genuine retained failure states, not a lower gate or guessed labels. Public-only
dispatch needs 19 additional verified inputs. The current combined dispatch cohort can support a
later reviewed protocol revision that binds checked AI provenance and the distinct cohort policy.
That revision must retain all numeric thresholds, validate hashed sidecars, and freeze labels before
replay. No model experiment or adoption result is claimed by this preparation.
