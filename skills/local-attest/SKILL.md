---
id: local-attest
name: local-attest
type: skill
version: 1.2.0
domain: [devex, observability]
platform: [github-actions]
task: [testing, runtime-ops]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-23
updated: 2026-08-14
description: >
  Run the configured CI matrix locally and, on a clean pass, post a SHA-pinned
  OWNER-authored PR comment that gates downstream GitHub Actions jobs off for
  that exact commit. Skips the redundant remote run after a maintainer has
  already verified locally, saving runner minutes without weakening the gate.
  A new push changes the head SHA, the attestation stops matching, CI runs
  again. Side-effectful (posts a PR comment, applies a label, optionally pushes)
  and slow — minutes to tens of minutes, whatever the configured matrix costs.
  Diagnostic modes (--only, --from) run subsets for the fix-retry loop and can
  never attest; --fail-fast works in both modes. Invoke only on explicit request.
argument-hint: "[--pr <N>] [--no-push] [--dry-run] [--fail-fast] [--only <leg>] [--from <leg>] [--config <path>]"
tools: Bash
disable-model-invocation: true
user-invocable: true
---

# /local-attest — Local CI attestation

Run the project's configured CI matrix on your machine. On a clean pass, post
a hidden marker comment to the open PR so the remote `Test` / `Preview` jobs
read the marker and skip themselves for that exact commit.

> **This skill is side-effectful and slow.** It runs every leg of your CI
> matrix — serially within a lane, lanes in parallel; minutes to tens of
> minutes, whatever the configured matrix costs — posts a PR comment, applies
> a label, and pushes the current branch. Invoke only when you've decided to attest a specific PR. For the
> fix-retry loop, use the diagnostic modes below instead: they run subsets,
> tolerate a dirty tree, and are structurally unable to attest.

## Quick start

```bash
# In a project root with a .local-attest.config.mjs
dotbabel local-attest --pr 123

# Try a config without posting anything:
dotbabel local-attest --pr 123 --dry-run

# Run + post + label, but do not git push (useful for offline review):
dotbabel local-attest --pr 123 --no-push

# Iterate on a fix: run one leg, dirty tree fine, no PR needed, never attests:
dotbabel local-attest --only lint

# Re-run the matrix from the leg that failed, stopping at the first hard failure:
dotbabel local-attest --from bats --fail-fast
```

## Diagnostic modes — the fix-retry loop

`--only <leg>` (repeatable or comma-separated) and `--from <leg>` run a subset
of the matrix under relaxed preconditions: any git repo state is fine (dirty
tree, detached HEAD, no PR — iterating is the point), Docker and toolchain
problems warn instead of failing. Leg names match exactly and case-sensitively;
an unknown name lists every valid leg. The two flags are mutually exclusive.

A diagnostic run **never** posts, labels, or pushes. Two mechanisms stack:
the diagnostic branch in `execute` returns before the publication path even
exists (and the attest branch always runs the full config matrix), and the
`shouldAttest` predicate that gates publication receives the diagnostic flag
plus the expected leg count, so a subset record is rejected even if the
branch wiring were ever wrong. Exit is 1 when **any** selected leg fails,
advisory legs included, because there is no attestation gate to grade against
and `--only <advisory-leg>` exiting 0 on a failure would be useless in a loop.

Subsets get exactly what they name — no dependency injection. `--from` a leg
that reads a build artifact measures whatever artifact is lying around.

`--fail-fast` works in both modes: the first **hard** failure stops launching
further legs, which are recorded `not run (fail-fast)` — never as passes. A
full run with `--fail-fast` where nothing failed completed the whole matrix
and attests normally; one that stopped early cannot.

## Prerequisites

- **A `.local-attest` config** in the project root — see
  [references/config.md](references/config.md) for the schema and three example
  configs (Node-only, Node + Go monorepo, Python). Discovery order:
  `.local-attest.config.mjs` → `.local-attest.config.json` → `package.json#local-attest`.
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
- **`auditLogPath` gitignored** (default `.local-attest-log.jsonl`). Every
  run appends to it — including `--dry-run` — so with `requireClean` on, an
  untracked log makes the next attest abort on the tool's own output.

## How the gate works

The gate input is a PR comment authored by a trusted user (default: the repo
OWNER) whose **first line** is exactly:

```text
<!-- local-attest verified-sha=<full-head-sha> -->
```

The CI workflow reads PR comments, applies a `jq select(.author_association == "OWNER")`
filter, takes the first line of each, and `grep -qFx`s (exact-line match)
for the marker that matches `github.event.pull_request.head.sha`. When it matches, every downstream
job's `if:` evaluates false and skips at zero runner cost.

Freshness is automatic: a new push changes the head SHA, the old comment no
longer matches, CI runs again. Editing or deleting the comment does **not**
re-trigger CI (the gate only re-evaluates on `push`/`synchronize`). If you
need to revoke an attestation, push any new (even empty) commit.

Full operator contract: [references/operator-guide.md](references/operator-guide.md).

## What the skill does, in order

1. **Preconditions.** Branch exists, worktree clean (if `requireClean`), local
   HEAD == PR head, `gh` authed, Docker available (if `requireDocker`), and the
   running toolchain matches `config.toolchain` pins (if set) — a matrix run on
   a different Node or Go than CI uses certifies a run CI would never perform,
   so a pin mismatch fails closed here. Any failure aborts before a single test
   runs. The skill also warns (does not fail) if your GitHub
   `author_association` on the repo (OWNER / MEMBER / COLLABORATOR, etc.) is
   not in the config's `trustedAssociations` list — the attestation will post
   but CI will ignore it.
2. **Run matrix.** Legs sharing a `lane` run serially in matrix order;
   distinct lanes run concurrently; a config without lanes runs fully
   sequentially. Diff rules (`when.changedPaths`, `skipWhenDiffOnly`) mark
   legs skipped against the PR's changed files — skipped legs still appear in
   every table, and the comment headline says so rather than claiming a full
   run. Hard legs must pass to attest; advisory legs are reported but never
   block. Stdout + stderr are tailed at 10 lines per leg. With `--fail-fast`,
   the first hard failure stops launching further legs in every lane; the
   rest are recorded `not run`, never as passes.
3. **Attestation bar.** Posting is gated on a run-record predicate: every leg
   accounted for — executed or diff-skipped — at least one leg actually
   executed (an all-skipped run has verified nothing and refuses to attest;
   CI's own path filters already skip the same jobs), zero hard fails, not a
   diagnostic subset. A run that fails the bar aborts — no comment, no label,
   no push — and still writes its audit line (`result: "hard-fail"`).
4. **Re-check HEAD.** First, `restoreFiles` snapshots taken before the matrix
   are restored byte-exact (a leg that seeds fixture stubs over tracked files
   would otherwise fail this recheck on its own writes, every run). Then: the
   matrix takes minutes — long enough for another agent
   session, another worktree, or you in a second terminal to commit onto the
   same branch. Step 1's check is stale by now, so HEAD and the worktree are
   re-asserted against what was actually tested. If either moved, everything
   aborts (`result: "head-moved"`): no comment, no label, no push. Without
   this the skill would attest the pre-matrix SHA and then push whatever HEAD
   had become — publishing commits it never tested and labelling the PR
   verified on an unrun head.
5. **Upsert comment.** Existing attestation comment (any SHA) is PATCHed in
   place; otherwise a new one is POSTed — before the push, so the marker is
   already visible when the push event fires GitHub Actions. Body always goes
   via `gh api --input -` so multiline markdown can't be mangled by shell
   quoting.
6. **Push** (if `pushAfterAttest` and not `--no-push`). A failed push records
   `result: "push-fail"`; the comment is already in place, so a bare
   `git push` retry completes the attestation.
7. **Apply label** (default `ci/local-verified`). Best-effort; failure warns
   but does not abort.
8. **Append audit log line** to the configured `auditLogPath` (default
   `.local-attest-log.jsonl`). **Every run whose matrix executes writes
   exactly one line**, tagged `result: attested | hard-fail | head-moved |
push-fail | post-fail | dry-run | diagnostic`, with per-leg
   `{name, mode, status, durationS}` — failures leave a record too, which is
   what makes failure and duration distributions measurable. Lines written by
   older versions have no `result` field and imply `attested`. Best-effort:
   an unwritable log warns but never changes the run's outcome.

## Flags

| Flag              | Effect                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--pr <N>`        | Target PR number. Defaults to the open PR for the current branch.                                                                            |
| `--no-push`       | Run matrix + post + label, but skip `git push`.                                                                                              |
| `--dry-run`       | Run matrix, render the comment, print it. Post nothing, label nothing, push nothing. Use this to validate a new project's config end-to-end. |
| `--fail-fast`     | Stop launching legs after the first hard failure. Unstarted legs record as `not run`; a run that stopped early can never attest.             |
| `--only <leg>`    | Diagnostic mode — run only the named leg(s). Repeatable or comma-separated. Relaxed preconditions; never attests. Exit 1 on any failure.     |
| `--from <leg>`    | Diagnostic mode — run the matrix from the named leg to the end. Mutually exclusive with `--only`.                                            |
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
