# merge-verification

## 1. Problem

`/merge-pr` trusts a SHA-pinned `local-attest` comment and skips its own test
run (`docs/attestation.md`, `commands/merge-pr.md` step 4). The merge gate
checks that the comment is from a trusted author, is not edited, names the
current head, and was produced under the base branch's configuration. It
cannot check that a real run produced it. An AI agent that drives `gh` with the
user's token is that trusted author, so it can post the comment without
running anything.

Signatures from a key that the agent cannot use would close this gap. That
design is in `docs/specs/unforgeable-evidence`, and it is parked as an opt-in
design: a generic open-source tool cannot require each user to own a hardware
key. This spec is the soft path that every repository gets.

A second fact shapes the design. Private consumer repositories often reach the
GitHub Actions spending limit. Then a workflow run fails, but no step ran. Such
a run proves nothing. The design must never count it as a pass and never count
it as a failure.

## 2. Design

The soft path gives detection, not prevention. It has three parts.

### 2.1 The spot check

`dotbabel pr-stack spot-check --pr <N>` decides whether `/merge-pr` verifies an
attested pull request explicitly anyway. `/merge-pr` runs it when the gate
reports `attestation.state` `verified`.

The policy is `attestation.spot_check` in `.dotbabel.json`, read from the pull
request's BASE commit, as the rest of the attestation policy is read. A pull
request cannot lower its own chance of a check.

| Key                        | Default | Meaning                                                                  |
| -------------------------- | ------- | ------------------------------------------------------------------------ |
| `rate`                     | `0`     | The share of attested pull requests to verify while the default CI runs. |
| `rate_when_ci_unavailable` | `1`     | The share to verify when the latest default-branch test run did not run. |
| `always_paths`             | `[]`    | Globs (`**`, `*`, `?`) of changed paths that always select the check.    |

The resolver is strict. An unknown key, a value outside 0 to 1, or a glob with
`!`, braces or brackets is an error (exit `2`), never a silent default, because
a typo must not lower the check rate.

The decision, in order:

1. An `always_paths` match selects, whatever the rate. When `always_paths` is
   set and the changed files cannot be read, the check selects too.
2. When the default-branch CI did not run, the rate is
   `rate_when_ci_unavailable`. Otherwise, and also when its state is unknown,
   the rate is `rate`.
3. A rate of `0` gives reason `off`. Otherwise the check selects when the roll
   is less than the rate (reason `rate` or `ci_unavailable`), and does not
   select otherwise (reason `not_selected`).

The roll is derived, not drawn: the first 32 bits of
`sha256("<head sha>:<pr number>")`, divided by 2^32. The same head always gets
the same answer, so running the command again cannot re-roll. A new roll needs
a new head, and a new head makes the attestation stale anyway.

Each decision is recorded in the run receipt (`schemas/dotbabel.run-receipt.schema.json`)
as a `spot-check` entry in `spot_checks`, apart from the phase `attempts`.
`--record-explicit pass|fail` records the result of the explicit run as an
`explicit-run` entry. `spot-check --show` and `main-status` report, for each
pull request, whether it was selected and whether an explicit run was recorded.
The entries never count toward a phase, the attempt cap, or the receipt verdict.

### 2.2 The three run states and the cumulative rule

`classifyRun` reads one workflow run, its jobs, and the check-run annotations
of its failed jobs:

| State        | When                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `green`      | The run succeeded.                                                                                                                                                                                                                                                    |
| `red`        | A job failed after it ran at least one step. A real failure.                                                                                                                                                                                                          |
| `unverified` | Any annotation matches `spending limit`, `recent account payments` or `billing`; the run conclusion is `startup_failure`, `cancelled`, `skipped`, `stale`, `action_required` or `neutral`; every failed job never started; the jobs cannot be read; or no run exists. |

A job that never started has a failed conclusion, zero steps, and no runner.
That is the billing-blocked shape, and its run conclusion is a plain `failure`,
not `startup_failure`. A `skipped` job downstream of a real failure also has
zero steps and no runner, but its conclusion is `skipped`, so the run stays
`red`.

The default branch is squash-merged and linear. So a green run on commit X
verifies X and every older commit: the tree at X contains them all, and the
run tested it. `dotbabel pr-stack main-status` applies this rule to the recent
first-parent commits of the default branch. It reports the last green commit,
every `red` commit newer than it, every `unverified` commit newer than it (no
run, or only unverified runs), and the sum of the two as the debt. When the
runs cannot be read (a rate limit, a missing workflow), every commit is
`unknown`. Unknown is never verified.

`main-status --local` also runs the local-attest matrix on the default-branch
tip in a temporary detached worktree, and removes the worktree afterwards. The
result is labelled "local (same machine as the agent; weaker than CI)". It
never verifies a commit.

### 2.3 The contradiction alarm

A real test failure on code whose attestation said pass is the one fact a
forgery cannot hide. `isContradiction` is true only when the run is `red` and
the pull request carries a current, trusted, never-edited, passing attestation
for its head (`hasCurrentAttestation`).

Two places raise it:

- **After the merge.** The test workflow has a `contradiction` job that runs
  only when the test job failed on a push to the default branch. It finds the
  pull request merged as that commit, classifies its own run, and, on a
  contradiction, adds the label `attestation-contradicted` to the pull request
  and opens one issue. A hidden marker that names the pull request and the
  attested head keeps the issue unique. The job costs minutes only when the
  default branch is already red, and a run that never started never reaches it.
- **Before the merge.** When a spot check selects a pull request and the
  explicit run fails, `/merge-pr` stops and runs
  `dotbabel pr-stack contradiction --pr <N> --local-failure --post`.

### 2.4 When CI does not run

If the latest completed test run on the default branch is `unverified`, CI is
unavailable. Then nothing off the machine checks an attestation after the
merge, so the spot check applies `rate_when_ci_unavailable`, which defaults to
`1`: every attested pull request is verified explicitly. If the runs cannot be
read at all, the state is `unknown` and the normal `rate` applies. An
`unverified` run is never a contradiction, and an `unverified` commit is debt,
not a pass.

## 3. Limits

- **Detection, not prevention.** A forged attestation still merges when the
  spot check does not select it. The alarm comes later, from the default
  branch's own CI run.
- **The roll is predictable.** An agent can compute it in advance and craft a
  head that is not selected. `always_paths` is not subject to the roll.
- **Local checks share the agent's machine.** The explicit run of a spot check
  and `main-status --local` run as the same user that could forge the
  attestation. A determined agent can fake their output too.
- **A determined agent can bypass `/merge-pr`.** It can call `gh pr merge`
  directly, and it can skip the spot check.
- **The receipt is self-reported.** It records what the tool decided and what
  the session said it ran. It is a log, not evidence.
- **The off-machine run is the only check the agent cannot skip.** That is the
  `push` run of the test workflow on the default branch, and it exists only
  while the repository has Actions minutes. Without them, the soft path falls
  back to local checks, which is weaker.
- **A contradiction is not proof of forgery.** A flaky test or a difference
  between the attesting machine and CI also produces one. The issue says so.

## 4. Interfaces

- `schemas/dotbabel.config.schema.json` — `attestation.spot_check`.
- `schemas/dotbabel.run-receipt.schema.json` — `spot_checks`.
- `plugins/dotbabel/src/merge-verification.mjs` — the pure decisions.
- `plugins/dotbabel/bin/dotbabel-pr-stack.mjs` — `spot-check`, `main-status`,
  `contradiction`.
- `.github/workflows/test.yml` and `plugins/dotbabel/templates/workflows/test.yml`
  — the `contradiction` job.
- `commands/merge-pr.md` — step 4 (spot check), step 7 (contradicted
  evidence), step 11 (debt after the merge).
