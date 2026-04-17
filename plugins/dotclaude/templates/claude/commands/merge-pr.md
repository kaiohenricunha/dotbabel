---
id: merge-pr
name: merge-pr
type: command
version: 1.0.0
domain: [devex]
platform: [github-actions]
task: [review, testing]
maturity: validated
description: >
  Merge a pull request only after full local verification, with a data-regression gate for PRs touching data/calibration/rankings.
argument-hint: "[PR#]"
model: sonnet
---

Merge a pull request only after full local verification, with a data-regression gate for PRs touching data/calibration/rankings.

Trigger: when the user asks to merge a PR, especially one that modifies data files, calibration logic, or ranking output. Also triggered directly via `/merge-pr <N>`.

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
   - If the repo uses spec IDs (check for `specs/` or `docs/specs/` dir), must contain `Spec ID:`
     If any are missing, STOP and ask the user whether to auto-append them via `gh pr edit <N> --body-file`.

3. **Checkout the branch in an isolated worktree.**

   ```bash
   git fetch origin
   git worktree add /tmp/merge-pr-<N> origin/<headRefName>
   cd /tmp/merge-pr-<N>
   ```

   Never mutate the user's active working directory.

4. **Run the full project test suite.** Detect runner:
   - `Makefile` with `test` → `make test`
   - `package.json` → `npm test` (or `pnpm` / `yarn` based on lockfile)
   - `go.mod` → `go test ./...`
   - `pyproject.toml` → `pytest` or `uv run pytest`

   Paste the tail of output (last ~40 lines) regardless of pass/fail.

5. **Data-regression gate.** If any changed file matches `data/**`, `**/calibration/**`, `**/rankings/**`, `**/fixtures/**`:

   ```bash
   git diff origin/<baseRefName>...HEAD -- <matched-paths>
   ```

   Summarize: rows added/removed, numeric deltas >1%, schema changes. If anything looks load-bearing, STOP and surface the diff before proceeding.

6. **Interpret failures honestly.** If the test suite fails:

   ```bash
   git stash
   <test-command>
   git stash pop
   ```

   Report whether the failure is pre-existing on `origin/<baseRefName>` or introduced by this PR. **Do not assert "pre-existing" without running this proof.**

7. **Verify CI is green.**

   ```bash
   gh pr checks <N>
   ```

   If any check is `failing` or `pending`, STOP and wait or ask the user.

8. **Request merge confirmation from the user.** Show:
   - Summary of local test result
   - Data-regression findings
   - CI status
   - The exact merge command you will run
     Wait for the user to say "merge" (or equivalent).

9. **Merge.**
   ```bash
   gh pr merge <N> --squash --delete-branch
   ```
   Then clean up the worktree:
   ```bash
   cd -
   git worktree remove /tmp/merge-pr-<N>
   ```

## Rules

- Never skip the full test suite, even if CI is green — CI config drift is real.
- Never claim a failure is "pre-existing" without the `git stash` proof.
- Never merge without explicit user confirmation. CI green alone is not authorization.
- Never force-push; never merge into `main`/`master` with failing local tests.
- Clean up temporary worktrees after merge, even on failure paths.
