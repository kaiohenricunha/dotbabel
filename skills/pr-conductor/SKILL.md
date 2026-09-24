---
id: pr-conductor
name: pr-conductor
type: skill
version: 1.2.0
domain: [devex]
platform: [github-actions]
task: [review, testing]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-08-08
updated: 2026-09-24
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
disable-model-invocation: false
headless_safe: false
allowed-tools: Read Bash Grep Glob
---

Land one pull request end to end. This skill is a conductor: it sequences existing artifacts in a fixed order and owns only what none of them own — stacked-PR ordering and the stop-before-merge gate. It does not reimplement simplification, review, testing, or merging.

Trigger: when the user says "land this PR", "run the PR pipeline", "ship this branch", "what's blocking my PR", or invokes `/pr-conductor`.

**Invocation consent.** An agent can start this skill itself, but only with the user's approval. The shipped `.claude/settings.json` puts `Skill(pr-conductor)` in `permissions.ask`, so Claude Code prompts the user before each agent-started run. Call the skill only when the branch is committed and ready for a pull request. Treat the approved prompt as consent for that one run, not for later runs. Never edit the `ask` rule to skip the prompt. A user who wants no prompt adds `Skill(pr-conductor)` to `permissions.allow` in their own settings.

Arguments: `$ARGUMENTS`

- (empty) — run the full pipeline for the current branch, opening a PR if none exists.
- `<PR#>` — run the pipeline for an existing PR.
- `--stack` — plan the whole stack first, then run the pipeline for the PR that is actionable now.
- `--from <phase>` — resume at a phase id (see the phase table below). Overrides the derived entry in step 0.
- `--dry-run` — report what each phase would do; change nothing.

**Lifecycle:**

```
/git (commit) → /pr-conductor (pre-pr → open-pr → post-pr-review → review-pr → local-attest) → STOP → /merge-pr
```

## Phases

The canonical order lives in code, not here: `CONDUCTOR_PHASES` in `plugins/dotbabel/src/pr-gates.mjs`. `dotbabel pr-stack phases` prints it, and a bats contract test fails if this document and that array ever disagree.

| #   | Phase            | Delegates to                     | Owns                                                              |
| --- | ---------------- | -------------------------------- | ----------------------------------------------------------------- |
| 1   | `pre-pr`         | `commands/pre-pr.md`             | simplify, secrets gate, cheap `fast` quality profile              |
| 2   | `open-pr`        | `skills/git/SKILL.md`            | branch push + `gh pr create`                                      |
| 3   | `post-pr-review` | `skills/post-pr-review/SKILL.md` | produces inline review comments                                   |
| 4   | `review-pr`      | `skills/review-pr/SKILL.md`      | consumes them, applies fixes, resolves threads, verifies criteria |
| 5   | `local-attest`   | `skills/local-attest/SKILL.md`   | runs the CI matrix locally, posts the SHA-pinned attestation      |
| 6   | `stop`           | `commands/merge-pr.md`           | **hand-off only — this skill never merges**                       |

> **CI minutes are the constraint.** Every intermediate commit must carry `[skip ci]`, and `local-attest` is the only step that gates CI. Verify with `dotbabel pr-stack gate --gate skip-ci` rather than by eye. Warning: GitHub matches the marker **anywhere** in the message, so never write the token in prose unless you mean it — a commit message explaining that it is _not_ skipping CI will skip CI.

## Steps

### 0. Stack check (always run first)

```bash
dotbabel pr-stack plan --json > /tmp/stack.json
jq -r '.result.actionable[] | "#\(.number) \(.action): \(.reason)"' /tmp/stack.json
jq -r '.result.pending[]    | "#\(.number) blocked by \(.blockedBy | join(", "))"' /tmp/stack.json
jq -r '.result.problems[]   | "PROBLEM \(.kind): \(.message)"' /tmp/stack.json
```

Exit 1 means a structural problem (cycle, orphan base, two open PRs on one head, parent closed unmerged). **Stop and surface it** — these need a human decision, not a retry.

Then derive where to start, rather than asking the operator to remember:

```bash
dotbabel pr-stack entry --pr <N>    # omit --pr to resolve from the current branch
```

| Reason                  | Entry                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `NO_PR`                 | phase 1 as the narrowed preflight, then phase 2 opens the pull request                   |
| `PR_OPEN`               | phase 1 as the narrowed preflight; phase 2 self-skips; then 3 → 4 → 5                    |
| `REVIEWED_AT_HEAD`      | phase 5 (`local-attest`); phases 1 to 4 already finished on this exact head              |
| `REVIEWED_AND_ATTESTED` | phase 6: print the hand-off and stop; the review and the attestation both name this head |

`--from <phase>` overrides this and stays the way to resume a known-good run.

**Neither fact stands in for the other.** The command reads two SHA-pinned comments for the current head: a review-complete marker and a passing attestation. An attestation alone never skips the review stage: it proves a SHA passed the configured matrix and says nothing about review, and someone can run `dotbabel local-attest` directly and then invoke this skill. Only a review-complete marker can skip phases 1 to 4. `dotbabel pr-stack review-complete` posts it as the last act of `/review-pr`, and only after checking that a `/post-pr-review` receipt exists, that no finding it posted is still open, and that the criteria check has no blocking reason. It names the head, so it stops counting the moment anything is pushed. If either comment cannot be read, the command reports why and the entry falls back to `PR_OPEN`, which is always safe.

If the target PR appears in `pending`, it is blocked by an unmerged parent. Report which PR must land first and stop; do not start the pipeline on a PR that cannot merge.

### 1. `pre-pr`

Run `/pre-pr --conductor` (`commands/pre-pr.md`) — in **both** entry cases; the derived entry changes only whether phase 2 opens the pull request or self-skips. This is a **pre-review preflight**, not the authoritative gate: it simplifies, greps for secrets, and runs the cheap `fast` quality profile.

`--conductor` narrows three steps — the security pass to a secrets-only grep, the quality profile from `pr` to `fast`, and the PR-body checklist away entirely. Each is something the pipeline does properly later: the authoritative security pass runs once in phase 3 via the `security-auditor` agent, the authoritative `pr` quality profile is a leg of the phase 5 matrix pinned to the final head SHA, and phase 2 verifies the body mechanically with the merge gate.

Running the `pr` profile here would grade a tree the review fleet is about to change. Warning: a secrets hit is still a CRITICAL hard stop — phase 3 happens after the push, so secrets must be caught here.

**Do not run `/simplify` or `/code-simplifier` separately** — `commands/pre-pr.md` step 2 already invokes it and commits the result as `style: pre-pr simplification pass`. A second pass produces an empty commit and a confusing diff.

Hard stops from this phase are real stops: a CRITICAL security finding, or a `fast` profile failure. Do not advance past them.

No `git stash` proof here. `correctness.tests` is a `pr`-profile rule, so `fast` produces no test failure to attribute, and `--base` already scopes the changed-scope rules to this branch's diff. The stash proof belongs to the `pr` test legs at phase 5 — and this phase runs in the operator's own checkout, where the rule floor forbids `git stash` because the stash stack is shared across worktrees and concurrent sessions.

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

Run `/review-pr <N> --conductor` (`skills/review-pr/SKILL.md`) — all 15 steps. It applies fixes in its own worktree, replies, resolves threads, pushes, verifies the acceptance criteria, and finally records that the review finished (its step 14b), which is what step 0 reads on the next run.

**Stop here on a failing criterion.** Step 14 of that skill runs `dotbabel criteria verify --pr <N> --post`. A non-zero exit means the pull request does not satisfy the criteria its linked specs declare, so it reports **BLOCKED** and this pipeline does **not** advance to `local-attest` — spending the matrix on a change the criteria already reject buys nothing. Report which criteria failed and stop. Never resolve a failing criterion by editing the criterion.

`--conductor` removes the duplicated work: it fast-paths only the mechanical findings this pipeline posted itself (`style`, `comment`, `type`, marker plus matching author — everything else, and every `critical`, still gets validated), scopes its test run and its security pass to the fix delta, and defers test-plan execution to phase 5 behind a marker the merge gate enforces.

Every commit it produces must carry an **effective** `[skip ci]`. Verify before each push rather than trusting it — `head -1` cannot see the last-line or `skip-checks:` trailer forms:

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

Phase 4 deferred the test plan to this phase and left a `<!-- test-plan: deferred -->` marker in the PR body to record it, so **every** exit here owes the plan a disposition. There are four:

- **Attest passes** — tick each `## Test plan` checkbox the matrix covered, using the `printf` and PATCH shape in `skills/review-pr/SKILL.md` step 11, and post the evidence comment pinned to the attested SHA. Leave items the matrix did not cover unticked and list them in the summary.
- **Attest fails** — record the failure and mark the PR blocked. **Do not push "fix CI" commits in a loop.** The test plan is now unowned: say so explicitly and list every unticked item, so a BLOCKED summary states what still needs verification.
- **No `.local-attest` config** — skip the attestation and say so plainly; CI will run remotely as normal. **Run the test-plan items now**, per `skills/review-pr/SKILL.md` step 11, before the summary — otherwise the deferral means nothing ever runs them.
- **Entered here via `--from local-attest`** — no phase 4 ran in this session, so nothing deferred anything. Run the test-plan items as above before the summary rather than assuming a previous session ticked them.

**Clear the marker only on an exit that actually ran the items** — the passing, no-config, and `--from` branches above. Remove the `<!-- test-plan: deferred -->` line from the body with `gh pr edit <N> --body-file <file>`, then confirm:

```bash
dotbabel pr-stack gate --gate merge --pr <N>
```

If the merge gate then reports `attestation.state: explicit`, the pull request edits a governed file and its attestation cannot authorize it. That is not a failure of this phase: the attest still ran the matrix and ticked the plan, and `/merge-pr` will route the pull request through explicit verification after the user reads the governed-file diff. Say so in the summary rather than reporting `READY` as though the evidence were sufficient.

On a failed attest, **leave the marker in place**. `DEFERRED_TEST_PLAN` keeps the merge gate red, which is the correct state for a plan nothing verified. A `WORKTREE_DIRTY` or `HEAD_MISMATCH` precondition failure counts as a failed attest here: fix the precondition and re-enter, or report the test plan as unrun.

### 6. `stop`

Print the go/no-go summary and **stop**:

```
PR #<N> — <title>   (base: <base>)

  1 pre-pr          ✓ fast profile clean · secrets clean
  2 open-pr         ✓ #<N> · body has Summary + Test plan
  3 post-pr-review  ✓ <k> comments posted (<profile>)
  4 review-pr       ✓ <k> resolved · pushed <sha> [skip ci]
  5 local-attest    ✓ attested <sha> · test plan ticked
                  |  SKIP no config · test plan run locally
                  |  ✗ <reason> · test plan NOT run (<k> items unverified)
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
- **`[skip ci]` on every intermediate commit.** GitHub matches the marker anywhere in the message, so it also fires when you only meant to mention it — never write the token in prose unless you want the skip.
- **`local-attest` is the only CI gate.** If its config is absent, say so — do not invent a substitute.
- **Do not re-run simplification.** Phase 1 already did it.
- **One review dispatch.** Phase 3 posts once with `--auto --confirm-post`; never preview-then-post — that doubles the agent fleet for zero information.
- **Do not review the same code twice.** Phase 3 owns the security pass and the comment validation; phases 1 and 4 run in `--conductor` mode so they narrow to a secrets grep and a fix delta.
- **Stop at hard stops.** A CRITICAL security finding or a branch-introduced test failure ends the run.
- **Never claim a test failure is pre-existing** without the `git stash` proof that `commands/pre-pr.md` requires.
- **One PR at a time.** For a batch, the caller loops; this skill stays single-PR.
