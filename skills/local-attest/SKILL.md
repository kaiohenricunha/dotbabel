---
id: local-attest
name: local-attest
type: skill
version: 1.0.0
domain: [devex, observability]
platform: [github-actions]
task: [testing, runtime-ops]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-23
updated: 2026-05-23
description: >
  Run the configured CI matrix locally and, on a clean pass, post a SHA-pinned
  OWNER-authored PR comment that gates downstream GitHub Actions jobs off for
  that exact commit. Skips the redundant remote run after a maintainer has
  already verified locally, saving runner minutes without weakening the gate.
  A new push changes the head SHA, the attestation stops matching, CI runs
  again. Side-effectful (posts a PR comment, applies a label, optionally pushes)
  and slow (10–15 min depending on matrix). Invoke only on explicit request.
argument-hint: "[--pr <N>] [--no-push] [--dry-run] [--config <path>]"
tools: Bash
disable-model-invocation: true
user-invocable: true
---

# /local-attest — Local CI attestation

Run the project's configured CI matrix on your machine. On a clean pass, post
a hidden marker comment to the open PR so the remote `Test` / `Preview` jobs
read the marker and skip themselves for that exact commit.

> **This skill is side-effectful and slow.** It runs every leg of your CI
> matrix sequentially (typically 10–15 minutes), posts a PR comment, applies
> a label, and pushes the current branch. Invoke only when you've decided to
> attest a specific PR.

## Quick start

```bash
# In a project root with a .local-attest.config.mjs
dotbabel local-attest --pr 123

# Try a config without posting anything:
dotbabel local-attest --pr 123 --dry-run

# Run + post + label, but do not git push (useful for offline review):
dotbabel local-attest --pr 123 --no-push
```

## Prerequisites

- **A `.local-attest` config** in the project root — see
  [references/config.md](references/config.md) for the schema and three example
  configs (Node-only, Node + Go monorepo, Python).
- **A workflow gate** wired into your `.github/workflows/test.yml` (and any
  other pipeline you want to skip). Paste the snippet from
  [references/workflow-gate.yml.tmpl](references/workflow-gate.yml.tmpl). This
  is a one-time manual setup — auto-injecting YAML across diverse CI layouts
  is too risky to do for you.
- **A clean worktree** — the skill aborts on any uncommitted change, because
  the attestation must certify the exact tree that gets pushed. (Configurable
  via `requireClean: false`, but generally not recommended.)
- **Local HEAD must match the PR head** — the skill aborts if your local
  branch tip differs from the remote PR head. Push any local commits first.
- **`gh` authenticated** as a user whose `author_association` is in your
  config's `trustedAssociations` list (default: `["OWNER"]`).
- **Docker running** if your config sets `requireDocker: true`.

## How the gate works

The gate input is a PR comment authored by a trusted user (default: the repo
OWNER) whose **first line** is exactly:

```text
<!-- local-attest verified-sha=<full-head-sha> -->
```

The CI workflow reads PR comments, applies a `jq select(.author_association == "OWNER")`
filter, takes the first line of each, and `grep -qF`s for the marker that
matches `github.event.pull_request.head.sha`. When it matches, every downstream
job's `if:` evaluates false and skips at zero runner cost.

Freshness is automatic: a new push changes the head SHA, the old comment no
longer matches, CI runs again. Editing or deleting the comment does **not**
re-trigger CI (the gate only re-evaluates on `push`/`synchronize`). If you
need to revoke an attestation, push any new (even empty) commit.

Full operator contract: [references/operator-guide.md](references/operator-guide.md).

## What the skill does, in order

1. **Preconditions.** Branch exists, worktree clean (if `requireClean`), local
   HEAD == PR head, `gh` authed, Docker available (if `requireDocker`). Any
   failure aborts before a single test runs. The skill also warns (does not
   fail) if your current user's permission level is not in the trust list.
2. **Run matrix.** Each leg from the config runs sequentially. Hard legs must
   pass to attest; advisory legs are reported but never block. Stdout + stderr
   are tailed at 10 lines per leg so the result table stays readable.
3. **Hard-leg gate.** Any hard failure aborts: no comment, no label, no push.
4. **Push first** (if `pushAfterAttest` and not `--no-push`). The attestation
   must never describe a SHA the remote hasn't seen.
5. **Upsert comment.** Existing attestation comment (any SHA) is PATCHed in
   place; otherwise a new one is POSTed. Body always goes via `gh api --input -`
   so multiline markdown can't be mangled by shell quoting.
6. **Apply label** (default `ci/local-verified`). Best-effort; failure warns
   but does not abort.
7. **Append audit log line** to the configured `auditLogPath` (default
   `.local-attest-log.jsonl`). Best-effort.

## Flags

| Flag              | Effect                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--pr <N>`        | Target PR number. Defaults to the open PR for the current branch.                                                                            |
| `--no-push`       | Run matrix + post + label, but skip `git push`.                                                                                              |
| `--dry-run`       | Run matrix, render the comment, print it. Post nothing, label nothing, push nothing. Use this to validate a new project's config end-to-end. |
| `--config <path>` | Override config discovery.                                                                                                                   |

## What this skill never does

- **Auto-install the workflow gate.** Paste it manually using the template.
- **Skip the Secret-scan job** (or any other gate you didn't put behind the
  attestation `if:`). Configure each workflow's `if:` explicitly.
- **Merge or deploy.** It only attests and pushes the current branch.
- **Multiple comments per PR.** One attestation comment, upserted in place.
- **Auto-unlabel on stale attestation.** A new push silently invalidates the
  prior attestation by SHA mismatch; the label stays as audit decoration.

## Trust model

Default `trustedAssociations: ["OWNER"]`. Only comments from the repo OWNER
will gate CI. A non-trusted user's comment will post (and the label may apply)
but CI will still run. Widen the trust list in your config for multi-maintainer
repos:

```js
trustedAssociations: ["OWNER", "MEMBER", "COLLABORATOR"];
```

The generated workflow gate snippet ([references/workflow-gate.yml.tmpl](references/workflow-gate.yml.tmpl))
automatically matches the configured list.
