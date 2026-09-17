---
id: merge-pr
name: merge-pr
type: command
version: 1.0.0
domain: [devex]
platform: [github-actions]
task: [review, testing]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-09-13
description: >
  Merge a pull request only after full local verification and a passing quality gate.
argument-hint: "[PR#]"
model: sonnet
---

Merge a pull request only after full local verification and a passing quality gate.

Trigger: when the user asks to merge a PR. Also triggered directly via `/merge-pr <N>`.

Arguments: `$ARGUMENTS` — the PR number (e.g. `125`). If missing, ask the user which PR.

## Steps

1. **Fetch PR metadata.**

   ```bash
   gh pr view <N> --json number,title,author,headRefName,baseRefName,body,labels,files,mergeable,mergeStateStatus,statusCheckRollup
   ```

   Record: branch name, changed files, CI status, mergeable status.

2. **Verify PR body has required sections.**
   - Must contain `## Summary`
   - Must contain `## Test plan`
   - If the repo uses spec IDs (a `specs/` or `docs/specs/` dir), or the PR changes a protected path from `docs/repo-facts.json`, must contain a `## Spec ID` section or a `## No-spec rationale` section. `dotbabel pr-stack gate --gate merge` accepts either one. A Spec ID must name an approved, implementing, or done spec, and it does not cover a changed protected path that is missing from that spec's `linked_paths`. In both of those cases, use the rationale.
     If any are missing, STOP and ask the user whether to auto-append them via `gh pr edit <N> --body-file`.

3. **Run the merge gate and read every reason.**

   ```bash
   dotbabel pr-stack gate --gate merge --pr <N>
   ```

   This reads GitHub and the git object store, so it works from your own
   checkout. Any criteria reason other than `CRITERIA_EVIDENCE_STALE`
   (`CRITERIA_FAILED`, `CRITERIA_EVIDENCE_MISSING`, `CRITERIA_SCOPE_WEAKENED`,
   `CRITERIA_BASE_UNREADABLE`, …) is a real failure: **STOP** and report it.
   Never merge past a criteria reason, and never hand-write the evidence marker
   — `guard-criteria-evidence.sh` blocks that, because the gate cannot tell a
   hand-written marker from one the tool derived from a real run.

   `CRITERIA_EVIDENCE_STALE` alone is recoverable: trusted evidence exists but
   names an earlier commit, usually because something pushed after `/review-pr`
   ran. Carry it to step 5 — re-verifying needs the PR head checked out, which
   has not happened yet.

4. **Checkout the branch in an isolated worktree.**

   ```bash
   git fetch origin
   git worktree add /tmp/merge-pr-<N> origin/<headRefName>
   cd /tmp/merge-pr-<N>
   ```

   Never mutate the user's active working directory.

5. **Re-verify criteria if step 3 reported `CRITERIA_EVIDENCE_STALE`.**

   Run this from the worktree step 4 created, not from your own checkout:
   `dotbabel criteria verify` fails closed unless the worktree is clean and
   local `HEAD` equals the PR head (`plugins/dotbabel/src/criteria/preconditions.mjs`).

   ```bash
   dotbabel criteria verify --pr <N> --post
   dotbabel pr-stack gate --gate merge --pr <N>
   ```

   Read the verify exit code before drawing any conclusion:

   - `0` — evidence re-posted against the current head. Continue.
   - `1` — a criterion actually fails. **STOP**; this is not a staleness problem.
   - `2` — an environment problem: missing trust, a dirty worktree, a `HEAD`
     that still differs from the PR head. Report _that_, and do not describe it
     as a moving head.

   Re-verify **once**. If the gate still reports `CRITERIA_EVIDENCE_STALE` after
   a clean `0`, the head really is moving under you — stop and say so rather
   than looping.

6. **Run the full project test suite.** Detect runner:
   - `Makefile` with `test` → `make test`
   - `package.json` → `npm test` (or `pnpm` / `yarn` based on lockfile)
   - `go.mod` → `go test ./...`
   - `pyproject.toml` → `pytest` or `uv run pytest`

   Paste the tail of output (last ~40 lines) regardless of pass/fail.

7. **Quality gate.** Run the PR quality profile against the base branch:

   ```bash
   dotbabel quality check --profile pr --base origin/<baseRefName>
   ```

   Exit code `1` means a checked rule failed. Exit code `2` means required evidence, trust, or tooling is unavailable. **STOP** for either exit code and surface the result — do not merge past it. Any other non-zero exit also means the gate did not run — `64` is invalid usage, and `127` is `dotbabel` not installed, which is the normal state on the bootstrap-only install path (see the top of `CLAUDE.md`). **STOP** there too, say which exit you got, and never report an unrun gate as a pass. Exit `0` means no error verdict; continue to step 8.

   Expect exit `2` on the first run: step 4 put you in a throwaway `/tmp/merge-pr-<N>` worktree, and project-command trust matches the repository path exactly, so a fresh worktree is never trusted. Resolve it deliberately, per PR — read the branch's own diff to `.dotbabel.json` and to any `package.json` scripts the tools invoke, then either trust that one path or run this step from your own checkout of the branch. Do not reach for a blanket `--allow-project-commands` here: in this flow it would execute commands defined by the pull request under review.

8. **Interpret failures honestly.** If the test suite fails:

   ```bash
   git stash
   <test-command>
   git stash pop
   ```

   Report whether the failure is pre-existing on `origin/<baseRefName>` or introduced by this PR. **Do not assert "pre-existing" without running this proof.**

9. **Verify CI is green.**

   ```bash
   gh pr checks <N>
   ```

   If any check is `failing` or `pending`, STOP and wait or ask the user.

10. **Re-run the merge gate, then request confirmation from the user.**

    Steps 6-9 can legitimately push — a test fix, a CI fix, a rebase for
    `BEHIND`. Criteria evidence is pinned to a SHA, so the step 3 verdict only
    ever described the head it saw. Re-gate immediately before the
    irreversible action rather than trusting a verdict several steps old:

    ```bash
    dotbabel pr-stack gate --gate merge --pr <N>
    ```

    Then show:

- Summary of local test result
- Quality gate result
- CI status
- The exact merge command you will run
  Wait for the user to say "merge" (or equivalent).

11. **Merge — with an explicit, marker-free squash subject AND body.**
    The default squash body concatenates the branch's commit messages, and —
    the sneakier half — on a **single-commit PR** the default squash _subject_
    is that commit's subject line, not the PR title. Every intermediate commit
    carries `[skip ci]` (the conductor requires it), GitHub honors the marker
    **anywhere** in the final message including line 1, and release-please is
    a push-triggered workflow — so a default merge silently suppresses the
    release for its own commits. Pass both halves explicitly, built from the
    PR title and description with any CI-suppression markers stripped:

    ```bash
    STRIP='s/\[skip ci\]//g; s/\[ci skip\]//g; s/skip-checks: *true//g'
    SUBJ="$(gh pr view <N> --json title -q .title | sed "$STRIP") (#<N>)"
    gh pr view <N> --json body -q .body | sed "$STRIP" > /tmp/merge-pr-<N>-body.md
    gh pr merge <N> --squash --delete-branch \
      --subject "$SUBJ" --body-file /tmp/merge-pr-<N>-body.md
    ```

    Afterwards, verify the merge commit is marker-free — this exact flow has
    been beaten three ways (body, then subject) and the check is one line:

    ```bash
    git log --format=%B -1 <merge-sha> | grep -nE '\[skip ci\]|\[ci skip\]|skip-checks' \
      && echo "SUPPRESSED — run: gh workflow run release-please.yml --ref main" \
      || echo "clean"
    ```

    Then clean up the worktree:

    ```bash
    cd -
    git worktree remove /tmp/merge-pr-<N>
    ```

## Rules

- Never skip the full test suite, even if CI is green — CI config drift is real.
- Never let a squash merge carry a `[skip ci]` / `[ci skip]` / `skip-checks:` marker into main's history — it suppresses push-triggered workflows (release-please included) for the merge itself. Step 11's explicit `--subject`/`--body-file` flow exists for exactly this; the single-commit-PR default subject is the trap that bites after the body is fixed.
- Never claim a failure is "pre-existing" without the `git stash` proof.
- Never merge without explicit user confirmation. CI green alone is not authorization.
- Never force-push; never merge into `main`/`master` with failing local tests.
- Clean up temporary worktrees after merge, even on failure paths.
