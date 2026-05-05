---
id: review-prs
name: review-prs
type: skill
version: 1.0.1
domain: [devex]
platform: [github-actions]
task: [review]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-04-18
updated: 2026-04-18
description: >
  Batch-review multiple PRs in parallel: dispatch one sub-agent per PR in an isolated
  worktree, aggregate results into a summary table.
  Triggers on: "review all PRs", "check my PRs", "PR status".
argument-hint: "<N1> [N2 N3 ...] — space-separated PR numbers"
tools: Bash, Read, Grep
model: opus
headless_safe: false
---

Batch-review a list of PRs in parallel. Each PR gets its own sub-agent running the full `review-pr` workflow (fetch comments → validate → apply fixes → push → resolve threads → CI gate). Results are aggregated into a single summary table.

Trigger: when the user provides a list of PR numbers to review simultaneously, asks to batch-review PRs, or says "review all of these".

Arguments: `$ARGUMENTS` — space-separated PR numbers (required). Example: `/review-prs 42 43 44`.

## Steps

### 1. Parse arguments

Bind `NUMBERS` from `$ARGUMENTS`. If empty, print usage and stop:

```
Usage: /review-prs <N1> [N2 N3 ...]
```

Echo the target list before doing any network calls: "Reviewing N PRs: #A #B #C".

### 2. Pre-flight checks

Run all three checks **before creating any worktree**.

**2a — PR existence and state.** For each PR number:

```bash
gh pr view "$N" --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus,state
```

- Non-zero exit (PR not found, no access) → mark `preflight-failed: not-found`; add a synthetic result row for that PR and exclude it from worktree/sub-agent execution.
- `state != "OPEN"` → mark `preflight-failed: not-open`; add a synthetic result row for that PR and exclude it from worktree/sub-agent execution.

Report any exclusions. Never silently skip a PR: every requested PR must appear in the final aggregate table, including `preflight-failed` rows created here. If zero PRs survive for execution, stop after emitting the aggregate table.

**2b — Merge state classification** (advisory; from the same JSON above):

| `mergeable`   | `mergeStateStatus`    | Tag                             |
| ------------- | --------------------- | ------------------------------- |
| `CONFLICTING` | `DIRTY`               | `preflight-warn: conflicts`     |
| `MERGEABLE`   | `BEHIND`              | `preflight-warn: behind`        |
| `UNKNOWN`     | any                   | `preflight-warn: unknown-state` |
| `MERGEABLE`   | `CLEAN` or `UNSTABLE` | (no tag — proceed normally)     |

Record the tag and pass `mergeStateStatus` into the sub-agent brief; the sub-agent handles rebase (step 9 of review-pr) and CI (step 10) autonomously.

**2c — Worktree collision check.** Run once:

```bash
git worktree list
```

For each PR N, check if `.claude/worktrees/pr-N` appears. If yes: `preflight-warn: worktree-exists` and set `WORKTREE_EXISTS=true` for that PR. The sub-agent reuses the existing worktree safely (the `if [ ! -d ]` guard in review-pr step 5 handles this). If no: `WORKTREE_EXISTS=false`.

**Print the pre-flight summary table before dispatch:**

| PR  | Title | Merge State | Worktree | Pre-flight                       |
| --- | ----- | ----------- | -------- | -------------------------------- |
| #42 | ...   | CLEAN       | new      | ok                               |
| #43 | ...   | DIRTY       | exists   | warn: conflicts, worktree-exists |

Only surviving (non-`preflight-failed`) PRs proceed.

### 3. Batch into rounds of 6

Split surviving PRs into rounds of at most 6. Print the plan before dispatching:

```
Round 1: #42, #43, #44, #45, #46, #47
Round 2: #48
```

### 4. Dispatch parallel sub-agents

For each round: emit a **single coordinator message with one `Agent` tool call per PR** — all calls in that round in one message. Use `subagent_type: "general-purpose"`. Wait for all agents in the round to complete before starting the next.

Construct the following brief for each PR, substituting real values for `N`, `TITLE`, `BASE_REF`, `MERGE_STATE_STATUS`, and `WORKTREE_EXISTS`:

---

```
You are reviewing PR #N ("TITLE") in repo $(gh repo view --json nameWithOwner -q .nameWithOwner).

Working directory: $(git rev-parse --show-toplevel)
Worktree path: .claude/worktrees/pr-N
Worktree already exists: WORKTREE_EXISTS
Base ref: BASE_REF
Merge state at dispatch: MERGE_STATE_STATUS

Follow the review-pr command workflow exactly — all 14 steps — with these constraints:

AUTONOMY
- Do NOT merge. The user merges explicitly via `/merge-pr N` after reviewing the aggregate table.
- Do NOT prompt the user. Make autonomous decisions throughout.
- If a decision requires user judgement (e.g. an ambiguous design change), note it in `blocker`
  and continue with the rest of the review. Do not halt.

WORKTREE
- If WORKTREE_EXISTS is true, skip `git worktree add` and use the existing path as-is.
- If MERGE_STATE_STATUS is BEHIND or DIRTY, rebase onto the base ref before collecting comments
  (review-pr step 9 covers this — do it first, before step 2, when the branch is conflicting).

OUTPUT
After completing step 14, emit exactly ONE JSON object to stdout (no other text after it):

{
  "pr": N,
  "title": "TITLE",
  "comments": <total comments fetched>,
  "valid": <count valid issues>,
  "false_pos": <count false positives>,
  "fixed": <count fixes applied>,
  "security": "clean|findings",
  "ci": "green|fixed|blocked|flaky|skipped",
  "test_plan": "verified|missing|partial|skipped",
  "conflicts": "none|resolved|unresolved",
  "status": "reviewed|blocked|push-failed|test-plan-missing|conflicts-unresolved|sub-agent-failed|preflight-failed",
  "evidence_url": "<CI run URL or test output reference>",
  "blocker": null
}

FAILURE MODES
- Push failure (step 7): set status "push-failed", stop — do not post replies or resolve threads.
- Test plan missing: set status "test-plan-missing"; include evidence_url if available.
- Merge conflicts left unresolved: set status "conflicts-unresolved"; set blocker to a one-line explanation.
- Preflight/setup failure before the review can run: set status "preflight-failed", set blocker to a
  one-line explanation, still emit the JSON. Use zero counts for fields that were never collected.
- Sub-agent execution failure after start but before a normal result is produced: set status
  "sub-agent-failed", set blocker to a one-line explanation, still emit the JSON. Populate
  completed counts best-effort from work finished before the failure.
- Sandbox blocks file writes: emit JSON to stdout regardless.
- Any other unrecoverable error: set status "blocked", set blocker to a one-line explanation,
  still emit the JSON.
```

---

### 5. Collect results and handle partial failures

After each round, parse each sub-agent's stdout for the result JSON.

| Outcome               | Action                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| Valid JSON            | Store for aggregate table                                                           |
| No output / crash     | `status: sub-agent-failed`, `blocker: "no output from sub-agent"`                   |
| Malformed JSON        | `status: sub-agent-failed`, `blocker: "parse error: <first 100 chars of output>"`   |
| `status: push-failed` | Record as-is; add note: "commits staged locally — run `/review-pr N` to retry push" |

Never silently skip a PR. Every PR gets a row in the aggregate table.

### 6. Aggregate summary table

Render one row per PR using the collected JSON:

| PR  | Title | Comments | Valid | False Pos | Fixed | Security | CI  | Test Plan | Conflicts | Status |
| --- | ----- | -------- | ----- | --------- | ----- | -------- | --- | --------- | --------- | ------ |

Status values: `reviewed`, `blocked`, `push-failed`, `test-plan-missing`, `conflicts-unresolved`, `preflight-failed`, `sub-agent-failed`.

A PR may only be marked `reviewed` if: push succeeded, test plan verified, no unresolved CI failures, branch not conflicting (same gate as review-pr step 14).

If any PRs have `sub-agent-failed`: end the table with — "For failed PRs, run `/review-pr N` individually."

### 7. Cleanup

Print (do not auto-run) the cleanup command for every worktree created during this run:

```bash
git worktree remove .claude/worktrees/pr-N   # for each N
```

## Rules

- **Never merge** from inside a sub-agent or from the coordinator. Use `/merge-pr N` or `/review-pr N` explicitly for each PR after reviewing the table.
- **Parallelism cap:** 6 concurrent sub-agents per round. Batch the rest into subsequent rounds.
- **Never force-push** from sub-agents. If rebase produces a conflict the sub-agent cannot resolve, it marks `conflicts: unresolved` and stops.
- **Worktree recreation:** if a worktree path disappears mid-run, the sub-agent's `if [ ! -d ]` guard recreates it.
- **Sandbox write blocks:** sub-agents emit JSON to stdout; the coordinator captures from stdout, not from files.
- **Every Status row** must cite the `evidence_url` from the sub-agent's JSON (CI run URL or test output).
- **Pre-flight failures are non-fatal** to the batch — removed PRs are reported in the pre-flight table and excluded from dispatch. The remaining PRs proceed.
