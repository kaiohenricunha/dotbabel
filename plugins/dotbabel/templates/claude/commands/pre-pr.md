---
id: pre-pr
name: pre-pr
type: command
version: 1.0.1
domain: [devex]
platform: [none]
task: [review, testing]
maturity: draft
description: >
  Pre-PR quality gate: simplify changed code, security-review the diff, run the full test
  suite, and surface a go/no-go summary before opening a pull request.
argument-hint: "[base-branch] — default: origin/main"
model: sonnet
headless_safe: false
---

Quality gate to run before `/git pr`. Simplifies changed code, security-reviews the diff, runs the full test suite, and surfaces a go/no-go summary. Does not open the PR — that is `/git pr`.

Trigger: when the user is done with a feature and is about to open a PR, or says "prepare PR", "pre-PR", or "clean up before PR". Also triggered directly via `/pre-pr [base-branch]`.

Arguments: `$ARGUMENTS` — optional base branch. Defaults to `origin/main`.

**Lifecycle:**

```
/git (commit) → /pre-pr → /git pr (open PR) → /review-pr → /merge-pr
```

## Steps

### 1. Detect scope

Bind: `BASE="${ARGUMENTS:-origin/main}"`.

Guard — verify not on main/master:

```bash
BRANCH=$(git branch --show-current)
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ERROR: currently on $BRANCH. Create a feature branch before opening a PR."
  exit 1
fi
```

Identify changed files vs base:

```bash
git fetch origin
MERGE_BASE=$(git merge-base HEAD "$BASE")
git diff "$MERGE_BASE" --name-only
git diff "$MERGE_BASE" --stat
```

Report: "N files changed vs $BASE on branch $BRANCH."

If zero files changed vs base, stop: "No changes detected vs $BASE — nothing to gate."

### 2. Simplify changed code

`/code-simplifier` is a dotbabel skill — available in all agents after bootstrap.

```
/code-simplifier $BASE
```

Pass `$BASE` explicitly so the skill uses the same base branch already resolved in step 1, rather than re-detecting it from scratch.

After it completes, check for unstaged changes:

```bash
git diff --stat
```

If simplify introduced changes, stage and commit them atomically:

```bash
git add -p   # stage only simplify's changes, not unrelated WIP
git commit -m "style: pre-pr simplification pass"
```

Record in summary: "Simplified N files, M changes staged." If no changes: "simplify: clean."

### 3. Security review

In pre-PR context all branch changes are committed and the working tree is clean, so `git diff --cached` (the security-review default) would see nothing. Stage the diff vs base explicitly before invoking:

```bash
git diff "$MERGE_BASE" | git apply --cached --allow-empty
```

Then run:

```
/security-review staged
```

Then unstage:

```bash
git restore --staged .
```

If the skill is not available in this session (not bootstrapped, non-dotbabel environment):

```
⚠ security-review skill not available — skipping. Run /security-review manually before opening the PR.
```

Continue. Unavailability is a warning, not a gate failure.

Classify findings:

- **CRITICAL** → **STOP immediately.** Surface every finding and tell the user to fix before opening the PR. Do not proceed to steps 4–6.
- **WARNING** → record; surface in the go/no-go summary. Do not stop.
- **INFO** → record in summary only.
- No findings → record "security: clean."

### 4. Run the full test suite

Detect runner from the project:

| Signal                        | Command                                                |
| ----------------------------- | ------------------------------------------------------ |
| `Makefile` with `test` target | `make test`                                            |
| `package.json`                | `npm test` (or `pnpm test` / `yarn test` per lockfile) |
| `go.mod`                      | `go test ./...`                                        |
| `pyproject.toml`              | `pytest` or `uv run pytest`                            |

Run and paste the **last 40 lines** of output regardless of pass/fail.

**If tests fail**, determine whether the failure is branch-introduced or pre-existing:

```bash
git stash
<test-command>
git stash pop
```

- Failure survives stash → pre-existing. Note in summary, do not stop.
- Failure disappears → introduced by this branch. **STOP.** Tell the user to fix the regression before opening the PR.

Never claim pre-existing without running this proof.

### 5. PR body checklist reminder

Do not generate the PR body — that is `/git pr`'s responsibility. Just surface a reminder of required sections so the user can write them before opening:

```
PR body checklist (dotbabel conventions):
  [ ] ## Summary — 1–3 bullets describing the change
  [ ] ## Test plan — bulleted markdown checklist
  [ ] ## Spec ID — required if this repo uses specs (check for docs/specs/)
  [ ] ## No-spec rationale — required if touching a protected path without a spec
```

Check for protected paths: if any changed file matches an entry under **Protected paths (dogfood)** in CLAUDE.md, remind the user that a Spec ID or No-spec rationale section is required in the PR body. (The authoritative list lives in `docs/repo-facts.json` — do not hard-code it here.)

### 6. Go/no-go summary

```
Pre-PR gate: branch → $BRANCH (base: $BASE)

  Step 1 — Scope:     N files changed
  Step 2 — Simplify:  N files, M changes committed as style: pre-pr simplification pass
                   |  simplify: clean (no changes)
  Step 3 — Security:  clean (diff vs $MERGE_BASE)
                   |  N warnings (see above)
                   |  ⚠ skill unavailable — skipped
  Step 4 — Tests:     ✓ pass
                   |  ✗ fail — pre-existing (stash proof above)
                   |  ✗ fail — THIS BRANCH (BLOCKED)
  Step 5 — PR body:   checklist above

Status: READY — run `/git pr` to open the pull request.
     |  BLOCKED — <reason>. Fix the issue above before opening the PR.
```

## Rules

- **Never open the PR.** That is `/git pr`. This command only gates.
- **STOP on CRITICAL security findings.** Do not advance to steps 4–6; surface findings immediately.
- **STOP if tests fail and the failure is branch-introduced.** Stash proof is required — same standard as `merge-pr`.
- **Never claim a test failure is pre-existing** without the `git stash` proof.
- **Security-review unavailable is a warning, not a failure.** Warn, skip, continue.
- **Simplify commits are style commits.** Message: `style: pre-pr simplification pass`. Atomic — do not bundle with feature changes.
- **Do not modify files outside the changed set.** Simplify is focused on recently modified code; do not widen the scope.
- **Do not generate or submit the PR body.** Checklist in step 5 is a reminder, not authoring.
