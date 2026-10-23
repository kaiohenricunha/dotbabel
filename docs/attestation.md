# Attestation: verify once per commit, then reuse

_Last updated: v4.5.0_

`dotbabel local-attest` runs your CI matrix on your machine and posts a comment
that names the commit it verified. With enforcement on, `/merge-pr` reads that
comment instead of running the test suite and the quality profile a second time.
The rule is simple: **expensive deterministic evidence is produced once per commit
SHA and reused until that SHA changes.** Everything that can change without the
SHA changing (mergeability, required checks, review threads, your explicit
authorization to merge) is still checked fresh at merge time.

Enforcement is off until you turn it on. A repository that never sets the policy
below behaves exactly as before: `/merge-pr` reads the `test` run that CI made
on the head SHA, and runs the suite itself only when CI did not test that head.

## When to turn it on

Turn enforcement on when CI cannot be the evidence: a private repository whose
Actions minutes run out, or a matrix that CI cannot run. Keep it off when CI
runs on every pull request at no cost to you. dotbabel itself keeps it off: CI
on the pull request head is its merge evidence, so a docs pull request needs no
local run, and a code pull request waits for CI instead of a local matrix.

The cost moves to CI: each push to a pull request starts the `test` matrix. A
newer push cancels the older pull request run, and standard runners cost
nothing on a public repository. A private repository spends the account's
included minutes. For it, register a self-hosted runner: its jobs use no
minutes, and CI stays the evidence. Without one, push each pull request head
once, when it is ready, or turn enforcement on.

With enforcement off, `local-attest` is a local check you run on demand, and it
is not merge evidence: the gate validates an attestation only when enforcement
is on. Pass `--dry-run` to run the matrix and post nothing. A posted
attestation makes the remote `test` job skip, so `/merge-pr` then has to start
a CI run for the head.

### The release checkpoint

CI on `main` runs the full suite after every merge, so a merge that breaks
`main` shows at once. The deep checks belong to the release, not to a count of
merges: before you merge the release pull request, run the full matrix and one
deep review of everything the release ships.

```bash
# from a checkout of the release pull request's branch
dotbabel local-attest --pr <release-PR> --full               # the whole matrix, every leg in full
git diff "$(git describe --tags --abbrev=0)"..origin/main    # what the release ships; review it with /code-review
```

## Adopt it

1. **Have a local-attest config.** Run `dotbabel local-attest --init`, then read the
   draft against your workflows (see [the README](../README.md#local-attestation)).
   Add a `quality` leg if you use [`dotbabel quality`](./quality.md), so its verdict
   is produced at attest time rather than at merge time. Give the `test` leg a
   `produces` list and pass `--reuse` so the quality leg does not run lint and the
   suite a second time ([Reusing a local-attest run](./quality.md#reusing-a-local-attest-run)).
2. **Choose what must be proven.** Name every leg that `/merge-pr` should no longer
   re-run in `required_legs`. Then list every file that decides what those legs do
   in `governance_files` (step 3 explains why).
3. **Add the policy to `.dotbabel.json`.**

   ```json
   {
     "attestation": {
       "enforce": true,
       "required_legs": ["lint", "test", "quality"],
       "governance_files": [".local-attest.config.mjs", ".dotbabel.json", "package.json"]
     }
   }
   ```

4. **Run `dotbabel doctor`.** It reports every way the policy and the config can
   disagree, before a real pull request is blocked by one (see
   [doctor findings](#doctor-findings)).

The pull request that adds this policy cannot use it: enforcement is read from the
**base** branch, and the base has no policy yet. That pull request lands through
the explicit verification path once. Every pull request after it uses the evidence.

## What the merge gate checks

The policy is read from the base ref with `git show`, never from the pull request,
so a pull request cannot relax its own enforcement.

| Key                    | Default                                          | Meaning                                                                                           |
| ---------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `enforce`              | `false`                                          | Require trusted, current attestation evidence before a pull request may merge.                    |
| `required_legs`        | `[]`                                             | Legs that must be present and pass or be skipped in the evidence, with at least one that passed.  |
| `governance_files`     | `[".local-attest.config.mjs", ".dotbabel.json"]` | Files whose committed bytes are hashed into every attestation.                                    |
| `trusted_associations` | `["OWNER"]`                                      | GitHub author associations whose attestation is believed. `OWNER`, `MEMBER`, `COLLABORATOR` only. |

`gate --gate merge` reports one state in `attestation.state`:

| State      | Meaning                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified` | Enforcement is on and the evidence is current, trusted, and complete. `/merge-pr` skips its own suite and quality run.                                                       |
| `off`      | The base branch does not enforce. `/merge-pr` reads CI on the head SHA, and verifies explicitly only when CI did not test that head.                                         |
| `explicit` | Enforcement is on, but this pull request edits a governance file, so its own evidence cannot vouch for it. `/merge-pr` verifies explicitly and you review the governed diff. |
| `failed`   | Enforcement is on and the evidence is missing, stale, untrusted, or incomplete. The merge is blocked. `/merge-pr` never launches the matrix itself.                          |

### Blocking reasons

| Code                          | Meaning and fix                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `ATTESTATION_MISSING`         | No attestation comment. Run `dotbabel local-attest --pr <N>`.                                          |
| `ATTESTATION_UNTRUSTED`       | The comment is not from a trusted association, or it was edited. Attest again as the owner.            |
| `ATTESTATION_STALE`           | The attestation names an older commit. Push happened after attesting; attest the new head.             |
| `ATTESTATION_INVALID`         | The payload is absent, unreadable, or disagrees with the marker. Attest again with a current dotbabel. |
| `ATTESTATION_CONFIG_CHANGED`  | Produced under a different configuration than the base branch. See below.                              |
| `ATTESTATION_BASE_MOVED`      | The diff it graded is not the diff being merged. Rebase, then attest again.                            |
| `ATTESTATION_INCOMPLETE`      | A required leg is missing or neither passed nor was skipped, or every required leg was skipped.        |
| `ATTESTATION_FAILED`          | The attestation verdict is not `pass`.                                                                 |
| `ATTESTATION_BASE_UNREADABLE` | The base commit is not in this clone. Fetch it and re-run.                                             |

### Skipped required legs

`local-attest` runs only the scope of a pull request's changes. A required leg
with nothing of the diff in its scope is recorded `skipped`, and the gate counts
it as satisfied: the same trusted, unedited comment carries the status, and the
config hash pins the scoping rules to the base branch's, so a skip is as
trustworthy as a pass. At least one required leg must have passed — evidence in
which every required leg was skipped verified nothing and is
`ATTESTATION_INCOMPLETE`. The payload's `full: true` field marks an on-demand
`local-attest --full` run; no gate reads it.

## Why governance files exist

An attestation proves that a matrix passed. It says nothing about whether the matrix
was honest. Without more, a pull request could rewrite the `test` leg to `true`, run
it, and attest a truthful `test: pass`.

So `local-attest` records a hash of the governance files as committed at the head,
and the merge gate recomputes that hash from the **base** branch. A pull request that
edits a governance file gets a different hash and cannot attest its own change. The
gate reports `explicit`, and the change lands through the explicit verification path
with a human reading the governed diff. That review is the real control: on that path
the pull request's own scripts run.

The list must therefore include **every file a leg executes or reads its behavior
from**. The defaults cover the config and `.dotbabel.json` (which carries the quality
thresholds). They do not cover `package.json`, so a leg such as `npm test` runs a
script a pull request can rewrite. Add `package.json`, and any `Makefile`, script, or
test-runner config a leg depends on.

Every entry must be a plain relative path (`ci/run-tests.sh`), with no `..`, spaces,
or shell characters. An entry that is not is refused, and because the gate and
`local-attest` then disagree about what to hash, every pull request is blocked with
`ATTESTATION_CONFIG_CHANGED` until the entry is fixed on the base branch.

## Spot checks and the contradiction alarm

The merge gate checks who wrote an attestation comment, not whether a real run
produced it. Anyone who holds the maintainer's `gh` token can post the comment,
and that includes an AI agent that runs `gh` for you. Signatures would prevent
this, but they need a key that the agent cannot use. That design is parked as
an opt-in spec (`docs/specs/unforgeable-evidence`). The soft path below works
in every repository. It detects a forgery. It does not prevent one.

### Configure the spot check

`/merge-pr` runs `dotbabel pr-stack spot-check --pr <N>` when the gate reports
`verified`. A selected pull request takes the explicit path anyway: the suite
and the quality profile run again. The policy is read from the **base** branch,
as the rest of the policy is:

```json
{
  "attestation": {
    "enforce": true,
    "spot_check": { "rate": 0.2, "rate_when_ci_unavailable": 1, "always_paths": ["src/auth/**"] }
  }
}
```

| Key                        | Default | Meaning                                                                                    |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `rate`                     | `0`     | The share of attested pull requests to verify explicitly while the default branch CI runs. |
| `rate_when_ci_unavailable` | `1`     | The share to verify while CI is unavailable (see "When CI does not run").                  |
| `always_paths`             | `[]`    | Globs of changed paths that always select the check. Only `**`, `*` and `?` are special.   |

The control is opt-in. Without a `spot_check` block, no spot check runs, not
even while CI is unavailable. The defaults in the table apply to the keys that
a block leaves unset.

An unknown key or a value outside 0 to 1 stops the command with exit `2`. It
never falls back to the default, because a typo must not lower the check rate.

The roll comes from the head: the first 32 bits of `sha256("<head>:<pr>")`. So
the roll is fixed for a head. A new head gives a new roll, and a new head also
makes the attestation stale. The rate can change: it follows the CI state and
the base policy. So a selection stays. Once a head was selected, a later run on
that head reports it selected again (`sticky`), with the first reason. A
non-selection can change when the CI state or the base policy changes.

The policy is off when both rates are `0` and no `always_paths` is set. Then the
command reads the pull request once to find its base, decides `off`, and stops.
It reads no changed files and no CI runs, and it records nothing.

Each other decision goes into the spot-check log,
`<git-common-dir>/dotbabel/receipts/pr-<N>.spot-checks.json`
([schema](../schemas/dotbabel.spot-checks.schema.json)). The log is next to the
run receipt, not inside it, so an older `dotbabel` still reads the receipt.
Each entry records the workflow file and the branch that were read. After the
explicit run, `/merge-pr` records its result with `--record-explicit pass` or
`--record-explicit fail`. Use `spot-check --pr <N> --show` to see both.

`always_paths` matches each changed path, and also the old path of a renamed
file. A pull request cannot move a file out of a watched directory to avoid the
check.

### Four run states and the cumulative rule

`dotbabel pr-stack main-status` reads the test workflow's runs on the default
branch. The default branch is the repository default branch, from
`gh repo view`, unless you pass `--trunk`. Each run gets one state:

| State        | Meaning                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `green`      | The run succeeded.                                                                                            |
| `red`        | A job failed after it ran at least one step. The tests really failed. An annotation never changes this.       |
| `unverified` | The run proves nothing: no failed job ran a step. That is a billing limit, a startup failure, or a cancel.    |
| `unknown`    | The run or its jobs list could not be read: a rate limit, a server error, or a token without `actions: read`. |

A job that never started has a failed, `startup_failure` or `cancelled`
conclusion, zero steps, and no runner. A billing-blocked run has exactly this
shape. A run cancelled after a job failed with steps is still `red`.

The default branch is squash-merged and linear. A green run on one commit
therefore verifies that commit and every older commit. `main-status` reports
the last green commit and the **debt**: every `red`, `unverified` or `unknown`
commit newer than it. If the runs list cannot be read, every commit is
`unknown`. Unknown is never verified.

### When CI does not run

A private repository can reach its GitHub Actions spending limit. Then each run
fails before a step runs. That run is `unverified`. It never verifies a commit
and it never raises an alarm.

The spot check reads the newest completed run on the default branch. CI is
`available` only when that run is green or red and tested one of the last 10
first-parent commits. An older run says nothing about the recent merges, so CI
is then `unavailable`. CI is also `unavailable` when there is no completed run,
or the newest one is `unverified`. If the runs cannot be read, CI is `unknown`,
never `available`, and the normal `rate` applies.

While CI is `unavailable`, nothing off your machine checks an attestation after
the merge. So the spot check uses `rate_when_ci_unavailable`, and by default
every attested pull request is verified explicitly.

`main-status --local` runs the local-attest matrix on the default-branch tip in
a temporary worktree and removes the worktree after. It runs repository code as
you: the config module, the lifecycle scripts of the install, and every leg.
So it needs the repository on the [trust allowlist](./hooks.md), or
`--allow-project-commands` for one run. It installs from the lockfile with the
same table as `/merge-pr`. With no supported lockfile, it installs nothing and
says so. Its result is labelled "local (same machine as the agent; weaker than
CI)" and it never verifies a commit.

### The contradiction alarm

A real failure on code whose attestation said pass is the evidence this layer
detects. It is not proof of a forgery, and a forgery can avoid it (see the
limits below). Two places look for it:

- **The `contradiction` job** in `.github/workflows/test.yml` runs only when the
  test job failed on a push to the default branch. It classifies its own run. A
  red run can come from any commit since the last green run. So the job checks
  every pull request merged in that first-parent range, at most 20 commits. Each
  one with a trusted, passing attestation for its head is a suspect. The job
  adds the label `attestation-contradicted` to each suspect and opens one issue
  for the failing commit. The issue names the range and every suspect. A hidden
  marker stops a second issue for the same failing commit. In CI, only an issue
  that the workflow opened counts, and a closed one is reopened with a comment.
- **`/merge-pr`**, when a spot-checked pull request really fails its explicit
  run, stops and runs `dotbabel pr-stack contradiction --pr <N> --local-failure --post`.

The trust list comes from the merge commit's first parent, never from the
merge commit, which the pull request controls. A first parent with no
`.dotbabel.json` uses `["OWNER"]`. One that cannot be read or does not parse
stops the command with exit `2`.

An attestation comment that was edited after it was posted still counts, and
the issue says that it was edited. The merge gate refused edited comments at
merge time, so an edit after the merge is a warning sign.

The job runs the detector from the first parent (`github.event.before`). The
merged pull request therefore cannot change the detector code that judges it.
GitHub still reads the workflow file itself from the pushed commit. So list
the workflow file in `attestation.governance_files`: then a pull request that
changes it must take the explicit path.

A contradiction is not proof of forgery. The issue lists the possible causes:

- The attestation is forged or wrong. A real run did not produce it.
- A test is flaky, or the attesting machine and the run differ.
- The merged tree differs from the attested head. A squash merge applies the
  diff to the base as it was at merge time.

Find the cause before you trust another attestation from the same source.

### Limits

This layer detects. It does not prevent, and it can be avoided:

- The spot check does not stop a forged attestation that it does not select.
  The alarm comes later, from the push run on the default branch.
- The roll is predictable. An agent can compute it and choose a head that is
  not selected. `always_paths` does not depend on the roll.
- The explicit run and `main-status --local` run on the same machine, as the
  same user, as the agent. A determined agent can fake them too.
- An agent can bypass `/merge-pr` and call `gh pr merge` directly.
- The spot-check log and the run receipt are self-reported. They are logs, not
  evidence.
- The push run on the default branch is the only check off the agent's
  machine. It detects a contradiction only when it runs to completion, on
  unchanged detector code, while the attestation comment exists. These stop
  it:
  - A `[skip ci]` marker in the merge message. GitHub then starts no push run.
  - A cancelled run. A cancel before any job fails gives `unverified`.
  - A deleted attestation comment, or an edit that removes the attestation.
  - A change to the workflow file. GitHub reads it from the pushed commit.
    `governance_files` makes such a change take the explicit path.
- In the first two cases, `main-status` still shows the commit as
  `unverified` debt, but no alarm opens.
- When the default branch is already red at the first parent, the job raises
  no new alarm. It prints why and exits `0`. A forgery that merges onto a red
  branch shows only as debt.
- The push run exists only while the repository has Actions minutes.

## Doctor findings

`dotbabel doctor` checks the policy against the config whenever `.dotbabel.json`
exists. It loads `.local-attest.config.mjs` (which executes that file) only when the
repository is on the [trust allowlist](./hooks.md); otherwise it says the legs were
not inspected. A `.local-attest.config.json` or `package.json#local-attest` config is
data and is always read.

| Level | Code                      | What is wrong, and the fix                                                                                          |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| fail  | `NO_CONFIG`               | Enforcement is on and nothing can produce evidence, so every merge is blocked. Add a config.                        |
| fail  | `CONFIG_UNGOVERNED`       | The file that defines the matrix is not in `governance_files`, so a pull request can rewrite its own legs. Add it.  |
| fail  | `REQUIRED_LEG_UNKNOWN`    | `required_legs` names a leg the matrix lacks, so every merge is blocked. Fix the name or add the leg.               |
| fail  | `GOVERNANCE_PATH_INVALID` | An entry in `governance_files` is not a plain relative path. Fix it on the base branch.                             |
| fail  | `CONFIG_INVALID`          | The config does not load or validate. The message says why.                                                         |
| warn  | `NO_REQUIRED_LEGS`        | `required_legs` is empty, so any attestation is accepted whatever it contained.                                     |
| warn  | `REQUIRED_LEG_SKIPPABLE`  | Every required leg can skip (path filter or `scope`). A PR that skips them all is blocked. Require a leg that runs. |
| warn  | `LEG_COMMAND_UNGOVERNED`  | A leg runs a package script and `package.json` is not governed.                                                     |
| warn  | `GOVERNED_FILE_MISSING`   | A `governance_files` entry does not exist. It is probably misspelled and governs nothing.                           |
| warn  | `LEGS_UNINSPECTED`        | The config is executable and the repository is not trusted. Run `dotbabel project-init --trust`.                    |
| warn  | `POLICY_UNREADABLE`       | `.dotbabel.json` does not parse. The gate reads that as no policy.                                                  |
| info  | `ATTESTATION_OFF`         | Enforcement is off. Nothing is wrong.                                                                               |

Doctor exits `1` when any finding is `fail`. Warnings never change the exit code.
