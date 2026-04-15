Review a pull request: fetch comments, validate, apply fixes, resolve conflicts, and close out all threads.

Argument: $ARGUMENTS — PR number (required). Example: `/review-pr 42`

## Workflow

### 1. Fetch PR details

```bash
gh pr view $NUMBER --json number,title,headRefName,baseRefName,body,mergeable,mergeStateStatus,additions,deletions
```

### 2. Collect ALL review comments

```bash
gh pr view $NUMBER --json reviews,comments
gh api repos/{owner}/{repo}/pulls/$NUMBER/comments
gh api repos/{owner}/{repo}/pulls/$NUMBER/reviews
```

List every comment with: author, body, file path + line (if applicable), and state (pending/resolved).

### 3. Validate each comment

For each review comment:
- Read the relevant file and surrounding code context
- Determine: is this a **valid issue** (real bug, style violation, missing edge case, legit improvement) or a **false positive** (nitpick that's wrong, misunderstanding of intent, outdated concern)?
- Classify as: `✅ valid — will fix` or `⚠️ false positive — will explain`

### 4. Reply to each comment on GitHub

For valid issues:
```bash
gh api repos/{owner}/{repo}/pulls/$NUMBER/comments/<comment_id>/replies -f body="Agreed — fixing this now."
```
For false positives:
```bash
gh api repos/{owner}/{repo}/pulls/$NUMBER/comments/<comment_id>/replies -f body="<concise explanation of why this is not an issue>"
```

### 5. Apply fixes (in an isolated worktree, never on the caller's branch)

```bash
git fetch origin "pull/$NUMBER/head:pr-$NUMBER"
if [ ! -d ".claude/worktrees/pr-$NUMBER" ]; then
  git worktree add ".claude/worktrees/pr-$NUMBER" "pr-$NUMBER"
fi
```

Work exclusively inside `.claude/worktrees/pr-$NUMBER/`. Do **not** use `gh pr checkout`, `git checkout`, or `git stash` — these modify the caller's working tree.

- Apply all fixes for valid comments, TDD-first (failing test → fix → green).
- Detect and run the project test suite:
  - `Makefile` with `test` target → `make test`
  - `package.json` → `npm test` (or `pnpm`/`yarn` per lockfile)
  - `go.mod` → `go test ./...`
  - `pyproject.toml` → `pytest` (or `uv run pytest`)
- Commit with a clear message referencing the review (e.g., `fix: address PR review — <summary>`).
- Push to the PR branch. If the push fails (branch protection, network, non-fast-forward), **stop**: do not post replies or resolve threads — the remote does not yet have the commits the replies reference.

Leave the worktree in place when done. Print the cleanup command:
```bash
git worktree remove .claude/worktrees/pr-$NUMBER
```

### 6. Security review

After applying fixes (and before pushing), run the security review skill on the PR diff:
```
/security-review $NUMBER
```

If it flags real issues:
- Fix them in the same branch
- Add to the commit message (e.g., `fix: address PR review + security findings`)
- Note them in the summary under a **Security** column

If all findings are false positives, note "security: clean" in the summary.

### 7. Check for merge conflicts

```bash
gh pr view $NUMBER --json mergeable,mergeStateStatus
```

If there are conflicts:
- Rebase onto the base branch: `git rebase <base>`
- Resolve conflicts (prefer the PR branch's intent, integrate base branch updates)
- Force-push the rebased branch only with explicit user confirmation
- Verify the build still passes after rebase

### 8. Check failed CI pipelines

```bash
gh pr checks $NUMBER --json name,state,bucket,link
```

For any check with `bucket: "fail"`:
1. Fetch the logs:
   ```bash
   gh run list --branch <headRefName> --limit 3 --json databaseId,status,conclusion,name
   gh run view <runId> --log-failed
   ```
2. Identify the root cause (test failure, lint error, build error, flaky, missing env var).
3. If the fix is straightforward: apply it on the PR branch, include in the review commit, note "CI fix: <description>" in the summary.
4. If the failure is infrastructure/flaky: re-trigger with `gh run rerun <runId> --failed`, note "CI: re-triggered flaky <jobName>" in the summary.
5. If the failure requires design decisions or is out of scope: leave a PR comment explaining it, note "CI: blocked — <reason>" in the summary.

### 9. Verify the test plan

If the PR body has a `## Test plan` section, run each listed command locally from inside `.claude/worktrees/pr-$NUMBER/`. Mark each as:
- `✓ local` — ran and passed
- `✗ failed` — ran and failed (fix before proceeding)
- `skipped` — requires infra/services not available locally

If the PR body has no `## Test plan` section: leave a comment asking the author to add one and note `test-plan: missing` in the summary.

After a passing run, post the evidence as a PR comment:
```bash
gh pr comment $NUMBER --body "Test plan verified against HEAD <sha>:
- \`<command>\` — local ✓ (<ms>ms)
..."
```

### 10. Resolve all review threads

After fixes are pushed, resolve every addressed review thread:
```bash
# Fetch thread IDs
gh api graphql -f query='query {
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: $NUMBER) {
      reviewThreads(first: 50) {
        nodes { id isResolved comments(first: 1) { nodes { body path } } }
      }
    }
  }
}'

# Resolve each addressed unresolved thread
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "<thread_id>"}) { thread { isResolved } } }'
```

Do NOT use `minimizeComment` — that hides comments instead of resolving them. Always use `resolveReviewThread` with a thread ID starting with `PRRT_`.

### 11. Summary report

Output a table:

| PR | Title | Comments | Valid | False Pos | Fixed | Security | CI | Test Plan | Conflicts | Status |
|----|-------|----------|-------|-----------|-------|----------|----|-----------|-----------|--------|

A PR may only be marked `reviewed` if:
- The §5 push succeeded
- All auto-runnable test plan commands passed (or test plan was missing — flagged)
- No unresolved CI failures remain

Otherwise the row status is `blocked`, `push-failed`, or `test-plan-missing` and the blocker is called out.

End with the commit pushed, the worktree cleanup command, and any remaining action items.
