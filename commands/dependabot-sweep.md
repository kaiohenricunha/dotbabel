Batch-triage all open Dependabot PRs in the current repo using parallel subagents. Produce a risk-annotated table and merge only safe bumps.

Trigger: when the user asks to review/merge/rebase Dependabot PRs, or wants to sweep dependency updates. Also triggered directly via `/dependabot-sweep`.

Arguments: `$ARGUMENTS` — optional filters (e.g. `gomod`, `npm`, `--max 10`). If empty, sweep all open Dependabot PRs.

## Steps

1. **Enumerate open Dependabot PRs.**
   ```bash
   gh pr list --author "app/dependabot" --state open \
     --json number,title,headRefName,labels,mergeable,mergeStateStatus,files,statusCheckRollup
   ```
   Apply any `$ARGUMENTS` filters. Report count before proceeding.

2. **Classify each PR by risk.** For every PR, determine:
   - Bump type: `patch` / `minor` / `major` (parse title, e.g. "bump foo from 1.2.3 to 1.2.4")
   - Touches lockfile? (yes if `package-lock.json`, `go.sum`, `uv.lock`, `poetry.lock`, etc. in files)
   - Prod-critical dep? (check if it's in the main module path or a top-level runtime dependency)
   - CI currently? (`statusCheckRollup`)

3. **Dispatch parallel subagents.** Use the `Agent` tool with `subagent_type: "general-purpose"` in a **single message with multiple tool calls** — one agent per PR, each isolated in its own worktree. Each subagent receives a self-contained prompt with:
   - The PR number and head ref
   - Instructions to: (a) `git worktree add` a fresh path off `main`, (b) `gh pr checkout <N>`, (c) rebase on `origin/main`, (d) run the full test suite, (e) address any Copilot review comments, (f) report back a structured result JSON
   - A strict rule: **do not merge from inside the subagent.** Only the coordinator merges.
   - Required output: `{pr, dep, bump, test_delta, copilot_comments_addressed, risk, recommendation, evidence_url}`

4. **Aggregate results** into a markdown table in your response:

   | PR | Dep | Bump | Test Δ | Copilot | Risk | Recommendation |
   |----|-----|------|--------|---------|------|----------------|
   | #123 | foo | minor | 0/0 | 2 addressed | low | auto-merge |
   | #125 | bar | major | 0/0 | — | high | needs user review |

5. **Auto-close subsumed PRs.** If two PRs bump the same dep to different versions, close the older one:
   ```bash
   gh pr close <N> --comment "Subsumed by #<newer>: same dep, newer version."
   ```

6. **Merge safe bumps.** For every PR classified `low` risk AND (patch or minor) AND tests green AND not lockfile-only:
   ```bash
   gh pr merge <N> --squash --delete-branch
   ```
   Report each merge inline as it happens.

7. **Stop and ask the user** for any PR classified `major`, `lockfile-only`, or `high risk`. Present the table and wait for explicit user approval per-PR before merging these.

8. **Cleanup.** Remove all temporary worktrees created during the sweep.

## Rules

- Never force-push. Never rebase using `--force` from inside a subagent.
- Never merge a major version bump without explicit user confirmation, even if tests pass.
- Never merge a PR whose test suite has regressions — prove pre-existing with `git stash` first (see `/merge-pr`).
- Parallelism cap: no more than 6 concurrent subagents. If more PRs exist, batch them.
- Every row in the aggregate table must cite an evidence link (CI run URL or local test output snippet).
- If a subagent's worktree path disappears mid-run, recreate it rather than fail the whole sweep.
