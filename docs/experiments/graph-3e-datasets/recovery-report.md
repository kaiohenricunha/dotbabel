# Unit 3e evidence recovery — 2026-10-17

**All four previously missing retry logs are recovered. Four additional dispatch inputs are pinned.**
These eight inputs need independent annotation and separate verification. No new primary label is
claimed, and neither dataset is ready for Jev replay.

| Step     | Verified parent rows / PRs | New unlabeled inputs / PRs | Maximum after checking these inputs |
| -------- | -------------------------: | -------------------------: | ----------------------------------: |
| Retry    |                      0 / 0 |                      4 / 3 |                               4 / 3 |
| Dispatch |                    23 / 23 |                      4 / 4 |                             27 / 27 |

The unchanged floors require 100 rows, 30 PRs, and 20 examples per action or dispatch class.
Even if every new input receives an agreed label, retry still needs 96 rows across 27 more PRs.
Dispatch still needs 73 rows across three more PRs. Class balance also remains mandatory.
The parent's dispatch balance remains 17 additions and six empty labels.
The evaluator still excludes checked AI rows under protocol v1's human-only provenance restriction.

## Recovery evidence

The [initial collector](prepare.mjs#L297) retrieves PR comments but does not inspect local session logs.
Two explanations for the missing evidence were checked: absent comment links and deleted scratch logs.
The receipts have empty evidence links; two original logs remain on disk and two survive as original
tool outputs. Later assistant summaries and unrelated CI jobs are not used as failure text.

The recovery index reads 51 explicit Claude transcripts across the two existing repositories.
It retains 2,734 relevant paired tool events, 22 failure outputs, 20 literal roster requests,
and five original attestation logs. Two conflicting duplicate results remain excluded.
The four receipt-linked failures belong to three PRs. Original commands, log paths, head prefixes,
receipt timestamps, phase, and consecutive attempt link each recovered input.
The public case is dotbabel PR #466 at `a014842d36771ceb2af3a5c98d841eefb33bf409`.
Private case details remain in the private artifact bundle.

The [initial pool filter](prepare.mjs#L194) excludes final-head full profiles before recovering history.
Expansion instead inspects reviews for all 1,459 archived PRs and considers each observed review head.
This finds seven additional heads across seven PRs. Four have complete comparison patches,
historical protected paths, and an explicit original roster. Their four PR groups are new to the parent.
The other three comparisons omit 15, three, and one patches respectively, including binary or large
files. They remain unknown. No empty label is inferred from an absent finding.

Comparisons preserve their base and merge-base commits. They do not prove an earlier target branch
when a PR changed its base. The source pool remains selected, belongs to one owner, and is not a
population sample of repository operations. The transcript index does not turn every failed test
into a retry decision; failures without a pinned operational attempt remain candidates only.

## Collector correction

The first expansion attempt scrubbed serialized JSON and damaged escaped string syntax in three
comparison caches. A canary reproduces this independently of GitHub availability. Scrubbing parsed
string values before JSON serialization fixes the failure. Tests cover escaped quotes, nested values,
and secret removal. The subsequent reads produce valid JSON; the remaining three exclusions are
actual incomplete comparisons. Failed intermediate runs are not sealed or used as the final bundle.

## Private artifacts and status

The sealed bundle is in the common Git directory:

```text
.git/dotbabel/graph-3e-datasets/2026-10-17-recovery-03/
```

`recovery-manifest.json` hashes 180 files and binds the parent's manifest. The parent is the unchanged
`2026-10-17-preparation-01` run, which retains its 670-file manifest. All artifact directories use 0700;
all files use 0600. Sanitized relevant excerpts are retained; full raw transcripts are not copied.
The original transcript hashes and line references support source tracing. Active source transcripts
can subsequently change, so retained excerpts remain distinct from the original raw source files.

`retry-annotation-input.jsonl` contains the four linked failure inputs and their provenance references.
`dispatch-annotation-input.jsonl` contains four new inputs with pinned review states and comparisons.
`dispatch-pinning-unknown.jsonl` retains the three incomplete comparisons.
The bundle also retains collection responses, source metadata, link maps, and excluded conflicts.
It contains no Jev answers and creates no labels. No external model request, push, merge, deployment,
release, production-data write, or protocol threshold change occurs in this work unit.

The next step is independent annotation and separate verification of these eight inputs, followed by
collection of additional genuine operational decisions. Protocol provenance compatibility remains
a separate prerequisite for replay. Graph-engineering Unit 3e remains pending.

## Verification

The affected research tests and the real recovery CLI run are the verification scope.
The full repository test suite is not run. Exact commands and final output follow below.

```bash
node --test docs/experiments/graph-step-adoption/protocol.test.mjs docs/experiments/graph-step-adoption/run.test.mjs docs/experiments/graph-3e-datasets/prepare.test.mjs docs/experiments/graph-3e-datasets/recovery.test.mjs
```

Exit: 0. Final ten output lines:

```text
  ...
1..43
# tests 43
# suites 0
# pass 43
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 531.097647
```

```bash
node docs/experiments/graph-3e-datasets/recovery.mjs validate /home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-17-recovery-03 /home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-17-preparation-01
```

Exit: 0. Final ten output lines:

```text
    },
    "dispatch": {
      "rows": 4,
      "groups": 4,
      "total_rows_if_verified": 27,
      "total_groups_if_verified": 27
    }
  },
  "hashed_files": 180
}
```

```bash
node plugins/dotbabel/bin/dotbabel.mjs quality check --profile fast --path 'docs/experiments/graph-3e-datasets/**'
```

Exit: 0. Final ten output lines:

```text
  info semantic.swallowed_errors [skipped] — agent review is required
  info semantic.unbounded_concurrency [skipped] — agent review is required
  info semantic.unchecked_assertions [skipped] — agent review is required

.:javascript / hard
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.lint [checked] — check passed
```

The quality profile reports several metrics as `not_configured` and semantic checks as `skipped`.
Those measurements are not claimed as passes. Markdown formatting and direct Markdown rule checks
use the existing main-checkout tools; no dependency installation is needed. The CLI Markdown lint
initially ignores worktree paths, so the actual file contents are also checked through its library.
