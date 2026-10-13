# Attestation: verify once per commit, then reuse

_Last updated: v3.4.0_

`dotbabel local-attest` runs your CI matrix on your machine and posts a comment
that names the commit it verified. With enforcement on, `/merge-pr` reads that
comment instead of running the test suite and the quality profile a second time.
The rule is simple: **expensive deterministic evidence is produced once per commit
SHA and reused until that SHA changes.** Everything that can change without the
SHA changing (mergeability, required checks, review threads, your explicit
authorization to merge) is still checked fresh at merge time.

Enforcement is off until you turn it on. A repository that never sets the policy
below behaves exactly as before: `/merge-pr` verifies the branch itself.

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
| `required_legs`        | `[]`                                             | Legs that must be present and passing in the evidence.                                            |
| `governance_files`     | `[".local-attest.config.mjs", ".dotbabel.json"]` | Files whose committed bytes are hashed into every attestation.                                    |
| `trusted_associations` | `["OWNER"]`                                      | GitHub author associations whose attestation is believed. `OWNER`, `MEMBER`, `COLLABORATOR` only. |

`gate --gate merge` reports one state in `attestation.state`:

| State      | Meaning                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified` | Enforcement is on and the evidence is current, trusted, and complete. `/merge-pr` skips its own suite and quality run.                                                       |
| `off`      | The base branch does not enforce. `/merge-pr` verifies explicitly.                                                                                                           |
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
| `ATTESTATION_INCOMPLETE`      | A required leg is missing or did not pass. See `detail` for which.                                     |
| `ATTESTATION_FAILED`          | The attestation verdict is not `pass`.                                                                 |
| `ATTESTATION_BASE_UNREADABLE` | The base commit is not in this clone. Fetch it and re-run.                                             |

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
| `rate_when_ci_unavailable` | `1`     | The share to verify when the latest test run on the default branch did not run.            |
| `always_paths`             | `[]`    | Globs of changed paths that always select the check. Only `**`, `*` and `?` are special.   |

An unknown key or a value outside 0 to 1 stops the command with exit `2`. It
never falls back to the default, because a typo must not lower the check rate.

The roll comes from the head: the first 32 bits of `sha256("<head>:<pr>")`. Run
the command again on the same head and you get the same answer. A new head
gives a new roll, and a new head also makes the attestation stale. Each
decision goes into the run receipt. After the explicit run, `/merge-pr` records
its result with `--record-explicit pass` or `--record-explicit fail`. Use
`spot-check --pr <N> --show` to see both.

### Three run states and the cumulative rule

`dotbabel pr-stack main-status` reads the test workflow's runs on the default
branch. Each run gets one state:

| State        | Meaning                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `green`      | The run succeeded.                                                                                                           |
| `red`        | A job failed after it ran at least one step. The tests really failed.                                                        |
| `unverified` | The run proves nothing: a billing limit, a startup failure, a cancelled or skipped run, a job that never started, or no run. |

The default branch is squash-merged and linear. A green run on one commit
therefore verifies that commit and every older commit. `main-status` reports
the last green commit and the **debt**: every `red` or `unverified` commit
newer than it. If the runs cannot be read (a rate limit, a missing workflow),
every commit is `unknown`. Unknown is never verified.

### When CI does not run

A private repository can reach its GitHub Actions spending limit. Then each run
fails before a step runs, and GitHub adds an annotation such as "The job was
not started because recent account payments have failed or your spending limit
needs to be increased". That run is `unverified`. It never verifies a commit
and it never raises an alarm.

While the latest default-branch run is `unverified`, nothing off your machine
checks an attestation after the merge. So the spot check uses
`rate_when_ci_unavailable`, and by default every attested pull request is
verified explicitly. `main-status --local` runs the local-attest matrix on the
default-branch tip in a temporary worktree and removes the worktree after. Its
result is labelled "local (same machine as the agent; weaker than CI)" and it
never verifies a commit.

### The contradiction alarm

A real failure on code whose attestation said pass is the one fact a forgery
cannot hide. Two places look for it:

- **The `contradiction` job** in `.github/workflows/test.yml` runs only when
  the test job failed on a push to the default branch. It classifies its own
  run, finds the pull request merged as that commit, and checks for a current,
  trusted, passing attestation on that pull request's head. On a
  contradiction, it adds the label `attestation-contradicted` and opens one
  issue that names the pull request, the attested head, and the failed run. A
  hidden marker stops a second issue for the same pull request and head.
- **`/merge-pr`**, when a spot-checked pull request fails its explicit run,
  stops and runs `dotbabel pr-stack contradiction --pr <N> --local-failure --post`.

A contradiction is not proof of forgery. A flaky test or a difference between
the attesting machine and CI also produces one. Find out which before you
trust another attestation from the same source.

### Limits

- The spot check detects. A forged attestation that is not selected still
  merges, and the alarm comes later from the default branch's CI run.
- The roll is predictable. An agent can compute it and choose a head that is
  not selected. `always_paths` does not depend on the roll.
- The explicit run and `main-status --local` run on the same machine, as the
  same user, as the agent. A determined agent can fake them too.
- An agent can bypass `/merge-pr` and call `gh pr merge` directly.
- The run receipt is self-reported. It is a log, not evidence.
- The `push` run of the test workflow on the default branch is the only check
  the agent cannot skip. It exists only while the repository has Actions
  minutes.

## Doctor findings

`dotbabel doctor` checks the policy against the config whenever `.dotbabel.json`
exists. It loads `.local-attest.config.mjs` (which executes that file) only when the
repository is on the [trust allowlist](./hooks.md); otherwise it says the legs were
not inspected. A `.local-attest.config.json` or `package.json#local-attest` config is
data and is always read.

| Level | Code                      | What is wrong, and the fix                                                                                         |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| fail  | `NO_CONFIG`               | Enforcement is on and nothing can produce evidence, so every merge is blocked. Add a config.                       |
| fail  | `CONFIG_UNGOVERNED`       | The file that defines the matrix is not in `governance_files`, so a pull request can rewrite its own legs. Add it. |
| fail  | `REQUIRED_LEG_UNKNOWN`    | `required_legs` names a leg the matrix lacks, so every merge is blocked. Fix the name or add the leg.              |
| fail  | `GOVERNANCE_PATH_INVALID` | An entry in `governance_files` is not a plain relative path. Fix it on the base branch.                            |
| fail  | `CONFIG_INVALID`          | The config does not load or validate. The message says why.                                                        |
| warn  | `NO_REQUIRED_LEGS`        | `required_legs` is empty, so any attestation is accepted whatever it contained.                                    |
| warn  | `REQUIRED_LEG_SKIPPABLE`  | A required leg has a path filter. A pull request that skips it is blocked. Remove the filter or the requirement.   |
| warn  | `LEG_COMMAND_UNGOVERNED`  | A leg runs a package script and `package.json` is not governed.                                                    |
| warn  | `GOVERNED_FILE_MISSING`   | A `governance_files` entry does not exist. It is probably misspelled and governs nothing.                          |
| warn  | `LEGS_UNINSPECTED`        | The config is executable and the repository is not trusted. Run `dotbabel project-init --trust`.                   |
| warn  | `POLICY_UNREADABLE`       | `.dotbabel.json` does not parse. The gate reads that as no policy.                                                 |
| info  | `ATTESTATION_OFF`         | Enforcement is off. Nothing is wrong.                                                                              |

Doctor exits `1` when any finding is `fail`. Warnings never change the exit code.
