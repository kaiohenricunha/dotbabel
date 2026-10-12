---
id: fix-with-evidence
name: fix-with-evidence
type: skill
version: 1.1.0
domain: [devex]
platform: [none]
task: [debugging, testing]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-10-12
description: >
  Fix a bug using a strict Reproduce -> Fix -> Verify -> PR loop.
  Triggers on: "fix this", "apply fix", "solve issue".
argument-hint: "[issue]"
tools: Read, Grep, Glob, Bash
model: sonnet
---

Fix a bug using a strict four-phase evidence loop: Reproduce → Fix → Verify → PR. Each phase gates on the previous.

Trigger: when the user asks for a bug fix, wants to address an issue, or says "fix X". Also triggered directly via `/fix-with-evidence <issue>`.

Arguments: `$ARGUMENTS` — an issue number, link, or symptom description. If empty, ask the user.

## Task state

Record the contract and the state of the fix with `dotbabel task`, so a new or resumed session reads where the fix stands. The state lives in the worktree's git directory and never shows in `git status`. If `dotbabel` is not installed, skip the `dotbabel task` commands and keep every phase gate.

- Before Phase 1, run `dotbabel task list`. If an open task already covers this issue, read it with `dotbabel task show <slug>` and resume at its phase. Otherwise create one (the slug names the issue, for example `issue-431`):

  ```bash
  dotbabel task new <slug> --phase reproduce \
    --goal "<the behavior the fix restores>" \
    --done-when "a test reproduces the bug and fails" \
    --done-when "the test passes after the fix" \
    --done-when "the full suite passes, or each failure is proven pre-existing" \
    --done-when "a PR is open with the evidence"
  ```

- When a gate passes, record the next phase: `dotbabel task update <slug> --phase <fix|verify|pr>`.
- Record each choice with `--decision "<text>"`: the root cause with its `file:line`, a rejected fix, a re-scope.
- Record a second bug or other deferred work with `--pending "<text>"`, as the scope rule below requires, and remove an item when it is done with `--done "<text>"`.

## Phase 1 — Reproduce

1. Read the issue or symptom description. For a GitHub issue: `gh issue view <N>`.
2. Use `Grep` + `Read` to locate the code path involved. Cite `file:line` references.
3. Write a test that reproduces the bug. Add it to the appropriate test file.
4. Run the test. **Paste the actual failure output** in your response.

**Gate:** do not proceed to Phase 2 until you have a failing test with output captured. If the bug cannot be reproduced in a test, STOP and ask the user how they observed it.

When the gate passes: `dotbabel task update <slug> --phase fix --decision "reproduced by <test name>"`.

## Phase 2 — Fix

1. Propose a minimal change. Avoid scope creep — touch only what is required to make the failing test pass.
2. Apply the edit.
3. Do not refactor surrounding code, rename variables, or "clean up" unrelated issues in the same commit.

**Gate:** if the fix requires touching more than ~3 files or reveals a misunderstanding of the issue, STOP and re-scope with the user. Do not patch forward.

When the gate passes: `dotbabel task update <slug> --phase verify --decision "root cause: <file:line>"`.

## Phase 3 — Verify

1. Run the **full** project test suite (not just the new test). Detect runner from `Makefile` / `package.json` / `go.mod` / `pyproject.toml`.
2. For any failure other than your new test (which should now pass), prove whether it is pre-existing:
   ```bash
   git stash
   <test-command>
   git stash pop
   ```
   If the failure survives the stash, it is pre-existing — record that. If it disappears, your fix introduced a regression — return to Phase 2.
3. Record before/after test counts: `N passed, M failed` on `main` vs on the branch.

**Gate:** do not proceed to Phase 4 until the full suite is green on the branch OR every non-green test is proven pre-existing with stash output.

When the gate passes: `dotbabel task update <slug> --phase pr --decision "<before> -> <after> test counts"`.

## Phase 4 — PR

1. Write the PR body to a temporary file (not heredoc, to avoid backtick escaping):

   ```
   ## Summary
   <1–3 bullets>

   ## Reproduction
   <how the bug was observed; include the failing test added in Phase 1>

   ## Root Cause
   <what was actually wrong; cite file:line>

   ## Fix
   <what changed and why; cite file:line>

   ## Test Evidence
   Before: <passed>/<failed> on main
   After:  <passed>/<failed> on branch
   <paste tail of test output>

   ## Risk
   <what could break; what you did not touch>

   Spec ID: <id if applicable>
   ```

2. Open the PR:
   ```bash
   gh pr create --title "<title>" --body-file /tmp/pr-body.md
   ```
3. Record the PR and close the task: `dotbabel task update <slug> --decision "PR <url>"`, then `dotbabel task close <slug>`. Leave the task open if a pending item is still open, and name the item to the user.
4. Report the PR URL to the user. Do not merge — that is a separate decision (use `/merge-pr`).

## Rules

- Never skip Phase 1. A fix without a reproducing test is a guess.
- Never claim a failure is "pre-existing" without the `git stash` proof.
- Never expand scope mid-fix. If you find a second bug, note it and create a separate issue — do not bundle.
- Never heredoc PR bodies — always `--body-file`.
- If any phase reveals the original issue was misunderstood, STOP, re-scope, and restart from Phase 1 on the corrected understanding.
