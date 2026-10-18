# Unit 3e dataset preparation — 2026-10-17

**Preparation complete. Neither dataset is ready for replay or adoption.**

The separate AI verifier checked all 23 dispatch labels, including six empty labels, and agreed with
each annotation. Retry has no verified case. Four genuine failed conductor attempts remain unknown
because their receipts and retrieved PR comments do not link to the original failure logs.
Later attempt summaries and unrelated CI failures were not substituted.

| Dataset  | Verified cases | PR groups | Class balance               | Remaining floor shortfall                |
| -------- | -------------: | --------: | --------------------------- | ---------------------------------------- |
| Retry    |              0 |         0 | retry 0; fix 0; ask-owner 0 | 100 cases; 30 groups; 20 per action      |
| Dispatch |             23 |        23 | additions 17; none 6        | 77 cases; 7 groups; 3 additions; 14 none |

The primary dispatch set contains five public cases and 18 private cases. No case was duplicated to
meet a floor. The annotation source is `ai-annotation-verified`, not `independent-human`.

## Evidence and limits

Collection read 396 public PR snapshots and 1,063 distinct private snapshots from the recovered
archives. The private pool comprises 1,000 merged records plus 63 additional records; it is not an
exhaustive repository history. Initial final-head profile filtering retained 315 recovery opportunities.
This selection can miss a PR whose earlier head had a smaller reviewer profile.

Primary inputs use original anchored review heads, same-head reviewer rosters, historical protected
paths, complete comparison metadata, changed files and line counts. Observed profiles take precedence
over the reconstructed locked baseline, including a documented three-reviewer override. Unverified
rosters are not assumed to match today's profile rules. An empty label rests on pinned patch inspection
and same-head review evidence, not the absence of a finding. Labels select specialist expertise for
the changed decision surface; they do not certify legal claims in source documents.

There are 295 unknown records: four retry attempts and 291 dispatch opportunities. Dispatch reasons
are 251 missing original review-head anchors, 36 unverified original rosters, two missing historical
protected-path snapshots, and two different historical reviewer inventories. There are 1,148 excluded
records: 1,131 full baseline profiles, 13 incomplete PR snapshots, three non-operational stop blocks,
and one observed all-reviewers-included profile. No observed operational attempt is excluded at cap
in this source snapshot; the tooling separately tests the cap boundary.

The data is small, selected, and concentrated in one owner's public/private workflows. The AI labels
have a full second-agent check, not a human audit. Historical review content supports evidence checks;
it never enters the model input. Older finding-validity labels do not determine these labels.
The broad initial secret scrub also removes some non-secret source text. The retained evidence is
therefore a sanitized snapshot, not a byte-identical replacement for the original sources.

## Local artifacts

The common Git directory is `/home/kaiocunha/projects/kaiohenricunha/dotbabel/.git`.
The exact run root is:

```text
/home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-17-preparation-01/
```

Its files include `retry.jsonl`, `dispatch.jsonl`, `annotations.jsonl`, `verification.jsonl`,
`verification-unknown.jsonl`, `unknown.jsonl`, `excluded.jsonl`, `original-profile-excluded.jsonl`,
`candidates.jsonl`, `annotation-input.jsonl`, `collection-config.json`, `collection.json`, and
`manifest.json`. `sources/` contains sanitized source snapshots; `evidence/` contains pinned review
states, receipts, comments and case provenance. The manifest hashes 670 files and records counts,
groups, class balance, source coverage, original archive hashes, unknowns and exclusions.
Every run directory is 0700 and every file is 0600. Nothing private enters the commit.

## Compatibility and handoff

The existing evaluator returns **INCONCLUSIVE** without model answers for both datasets. It reports
all 23 AI rows as `unlabeled` under its current human-only restriction. The protocol hash remains
`f3079d8d3fa6697de4bf0e1fe68f7001a9ab586c85b64532008814e9fbf0952a`.
No protocol, collector, approved spec, production code, adoption state or numeric threshold changes.
No external model API, push, merge or release runs.

The [compatibility proposal](README.md#compatibility-proposal-for-the-integration-session) specifies
a separate checked-AI provenance source, per-case sidecar validation and a versioned provenance policy
in the protocol hash. The main session owns that review, Jev replay and adoption. Collect linked
original failure logs and more genuine dispatch cases before attempting to meet the unchanged floors.

## Verification

The commands and their final ten output lines follow. Exit zero for dataset validation means the
structure and hashes pass; `sample_floors_met: false` explicitly reports insufficient samples.
The fast quality profile reports unsupported or unconfigured metrics separately; those are not passes.
The full repository test suite is not run; this task uses the affected research-tool contracts.

```bash
node --test docs/experiments/graph-step-adoption/protocol.test.mjs docs/experiments/graph-step-adoption/run.test.mjs docs/experiments/graph-3e-datasets/prepare.test.mjs
```

Exit: 0.

```text
  ...
1..30
# tests 30
# suites 0
# pass 30
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 543.220702
```

```bash
node docs/experiments/graph-3e-datasets/prepare.mjs validate /home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-17-preparation-01
```

Exit: 0.

```text
      "exclusions": {
        "unlabeled": 23
      },
      "decision": "INCONCLUSIVE",
      "reason": "sample-floor",
      "metrics": null,
      "bootstrap": null
    }
  }
}
```

```bash
node docs/experiments/graph-step-adoption/run.mjs evaluate --in /home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-17-preparation-01/retry.jsonl
```

Exit: 0.

```text
        0
      ],
      "exclusions": {},
      "decision": "INCONCLUSIVE",
      "reason": "sample-floor",
      "metrics": null,
      "bootstrap": null
    }
  ]
}
```

```bash
node docs/experiments/graph-step-adoption/run.mjs evaluate --in /home/kaiocunha/projects/kaiohenricunha/dotbabel/.git/dotbabel/graph-3e-datasets/2026-10-17-preparation-01/dispatch.jsonl
```

Exit: 0.

```text
      "exclusions": {
        "unlabeled": 23
      },
      "decision": "INCONCLUSIVE",
      "reason": "sample-floor",
      "metrics": null,
      "bootstrap": null
    }
  ]
}
```

```bash
node plugins/dotbabel/bin/dotbabel.mjs quality check --profile fast --path 'docs/experiments/graph-3e-datasets/**'
```

Exit: 0.

```text
  info semantic.ignored_errors [skipped] — agent review is required
  info semantic.lifecycle [skipped] — agent review is required
  info semantic.swallowed_errors [skipped] — agent review is required
  info semantic.unbounded_concurrency [skipped] — agent review is required
  info semantic.unchecked_assertions [skipped] — agent review is required

.:javascript / hard
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.lint [checked] — check passed
```

```bash
git diff --cached --check
```

Exit: 0.

```text
(no output)
```
