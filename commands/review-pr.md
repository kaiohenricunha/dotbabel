---
name: review-pr
description: >
  Review a pull request: fetch comments, validate, apply fixes, resolve conflicts, and close out all threads.
argument-hint: "[PR#]"
---

Review a pull request: fetch comments, validate, apply fixes, resolve conflicts, and close out all threads.

Argument: `$ARGUMENTS` — PR number (required). Example: `/review-pr 42`

## Workflow

Before any step, bind the PR number:

```bash
NUMBER="$ARGUMENTS"
```

### 1. Fetch PR details and check branch health

```bash
gh pr view "$NUMBER" --json number,title,headRefName,baseRefName,body,mergeable,mergeStateStatus,additions,deletions
```

**Immediately inspect `mergeable` and `mergeStateStatus`:**

| `mergeable`   | `mergeStateStatus` | Action                                                                |
| ------------- | ------------------ | --------------------------------------------------------------------- |
| `MERGEABLE`   | `CLEAN`            | Proceed normally                                                      |
| `MERGEABLE`   | `UNSTABLE`         | Proceed — CI failing but no conflict; fix CI in step 10               |
| `MERGEABLE`   | `BEHIND`           | Rebase onto base branch before collecting comments                    |
| `CONFLICTING` | `DIRTY`            | **Rebase first** (step 9) before any other work                       |
| `UNKNOWN`     | any                | Re-fetch after 30 s — GitHub is still computing, do not proceed blind |

If the branch is conflicting or behind, resolve it **before** collecting comments or applying fixes. A stale or conflicting branch produces a misleading diff and stale Copilot comments.

### 2. Collect ALL review comments

```bash
gh pr view "$NUMBER" --json reviews,comments
gh api "repos/{owner}/{repo}/pulls/$NUMBER/comments"
gh api "repos/{owner}/{repo}/pulls/$NUMBER/reviews"
```

(`{owner}` and `{repo}` are substituted automatically by `gh api` from the current git remote.)

List every comment with: author, body, file path + line (if applicable), and state (pending/resolved).

### 3. Validate each comment

For each review comment:

- Read the relevant file and surrounding code context
- Determine: is this a **valid issue** (real bug, style violation, missing edge case, legit improvement) or a **false positive** (nitpick that's wrong, misunderstanding of intent, outdated concern)?
- Classify as: `✅ valid — will fix` or `⚠️ false positive — will explain`

### 4. Reply to false positives immediately

For each false positive, reply now with a concise explanation:

```bash
gh api "repos/{owner}/{repo}/pulls/$NUMBER/comments/<comment_id>/replies" \
  -f body="<concise explanation of why this is not an issue>"
```

Hold replies to valid issues until **after** the push in step 7 — do not acknowledge fixes you haven't yet delivered.

### 5. Apply fixes (in an isolated worktree, never on the caller's branch)

```bash
git fetch origin "pull/$NUMBER/head:pr-$NUMBER"
mkdir -p .claude/worktrees
if [ ! -d ".claude/worktrees/pr-$NUMBER" ]; then
  git worktree add ".claude/worktrees/pr-$NUMBER" "pr-$NUMBER"
fi
```

Work exclusively inside `.claude/worktrees/pr-$NUMBER/`. Do **not** use `gh pr checkout` or `git checkout` — those switch the caller's working tree — and do **not** use `git stash`, because stashes are repo-global and can interfere with the caller's stash list.

- Apply all fixes for valid comments, TDD-first (failing test → fix → green).
- Detect and run the project test suite:
  - `Makefile` with `test` target → `make test`
  - `package.json` → `npm test` (or `pnpm`/`yarn` per lockfile)
  - `go.mod` → `go test ./...`
  - `pyproject.toml` → `pytest` (or `uv run pytest`)
- Commit with a clear message referencing the review (e.g., `fix: address PR review — <summary>`).

Leave the worktree in place when done. Print the cleanup command:

```bash
git worktree remove .claude/worktrees/pr-$NUMBER
```

### 6. Security review

Before pushing, run the security review skill on the PR diff:

```
/security-review $NUMBER
```

If it flags real issues:

- Fix them in the same branch
- Add to the commit message (e.g., `fix: address PR review + security findings`)
- Note them in the summary under a **Security** column

If all findings are false positives, note "security: clean" in the summary.

### 7. Push

Push to the PR branch. If the push fails (branch protection, network, non-fast-forward), **stop**: do not post replies or resolve threads — the remote does not yet have the commits the replies reference.

### 8. Reply to valid comments (after push)

Only after the push succeeds, reply to each valid comment confirming the fix:

```bash
gh api "repos/{owner}/{repo}/pulls/$NUMBER/comments/<comment_id>/replies" \
  -f body="Fixed in <commit-sha> — <one-line description of the fix>."
```

### 9. Check for merge conflicts and staleness

```bash
gh pr view "$NUMBER" --json mergeable,mergeStateStatus,baseRefName
```

If `mergeable` is `CONFLICTING` or `mergeStateStatus` is `BEHIND`:

- Rebase onto the base branch: `git rebase origin/<baseRefName>`
- Resolve conflicts (prefer the PR branch's intent, integrate base branch updates)
- Force-push with `--force-with-lease` only with explicit user confirmation
- Verify the build still passes after rebase
- Do **not** proceed to step 10 until the branch is clean and up-to-date

### 10. Check failed CI pipelines

```bash
gh pr checks "$NUMBER" --json name,state,bucket,link
```

For any check with `bucket: "fail"`:

1. Fetch the logs:
   ```bash
   gh run list --branch <headRefName> --limit 3 --json databaseId,status,conclusion,name
   gh run view <runId> --log-failed
   ```
2. Identify the root cause (test failure, lint error, build error, flaky, missing env var).
3. If the fix is straightforward: apply it on the PR branch, include in the review commit, note "CI fix: \<description\>" in the summary.
4. If the failure is infrastructure/flaky: re-trigger with `gh run rerun <runId> --failed`, note "CI: re-triggered flaky \<jobName\>" in the summary.
5. If the failure requires design decisions or is out of scope: leave a PR comment explaining it, note "CI: blocked — \<reason\>" in the summary.

### 11. Verify the test plan

**If the PR body has no `## Test plan` section:** leave a comment asking the author to add one and note `test-plan: missing` in the summary. Do not proceed to step 12.

**If a `## Test plan` section exists**, first check whether CI has already run and passed every item:

```bash
gh pr checks "$NUMBER" --json name,state,bucket
```

- If all test-plan items map to passing CI jobs: skip local re-run and proceed directly to ticking the boxes (below).
- Otherwise: **run every item locally** from inside `.claude/worktrees/pr-$NUMBER/`, regardless of whether some items already pass. Classify each result as:
  - `✓ local` — ran and passed
  - `✗ failed` — ran and failed (fix before proceeding; do not tick the box)
  - `skipped` — requires infra or secrets not available locally (note reason)

**After a successful run, tick the checkboxes in the PR description** for each passing item by patching the PR body:

```bash
# Fetch the current body
BODY=$(gh pr view "$NUMBER" --json body -q .body)

# Replace [ ] with [x] for each verified item, then patch
UPDATED_BODY=$(echo "$BODY" | sed 's/- \[ \] <item text>/- [x] <item text>/g')

gh api "repos/{owner}/{repo}/pulls/$NUMBER" \
  --method PATCH \
  -f body="$UPDATED_BODY"
```

In practice, tick items programmatically — replace `- [ ]` with `- [x]` only for lines whose corresponding local run passed. Leave `- [ ]` for skipped or failed items.

Then post the evidence as a PR comment:

```bash
gh pr comment "$NUMBER" --body "Test plan verified against HEAD $(git rev-parse HEAD):
- \`<item>\` — ✓ local
- \`<item>\` — skipped (requires live DB)
..."
```

### 12. Resolve all review threads

After fixes are pushed, resolve every addressed review thread:

```bash
# Fetch thread IDs — pass variables with -F so GraphQL can bind them
gh api graphql \
  -F owner="$(gh repo view --json owner -q .owner.login)" \
  -F repo="$(gh repo view --json name -q .name)" \
  -F number="$NUMBER" \
  -f query='query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
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

### 13. Final branch health gate

Before writing the summary, re-verify:

```bash
gh pr view "$NUMBER" --json mergeable,mergeStateStatus
```

- `mergeable: CONFLICTING` → do not mark `reviewed`; fix conflicts and re-run CI
- `mergeStateStatus: BEHIND` → rebase onto base and push before closing out
- Only proceed when `mergeable` is `MERGEABLE` and status is `CLEAN` or `UNSTABLE` (with all CI failures already addressed)

### 14. Summary report

Output a table:

| PR  | Title | Comments | Valid | False Pos | Fixed | Security | CI  | Test Plan | Conflicts | Status |
| --- | ----- | -------- | ----- | --------- | ----- | -------- | --- | --------- | --------- | ------ |

A PR may only be marked `reviewed` if:

- The §7 push succeeded
- All auto-runnable test plan commands passed (or test plan was missing — flagged)
- No unresolved CI failures remain
- `mergeable` is `MERGEABLE` and branch is not `BEHIND` (verified in step 13)

Otherwise the row status is `blocked`, `push-failed`, `test-plan-missing`, or `conflicts-unresolved` and the blocker is called out.

End with the commit pushed, the worktree cleanup command, and any remaining action items.
