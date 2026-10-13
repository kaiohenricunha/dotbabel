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
| `rate_when_ci_unavailable` | `1`     | The share to verify while the default-branch CI is unavailable (§2.4).   |
| `always_paths`             | `[]`    | Globs (`**`, `*`, `?`) of changed paths that always select the check.    |

The control is opt-in. Without a `spot_check` block, the resolver returns a
policy with both rates at 0, so no spot check runs. The defaults in the table
apply to the keys that a block leaves unset.

The resolver is strict. An unknown key, a value outside 0 to 1, or a glob with
`!`, braces or brackets is an error (exit `2`), never a silent default, because
a typo must not lower the check rate.

The policy is off when both rates are `0` and no `always_paths` is set. Then the
command reads the pull request once to find its base commit, decides `off`, and
stops. It reads no changed files, no default branch and no CI runs, and it
records nothing.

The decision, in order:

1. An `always_paths` match selects, whatever the rate. The changed paths
   include the old path of each renamed file, so a move out of a watched
   directory still matches. When `always_paths` is set and the changed files
   cannot be read, the check selects too.
2. When the default-branch CI is unavailable, the rate is
   `rate_when_ci_unavailable`. Otherwise, and also when its state is unknown,
   the rate is `rate`.
3. A rate of `0` gives reason `off`. Otherwise the check selects when the roll
   is less than the rate (reason `rate` or `ci_unavailable`), and does not
   select otherwise (reason `not_selected`).

The roll is derived, not drawn: the first 32 bits of
`sha256("<head sha>:<pr number>")`, divided by 2^32. So the roll is fixed for a
head. A new roll needs a new head, and a new head makes the attestation stale
anyway. The rate is not fixed: it follows the CI state and the base policy. So
a selection is sticky. Once a head was selected, a later call on that head
reports it selected, with the first reason, marked `sticky`. A non-selection
can still change when the CI state or the base policy changes.

Every decision except that early `off` goes into the spot-check log,
`<git-common-dir>/dotbabel/receipts/pr-<N>.spot-checks.json`
(`schemas/dotbabel.spot-checks.schema.json`, `schema_version` 1). The log is a
sibling of the conductor run receipt, with its own lock. It is never part of the
receipt. An older CLI refuses a receipt with an unknown key, and every installed
CLI version shares the receipt directory. Each entry records the workflow file
and the branch that were read. `--record-explicit pass|fail` records the result
of the explicit run as an `explicit-run` entry. `spot-check --show` and
`main-status` report, for each pull request, whether it was selected and whether
an explicit run was recorded.

### 2.2 The four run states and the cumulative rule

`classifyRun` reads one workflow run and its jobs. It does not read
annotations:

| State        | When                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `green`      | The run succeeded.                                                                                                                            |
| `red`        | A job failed after it ran at least one step. A real failure, whatever the run conclusion or an annotation says.                               |
| `unverified` | No failed job ran a step: a billing limit, a startup failure, a cancelled or skipped run, or a run in progress with no failed job yet.        |
| `unknown`    | The run or its jobs list could not be read: a rate limit, a server error, a token without `actions: read`, or a jobs list longer than a page. |

A job that never started has a failed, `startup_failure` or `cancelled`
conclusion, zero steps, and no runner. That is the billing-blocked shape, and
its run conclusion is a plain `failure`. A failed job with zero steps is never
read as a real failure, with or without a runner. A billing annotation adds
nothing to the zero steps. A test reporter can also write the word "billing"
into an annotation of a real failure, so an annotation never changes a state.

The default branch is squash-merged and linear. So a green run on commit X
verifies X and every older commit: the tree at X contains them all, and the
run tested it. `dotbabel pr-stack main-status` applies this rule to the recent
first-parent commits of the default branch. It reports the last green commit
and, newer than it, every `red`, `unverified` and `unknown` commit, and the sum
of the three as the debt. When the runs list cannot be read, every commit is
`unknown`. Unknown is never verified.

`spot-check`, `main-status` and `contradiction` read the repository default
branch (`gh repo view --json defaultBranchRef`) when `--trunk` is not given.

`main-status --local` also runs the local-attest matrix on the default-branch
tip in a temporary detached worktree, and removes the worktree afterwards. It
runs repository code as the current user. So it needs project-command trust (the
allowlist that `dotbabel quality` and `doctor` use) or
`--allow-project-commands`. Otherwise it exits `2`. It installs from the same
lockfile table as `/merge-pr`, and with no supported lockfile it installs
nothing and says so. The result is `pass`, `fail` or `unknown`, labelled "local
(same machine as the agent; weaker than CI)". It never verifies a commit.

### 2.3 The contradiction alarm

A real test failure on code whose attestation said pass is the evidence this
layer detects. It is not proof of a forgery, and a forgery can avoid it (§3).
`isContradiction` is true only when the run is `red` and the pull request
carries a trusted, passing attestation for its head. A comment that was edited
after it was posted still counts, and the issue says that it was edited. The
merge gate refused edited comments at merge time.

Two places raise it:

- **After the merge.** The test workflow has a `contradiction` job that runs
  only when the test job failed on a push to the default branch. It classifies
  its own run; an `unknown` run exits `2`. A red run can come from any commit
  since the last green run. So the job walks first-parent history from the
  failing commit back to the last green commit, not included, at most 20
  commits. It checks every pull request merged in that range. Each one with a
  trusted, passing attestation is a suspect. The job labels each suspect
  `attestation-contradicted` and opens ONE issue for the failing commit. The
  issue names the range and every suspect, and a hidden marker per failing
  commit keeps it unique. When the first parent's own run was already red, the
  default branch was red before this push. Then the job opens no new alarm,
  prints why, and exits `0`.
- **Before the merge.** When a spot check selects a pull request and the
  explicit run really fails, `/merge-pr` stops and runs
  `dotbabel pr-stack contradiction --pr <N> --local-failure --post`.

The trust list comes from the merge commit's FIRST PARENT only, never from the
merge commit, which the pull request controls. A first parent with no
`.dotbabel.json` uses `["OWNER"]`; one that cannot be read or does not parse
exits `2`. `trustListSource` names the true source.

In GitHub Actions (`GITHUB_ACTIONS=true`), an existing issue with the marker
counts only when the workflow identity opened it, because the marker is
public. A closed match is reopened with a comment.

The job checks out the first parent (`github.event.before`) and runs the
detector from there against `github.sha`. So the merged pull request cannot
change the detector code that judges it. GitHub still reads the workflow file
from the pushed commit, so this repository lists `.github/workflows/test.yml` in
`attestation.governance_files`. A change to it then forces the explicit path.
The template tells consumers to do the same, and its `npx dotbabel` resolves
from the first parent's lockfile.

The issue lists the possible causes in short sentences. They are a forged or
wrong attestation, a flaky test or an environment difference, or a merged tree
that is not the attested head.

### 2.4 When CI does not run

The spot check reads the newest completed test run on the default branch. CI is
`available` only when that run is green or red and tested one of the last 10
first-parent commits. An older run says nothing about recent merges that had no
push run, so CI is then `unavailable`: nothing off the machine checked them. CI
is also `unavailable` when there is no completed run or the newest one is
`unverified`. Then the spot check applies `rate_when_ci_unavailable`, which
defaults to `1`: every attested pull request is verified explicitly. If the
runs, the jobs or the recent commits cannot be read, the state is `unknown`,
never `available`, and the normal `rate` applies. An `unverified` run is never a
contradiction, and an `unverified` commit is debt, not a pass.

## 3. Limits

This layer detects. It does not prevent, and it can be avoided.

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
- **The logs are self-reported.** The spot-check log and the run receipt
  record what the tool decided and what the session said it ran. They are
  logs, not evidence.
- **The push run is the only check off the agent's machine.** It detects a
  contradiction only when it runs to completion, on unchanged detector code,
  while the attestation comment exists. These avoid it:
  - a `[skip ci]` marker in the merge message;
  - a cancelled run;
  - a deleted comment, or an edit that removes the attestation;
  - a change to the workflow file.

  In the first two cases, `main-status` still shows the commit as `unverified` debt.

- **A red default branch hides a new forgery.** When the first parent's run
  was already red, no new alarm opens. The commit shows only as debt.
- **Actions minutes.** The push run exists only while the repository has
  Actions minutes. Without them, the soft path falls back to local checks,
  which are weaker.
- **A contradiction is not proof of forgery.** A flaky test, an environment
  difference, or a merged tree that differs from the attested head also
  produces one. The issue says so.

## 4. Interfaces

- `schemas/dotbabel.config.schema.json` — `attestation.spot_check`.
- `schemas/dotbabel.spot-checks.schema.json` — the spot-check log.
- `plugins/dotbabel/src/merge-verification.mjs` — the pure decisions.
- `plugins/dotbabel/src/merge-verification-inputs.mjs` — the GitHub and git
  reads, behind an injected `run`.
- `plugins/dotbabel/src/spot-check-store.mjs` — the spot-check log, pure.
- `plugins/dotbabel/bin/dotbabel-pr-stack.mjs` — `spot-check`, `main-status`,
  `contradiction`.
- `.github/workflows/test.yml` and `plugins/dotbabel/templates/workflows/test.yml`
  — the `contradiction` job.
- `commands/merge-pr.md` — step 4 (spot check), step 6 (record the explicit
  run), step 7 (contradicted evidence), step 11 (debt after the merge).
