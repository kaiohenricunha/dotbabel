---
id: review-pr
name: review-pr
type: skill
version: 1.1.0
domain: [devex]
platform: [github-actions]
task: [review]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-08-12
description: >
  Review a pull request: fetch comments, validate, apply fixes, resolve conflicts, and close out all threads.
  Triggers on: "review PR", "review pull request", "check PR".
argument-hint: "[PR#] [--conductor]"
tools: Bash, Read, Grep, Glob
model: sonnet
---

Review a pull request: fetch comments, validate, apply fixes, resolve conflicts, and close out all threads.

Argument: `$ARGUMENTS` — PR number (required), plus an optional `--conductor` flag. Example: `/review-pr 42`

## Conductor mode

`/pr-conductor` phase 4 passes `--conductor`. The flag trims work the surrounding pipeline already does; a run without it behaves exactly as before. The deltas, each restated at the step it changes:

- **Step 3** — trust comments this pipeline posted itself; validate only human or foreign ones.
- **Step 5** — record a baseline commit, then run only the tests covering the files the fixes touched.
- **Step 6** — security-review the fix delta, not the whole PR diff.
- **Step 11** — do not execute test-plan items; the conductor's `local-attest` phase runs them and ticks the boxes. Write a `<!-- test-plan: deferred -->` marker into the PR body so the merge gate blocks until they actually run.
- **Step 14** — a deferred plan yields status `deferred`, not `reviewed`.

## Workflow

Before any step, bind the PR number and the mode. `--conductor` may appear in any position — strip it first, then take the PR number from what remains, so `/review-pr --conductor 42` and `/review-pr 42 --conductor` behave identically. `commands/pre-pr.md` uses the same strip-anywhere rule.

```bash
CONDUCTOR=0
REST="$ARGUMENTS"
case " $REST " in *" --conductor "*) CONDUCTOR=1 ;; esac
REST="$(printf '%s' "$REST" | sed 's/--conductor//g' | xargs)"
NUMBER="${REST%% *}"
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

**Conductor mode:** a comment that `/post-pr-review` produced has passed a _mechanical_ filter — its line is in the diff and its self-rated confidence cleared 80 (`skills/post-pr-review/SKILL.md` step 6). That filter never read the code and never judged whether the finding is correct, so it is not a substitute for this step. What it does justify is skipping the re-read for findings whose correctness is checkable from the diff alone.

Fast-path a comment only when **all three** hold:

1. It carries a `post-pr-review:v1:` marker, **and**
2. its author matches the authenticated login (`gh api user -q .login`) — the marker is public text anyone can paste, so the marker alone proves nothing, **and**
3. its `category` is mechanical: `style`, `comment`, or `type`.

Everything else — `bug`, `design`, `security`, `test`, `simplify`, `error-handling`, any unmarked comment, any foreign author — gets the full validation below. Those are the categories where a confident agent is most often wrong, and under `--conductor` this is the only stage that can still reject a finding: step 4 replies to false positives, and after this the fixes are applied, pushed with `[skip ci]`, and the threads resolved. Never let a `critical` finding through on the fast path regardless of category.

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

**Conductor mode:** record the baseline commit before applying anything — step 6 diffs against it. Bind it against the worktree explicitly, not the caller's checkout: the block above necessarily ran in the caller's tree, and when this skill is invoked from a checkout that is not the PR branch, a bare `git rev-parse HEAD` captures the wrong commit and step 6 silently reviews a two-branch divergence instead of your fixes.

```bash
BASELINE=$(git -C ".claude/worktrees/pr-$NUMBER" rev-parse HEAD)
```

- Apply all fixes for valid comments, TDD-first (failing test → fix → green).
- Detect and run the project test suite:
  - `Makefile` with `test` target → `make test`
  - `package.json` → `npm test` (or `pnpm`/`yarn` per lockfile)
  - `go.mod` → `go test ./...`
  - `pyproject.toml` → `pytest` (or `uv run pytest`)
- Commit with a clear message referencing the review (e.g., `fix: address PR review — <summary>`).

**Conductor mode:** once the fixes exist, narrow that test run to the files they touched, using the runner's own scoping (`npx vitest related <files>`, `go test` on the touched packages, `pytest` on the matching test files). A runner with no scoping mechanism — a bare `make test` target — falls back to the full suite. The full suite runs regardless in the conductor's `local-attest` phase, so a second full run here buys nothing.

Leave the worktree in place when done. Print the cleanup command:

```bash
git worktree remove .claude/worktrees/pr-$NUMBER
```

### 6. Security review

**Conductor mode:** phase 3's `security-auditor` agent already reviewed the full PR diff. Review only what this step's fixes added, staging the delta the way `commands/pre-pr.md` step 3 does:

```bash
git diff "$BASELINE"..HEAD | git apply --cached --allow-empty
```

Then run `/security-review staged` and unstage with `git restore --staged .`. If no fix commits were made, record `security: no delta` and skip to step 7.

Standalone runs review the whole PR diff. Before pushing, run the `/security-review` skill on it:

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

- Fetch the latest base ref: `git fetch origin <baseRefName>`
- Rebase onto the updated base: `git rebase origin/<baseRefName>`
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

**If the PR body has no `## Test plan` section:** leave a comment asking the author to add one, record `test-plan: missing` in the final summary, and skip steps 12 and 13. Jump directly to the summary with status `test-plan-missing`.

**Conductor mode:** still check that the `## Test plan` section exists (a missing one is handled exactly as above) and still classify each item as runnable or manual for the summary. Do not execute any item here, and do not tick any checkbox. The conductor's `local-attest` phase runs the full CI matrix immediately after this skill returns, and ticks each covered box against the attested SHA using the `printf` and PATCH shape below.

**Record the deferral in the PR body** before moving on, so it is a fact a gate can read rather than a promise:

```bash
gh api "repos/{owner}/{repo}/pulls/$NUMBER" --method PATCH \
  -f body="$(gh pr view "$NUMBER" --json body -q .body)
<!-- test-plan: deferred -->"
```

`dotbabel pr-stack gate --gate merge` fails with `DEFERRED_TEST_PLAN` while that marker is present, so a PR cannot merge on an unrun plan even if this skill is invoked directly, the conductor stops early, or phase 5 aborts. Only the phase that actually runs the items removes it. Then go to step 12.

The CI-skip exception below is dead under the conductor anyway: every intermediate commit carries `[skip ci]`, so no passing CI check label exists to match against.

**If a `## Test plan` section exists**, check whether the CI-skip exception applies:

```bash
gh pr checks "$NUMBER" --json name,state,bucket
```

**CI-skip rule (narrow):** skip the local run only if _every_ test-plan item is a runnable command whose exact text matches a named, passing CI check label. If any item is manual, prose-only, or has no CI counterpart, run all items locally.

Otherwise: **run every item locally** from inside `.claude/worktrees/pr-$NUMBER/`. Classify each result as:

- `✓ local` — ran and passed
- `✗ failed` — ran and failed (fix before proceeding; do not tick the box)
- `skipped` — requires infra or secrets not available locally (note reason)

**After running, tick the checkboxes in the PR description** for each passing item. Use `printf` (not `echo`) to avoid escape-sequence corruption, and substitute the real checklist line text — the sed pattern below is pseudocode illustrating the shape of the transform:

```bash
# Pseudocode — substitute real checklist line text for <item text>
BODY=$(gh pr view "$NUMBER" --json body -q .body)
UPDATED=$(printf '%s' "$BODY" | sed 's/- \[ \] <item text>/- [x] <item text>/g')
gh api "repos/{owner}/{repo}/pulls/$NUMBER" --method PATCH -f body="$UPDATED"
```

Replace `- [ ]` with `- [x]` only for lines whose local run passed; leave `- [ ]` for skipped or failed items.

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
- A test plan is present and all auto-runnable commands passed. **In conductor mode a deferred plan does not satisfy this** — the row status is `deferred`, not `reviewed`, the Test Plan column reads `deferred → local-attest`, and the `<!-- test-plan: deferred -->` marker from step 11 keeps the merge gate red until the phase that runs the items clears it. Only the conductor's phase 6 may report the run as complete, and only after phase 5 has disposed of the plan
- No unresolved CI failures remain
- `mergeable` is `MERGEABLE` and branch is not `BEHIND` (verified in step 13)

Otherwise the row status is `blocked`, `push-failed`, `test-plan-missing`, or `conflicts-unresolved` and the blocker is called out.

End with the commit pushed, the worktree cleanup command, and any remaining action items.
