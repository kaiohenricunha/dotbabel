---
id: pr-conductor
name: pr-conductor
type: skill
version: 1.1.0
domain: [devex]
platform: [github-actions]
task: [review, testing]
maturity: draft
description: >
  Land one pull request end to end: pre-PR quality gate, open the PR, AI review,
  apply review fixes, local CI attestation — then STOP with a go/no-go summary.
  Never merges; merging stays an explicit human call handed to /merge-pr.
  Understands stacked PRs, where a child must retarget and rebase --onto after
  its parent squash-merges. Delegates every phase to an existing artifact rather
  than reimplementing it. Triggers on: "land this PR", "run the PR pipeline",
  "take this branch to a PR", "ship this branch", "what's blocking my PR".
argument-hint: "[PR#] [--stack] [--from <phase>] [--dry-run]"
model: sonnet
user-invocable: true
disable-model-invocation: true
headless_safe: false
allowed-tools: Read Bash Grep Glob
---

Land one pull request end to end. This skill is a conductor: it sequences existing artifacts in a fixed order and owns only what none of them own — stacked-PR ordering and the stop-before-merge gate. It does not reimplement simplification, review, testing, or merging.

Trigger: when the user says "land this PR", "run the PR pipeline", "ship this branch", "what's blocking my PR", or invokes `/pr-conductor`.

Arguments: `$ARGUMENTS`

- (empty) — run the full pipeline for the current branch, opening a PR if none exists.
- `<PR#>` — run the pipeline for an existing PR.
- `--stack` — plan the whole stack first, then run the pipeline for the PR that is actionable now.
- `--from <phase>` — resume at a phase id (see the phase table below).
- `--dry-run` — report what each phase would do; change nothing.

**Lifecycle:**

```
/git (commit) → /pr-conductor (pre-pr → open-pr → post-pr-review → review-pr → local-attest) → STOP → /merge-pr
```

## Phases

The canonical order lives in code, not here: `CONDUCTOR_PHASES` in `plugins/dotbabel/src/pr-gates.mjs`. `dotbabel pr-stack phases` prints it, and a bats contract test fails if this document and that array ever disagree.

| #   | Phase            | Delegates to                     | Owns                                                         |
| --- | ---------------- | -------------------------------- | ------------------------------------------------------------ |
| 1   | `pre-pr`         | `commands/pre-pr.md`             | simplify, secrets gate (full review in phase 3), test suite  |
| 2   | `open-pr`        | `skills/git/SKILL.md`            | branch push + `gh pr create`                                 |
| 3   | `post-pr-review` | `skills/post-pr-review/SKILL.md` | produces inline review comments                              |
| 4   | `review-pr`      | `skills/review-pr/SKILL.md`      | consumes them, applies fixes, resolves threads               |
| 5   | `local-attest`   | `skills/local-attest/SKILL.md`   | runs the CI matrix locally, posts the SHA-pinned attestation |
| 6   | `stop`           | `commands/merge-pr.md`           | **hand-off only — this skill never merges**                  |

> **CI minutes are the constraint.** Every intermediate commit must carry `[skip ci]`, and `local-attest` is the only step that gates CI. Verify with `dotbabel pr-stack gate --gate skip-ci` rather than by eye: a marker buried mid-body is inert, it only counts on the first or last line (or as a `skip-checks: true` trailer).

## Steps

### 0. Stack check (always run first)

```bash
dotbabel pr-stack plan --json > /tmp/stack.json
jq -r '.result.actionable[] | "#\(.number) \(.action): \(.reason)"' /tmp/stack.json
jq -r '.result.pending[]    | "#\(.number) blocked by \(.blockedBy | join(", "))"' /tmp/stack.json
jq -r '.result.problems[]   | "PROBLEM \(.kind): \(.message)"' /tmp/stack.json
```

Exit 1 means a structural problem (cycle, orphan base, two open PRs on one head, parent closed unmerged). **Stop and surface it** — these need a human decision, not a retry.

If the target PR appears in `pending`, it is blocked by an unmerged parent. Report which PR must land first and stop; do not start the pipeline on a PR that cannot merge.

### 1. `pre-pr`

Run `/pre-pr --conductor` (`commands/pre-pr.md`). It already runs `/code-simplifier` and the full test suite.

`--conductor` narrows its security step to a secrets-only grep, because the authoritative security pass runs once in phase 3 via the `security-auditor` agent. Warning: a secrets hit is still a CRITICAL hard stop — phase 3 happens after the push, so secrets must be caught here.

**Do not run `/simplify` or `/code-simplifier` separately** — `commands/pre-pr.md` step 2 already invokes it and commits the result as `style: pre-pr simplification pass`. A second pass produces an empty commit and a confusing diff.

Hard stops from this phase are real stops: a CRITICAL security finding, or a test failure proven branch-introduced by the `git stash` check. Do not advance past them.

### 2. `open-pr`

If the PR already exists, skip to phase 3.

Otherwise run `/git pr` (`skills/git/SKILL.md`).

**Then fix the body.** `/git pr` emits a `## Testing` section, but `skills/review-pr/SKILL.md` and `commands/merge-pr.md` both require `## Test plan` and will block without it. Verify and repair before continuing:

```bash
dotbabel pr-stack gate --gate merge --pr <N>
```

Fix every reason it reports via `gh pr edit <N> --body-file <file>` — use a file, never a heredoc, so backticks and the Spec ID block survive. Re-run until it passes, or until only `BEHIND_BASE` remains (phase 4 handles that).

### 3. `post-pr-review`

Run `/post-pr-review <N>` (`skills/post-pr-review/SKILL.md`) to post inline review comments.

**Invoke it exactly once.** When this conductor run is not `--dry-run`, that single invocation is `/post-pr-review <N> --auto --confirm-post` — post for real on the first pass. The skill is dry-run by default in an interactive session, but previewing and then re-running dispatches the whole review fleet twice for no new information, and phase 4 consumes whatever was posted. When the conductor run itself is `--dry-run`, invoke with `--dry-run`, stop at the preview, and report the comment count.

The fleet sizes itself to the diff profile (`skills/post-pr-review/SKILL.md` step 5), so a docs-only PR costs one agent and a protected-path PR costs four. Pass `--agents` through only to override a misjudged diff.

### 4. `review-pr`

Run `/review-pr <N> --conductor` (`skills/review-pr/SKILL.md`) — all 14 steps. It applies fixes in its own worktree, replies, resolves threads, and pushes.

`--conductor` removes the duplicated work: it trusts the comments phase 3 posted and gate-validated (validating any human or foreign comment normally), scopes its test run and its security pass to the fix delta, and leaves test-plan execution to phase 5.

Every commit it produces must carry an **effective** `[skip ci]`. Verify before each push rather than trusting it — a marker buried mid-body is inert, and `head -1` cannot see the last-line or `skip-checks:` trailer forms:

```bash
dotbabel pr-stack gate --gate skip-ci
```

### 5. `local-attest`

Check the preconditions before spending 10–15 minutes on the matrix:

```bash
dotbabel pr-stack gate --gate local-attest --pr <N>
```

A `WORKTREE_DIRTY` or `HEAD_MISMATCH` failure means `local-attest` would abort anyway — commit or push first. Then:

```bash
dotbabel local-attest --pr <N>
```

If it fails, record the failure and mark the PR blocked. **Do not push "fix CI" commits in a loop** — surface the failure instead.

After it passes, close out the test plan phase 4 deferred. Tick each `## Test plan` checkbox the matrix covered, using the `printf` and PATCH shape in `skills/review-pr/SKILL.md` step 11, and post the evidence comment pinned to the attested SHA. Leave every item the matrix did not cover unticked and list it in the summary.

If the repo has no `.local-attest` config, skip the attestation and say so plainly; CI will run remotely as normal. **Run the test-plan items now** in that case, per `skills/review-pr/SKILL.md` step 11, before the summary — phase 4 deferred them here, so skipping this phase silently would mean nothing ever runs them.

### 6. `stop`

Print the go/no-go summary and **stop**:

```
PR #<N> — <title>   (base: <base>)

  1 pre-pr          ✓ tests pass · security clean
  2 open-pr         ✓ #<N> · body has Summary + Test plan
  3 post-pr-review  ✓ <k> comments posted (<profile>)
  4 review-pr       ✓ <k> resolved · pushed <sha> [skip ci]
  5 local-attest    ✓ attested <sha> · test plan ticked | SKIP no config | ✗ <reason>
  6 stop            → run /merge-pr <N> to merge

Stack: <this PR is standalone | #<N> lands first, then #<M> needs a rebase>
Status: READY  |  BLOCKED — <reason>
```

**This is the end of the skill.** Merging is a separate, explicit instruction from the user. Do not call `/merge-pr` yourself, and do not run the merge command directly.

## Stacked PRs

When a child PR is based on a parent PR's branch, the child cannot merge until the parent does — and once the parent squash-merges, the child needs more than a plain rebase.

The repo squash-merges (`commands/merge-pr.md`), so the parent's original commits are **not** ancestors of the squashed commit on the trunk. `git rebase origin/main` would replay them and conflict on exactly the files both PRs touched. The correct move drops them:

```bash
git rebase --onto origin/main <parent-head-sha> <child-branch>
```

**Capture the parent's head SHA before merging it.** `commands/merge-pr.md` merges with `--delete-branch`, so the ref can be gone by the time you need it:

```bash
PARENT_SHA=$(gh pr view <parent> --json headRefOid -q .headRefOid)
```

After the parent lands, get the exact commands:

```bash
dotbabel pr-stack next --pr <child> --parent <parent> --parent-sha "$PARENT_SHA"
```

It prints the retarget, fetch, checkout, rebase, and push steps in order. **The push is a force-push** — `--force-with-lease` on someone else's branch needs their explicit confirmation first. Then re-enter this skill at phase 3 for the child.

## Rules

- **Never merge.** Phase 6 is a full stop. `commands/merge-pr.md` is named as a hand-off target and is never invoked from here.
- **Never force-push without explicit confirmation**, including the stacked-PR rebase.
- **`[skip ci]` on every intermediate commit.** A marker is only effective on the first or last line of the message.
- **`local-attest` is the only CI gate.** If its config is absent, say so — do not invent a substitute.
- **Do not re-run simplification.** Phase 1 already did it.
- **One review dispatch.** Phase 3 posts once with `--auto --confirm-post`; never preview-then-post — that doubles the agent fleet for zero information.
- **Do not review the same code twice.** Phase 3 owns the security pass and the comment validation; phases 1 and 4 run in `--conductor` mode so they narrow to a secrets grep and a fix delta.
- **Stop at hard stops.** A CRITICAL security finding or a branch-introduced test failure ends the run.
- **Never claim a test failure is pre-existing** without the `git stash` proof that `commands/pre-pr.md` requires.
- **One PR at a time.** For a batch, the caller loops; this skill stays single-PR.
