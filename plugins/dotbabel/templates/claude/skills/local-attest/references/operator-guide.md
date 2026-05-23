# Operator guide — CI skip via local attestation

CI minutes are billed; running the same matrix on GitHub-hosted runners after
a maintainer has already verified the change locally is duplicated spend. The
`/local-attest` skill lets a trusted user trade ~10–15 minutes of local
runtime for a clean skip of the equivalent remote pipeline.

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
table, pushes (if `pushAfterAttest`), posts/PATCHes the attestation comment,
applies the label, and appends a line to the audit log.

`--dry-run` runs the matrix and prints the comment without posting anything.
Use it to validate a new config end-to-end.

`--no-push` skips the `git push` step but still posts the comment + label.
Use it when you've pushed manually and just want to attest.

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

Attestation runs sequentially. 10–15 minutes is typical; pathologically
slow matrices (heavy e2e + multiple language runtimes) can hit 30+. That's
the deliberate cost of skipping the remote run.

### Audit

The label `ci/local-verified` is decoration for visibility:

```bash
gh pr list --label ci/local-verified --state all
```

The audit log (`.local-attest-log.jsonl` by default) records one JSONL line
per attestation:

```json
{
  "ts": "2026-05-23T16:00:00.000Z",
  "pr": 123,
  "sha": "abc1234...",
  "host": "wsl-laptop",
  "advisoryFails": ["knip"]
}
```

Add the audit log to `.gitignore` if you don't want it in version control;
the contract is single-line JSONL so any log shipper handles it natively.
