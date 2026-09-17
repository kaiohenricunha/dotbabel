# Operator guide — CI skip via local attestation

CI minutes are billed; running the same matrix on GitHub-hosted runners after
a maintainer has already verified the change locally is duplicated spend. The
`/local-attest` skill lets a trusted user trade the local runtime of the
configured matrix — minutes to tens of minutes — for a clean skip of the
equivalent remote pipeline.

This guide is the operator contract for using the skill safely.

## How the gate works

The gate input is a **PR comment authored by a trusted user** (default: the
repo OWNER) whose first line is exactly the marker:

```text
<!-- local-attest verified-sha=<full-head-sha> -->
```

The workflow gate (template at
[`workflow-gate.yml.tmpl`](workflow-gate.yml.tmpl)) reads the PR comments,
filters by `author_association`, takes the first line of each, and
`grep -qFx`s (exact-line match) for the marker matching
`github.event.pull_request.head.sha`.

When the marker matches, downstream jobs whose `if:` consumes
`needs.classify.outputs.attested` skip at zero runner cost.

### Freshness is automatic

A new push changes the head SHA, the old marker no longer matches, and CI
runs again. There is no auto-unlabel workflow; the label is decoration only.

### Editing/deleting the comment does NOT re-trigger CI

GitHub Actions only re-evaluates workflow gates on `push` / `synchronize`
events, not on comment events. If you need to revoke an attestation, **push
a new (even empty) commit** — that's the documented contract.

### Always run, never gate

Some jobs should always run regardless of attestation:

- **Secret scanning** (gitleaks, trufflehog) — never gate.
- **License / SBOM publishing** — always run on push.
- **Required status checks** specified in branch protection — if you gate
  them, make sure your downstream `if:` produces a green check anyway. The
  common shape is "always emit `success` from a downstream summary job, but
  let the upstream attested jobs skip."

## Producing an attestation

From the PR branch in your local checkout:

```bash
dotbabel local-attest --pr 123
```

The skill runs every leg of your `.local-attest` matrix, prints a result
table, posts/PATCHes the attestation comment, pushes (if `pushAfterAttest` —
the comment goes first so the marker is visible when the push event fires),
applies the label, and appends a line to the audit log.

`--dry-run` runs the matrix and prints the comment without posting anything.
Use it to validate a new config end-to-end. (Combined with `--only`/`--from`
it is inert — diagnostic runs never post anyway.)

`--no-push` skips the `git push` step but still posts the comment + label.
Use it when you've pushed manually and just want to attest.

`--fail-fast` stops launching legs after the first hard failure; unstarted
legs are recorded `not-run` and a stopped run cannot attest. A `--fail-fast`
run in which nothing failed completed the full matrix and attests normally.

`--only <leg>` / `--from <leg>` are diagnostic modes for the fix-retry loop:
subsets under relaxed preconditions (dirty tree fine, no PR needed) that never
post, label, or push, and exit 1 on any selected-leg failure, advisory
included. `restoreFiles` snapshots and restores in diagnostic runs too.

Config-side execution controls (see [config.md](config.md)): `lane` groups
legs into concurrent lanes; `when.changedPaths` and `skipWhenDiffOnly` mark
legs skipped against the PR's changed files (skipped legs still appear in
every table with status `skipped`, and an all-skipped run refuses to attest);
`passPrBody` injects the PR body as `env.PR_BODY`; `restoreFiles` snapshots
tracked files a leg overwrites and restores them before the head recheck.

The restore also runs on `SIGINT`/`SIGTERM`, so a Ctrl-C mid-matrix puts the
files back instead of leaving fixture stubs in the tree. That matters because
`requireClean` is checked _before_ the snapshot is taken: a run killed between
seeding and restoring would otherwise leave every later run aborting on a dirty
tree it can no longer clean up. If that still happens (a `SIGKILL`, a power
loss), the precondition error appends the exact recovery command to the usual
"commit or stash" advice — `git restore` for tracked paths, `git clean` for
any the matrix created. It scopes both to the paths actually dirty, and only
fires when _every_ dirty path is one `restoreFiles` manages: one unrelated
edit alongside the stubs and the message stays generic, because the check
cannot tell a leftover stub from your own work on the same file.

## Trust model

Default `trustedAssociations: ["OWNER"]`. Only comments from a user with
`author_association == "OWNER"` will gate CI. A non-trusted user's comment
will post, but CI will still run.

Multi-maintainer repos widen the trust list:

```js
// .local-attest.config.mjs
trustedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"];
```

The workflow gate template is pre-substituted for the default single-OWNER
config. If you widen `trustedAssociations`, update the `select(...)` clause in
your workflow gate file and commit both changes together — they must stay in sync
or attestations from the newly-trusted association will be posted but never
honored by CI.

## Caveats

### Branch protection unconditional checks

If branch protection requires a specific status check (e.g.
`Test / backend tests`) and you gate that job off via attestation, the check
will be reported as skipped, which counts as missing for protection.

**Fix**: introduce an always-run summary job that aggregates the attested
jobs' results and reports a single status check. Make that summary job the
one required by branch protection. Example:

```yaml
attested-or-passed:
  needs: [test, preview] # jobs gated by local-attest
  if: always()
  runs-on: ubuntu-latest
  steps:
    - run: |
        if [[ "${{ needs.test.result }}" == "skipped" && \
              "${{ needs.preview.result }}" == "skipped" ]]; then
          echo "All CI jobs skipped via local attestation"
        elif [[ "${{ needs.test.result }}" != "success" || \
                "${{ needs.preview.result }}" != "success" ]]; then
          exit 1
        fi
```

Point branch protection's required status check at `attested-or-passed` instead
of the individual jobs.

### Drift between local and remote matrix

The skill runs whatever your `.local-attest.config.mjs` says. If it drifts
from what `.github/workflows/test.yml` actually runs, the attestation
certifies a different (probably smaller) set of checks. Treat the config
file as documentation that has to track the workflow.

A simple drift check is to put both lists in a single source (e.g. a JSON
manifest both sides import) — but most projects find it cheaper to review
the diff manually whenever either side changes.

### Long-running matrices

Attestation runs legs serially within a lane and lanes concurrently (a
config without `lane` fields is fully sequential), and costs whatever the
configured legs cost — minutes for a lint-and-unit matrix, tens of minutes with heavy
e2e and multiple language runtimes. That's the deliberate price of skipping
the remote run; use `--only`/`--from`/`--fail-fast` for iteration and save
full runs for attestation.

### Audit

The label `ci/local-verified` is decoration for visibility:

```bash
gh pr list --label ci/local-verified --state all
```

The audit log (`.local-attest-log.jsonl` by default) records one JSONL line
for **every run whose matrix executes** — failures included — tagged with a
`result` and per-leg statuses:

```json
{
  "ts": "2026-08-13T16:00:00.000Z",
  "pr": 123,
  "sha": "abc1234...",
  "host": "wsl-laptop",
  "advisoryFails": ["knip"],
  "result": "attested",
  "legs": [{ "name": "lint", "mode": "hard", "status": "pass", "durationS": 17 }],
  "flags": { "only": [], "from": null, "failFast": false, "push": true, "dryRun": false },
  "toolchain": { "node": "22.11.0" }
}
```

`result` is one of `attested | hard-fail | head-moved | push-fail | post-fail
| dry-run | diagnostic`; per-leg `status` is one of `pass | fail |
advisory-fail | skipped | not-run`. Lines written by versions before `result` existed
were only ever written after a successful post, so a missing `result` implies
`attested`. Diagnostic lines add `dirty: true|false`, because a dirty tree's
`sha` does not identify the tree that ran.

**Add the audit log to `.gitignore` — this is a requirement when
`requireClean` is on, not a preference.** Every run appends to it, including
the `--dry-run` this guide recommends for validating a new config, so an
untracked log makes the very next attest abort on its own output. The
contract is single-line JSONL so any log shipper handles it natively.

### Drift now has two axes

The classic drift is matrix membership: a CI job with no local leg is
enforced nowhere once a PR attests. Diff rules add a second axis: a local
`when`/`skipWhenDiffOnly` glob narrower than the mirrored job's `paths:`
filter skips the leg locally while the attestation disables the job remotely.
Nothing cross-checks the globs against `.github/workflows/**` — the config
author owns that mirror, and each diff-gated leg should cite the workflow
filter it mirrors in a comment so the pair is reviewable together.
