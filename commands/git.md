---
name: git
description: >
  Project-aware git workflow: conventional commits, PR creation, safe pushes, PR merges, and branch naming suggestions.
argument-hint: "[subcommand]"
---

# /git

A project-aware git workflow command: craft conventional commits, create PRs, push with the right safety rails, merge into main, and suggest branch names.

## Your Domain

| Component | Responsibility |
|-----------|----------------|
| Commits | Craft precise, conventional commit messages |
| Staging | Smart `git add` with awareness of what changed |
| PRs | Generate PR descriptions with `/git pr` |
| Branches | Branch suggestions with `/git suggest` |
| Merging | Merge to main with `/git main` |
| Pushing | Smart push with `/git push` |
| History | Log analysis, blame, bisect |

## Primary Command: Auto-Commit

When invoked without a subcommand, execute this workflow:

### Step 1: Analyze Changes

```bash
git status --porcelain
git diff --stat
git diff --cached --stat
```

### Step 2: Understand the Changes

Read the diff to understand:

- **What** files changed (which area: app code, docs, tests, infra)
- **Why** they changed (feature, fix, refactor, docs, test, chore)
- **Scope** of change (single file, single feature, multiple concerns)

### Step 3: Stage

Prefer staging specific files by name rather than `git add .` or `git add -A`. Only stage what's part of this logical change. If there are unrelated pending changes, surface them and ask.

### Step 4: Craft Commit Message

Use **Conventional Commits** format:

```text
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

#### Types

| Type | When to Use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code change that neither fixes nor adds |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `chore` | Maintenance, deps, config |
| `style` | Formatting, whitespace (no logic change) |
| `perf` | Performance improvement |
| `ci` | CI / workflow changes |

#### Scopes

Infer the scope from the top-level directory or domain concept touched (e.g., `api`, `frontend`, `config`, `docs`, `deps`). If the repo has a CLAUDE.md or CONTRIBUTING.md section listing allowed scopes, follow that. Otherwise, a short area tag is fine.

#### Subject Rules

- **Imperative mood**: "add feature" not "added feature"
- **No period** at the end
- **≤72 characters** for the subject line (50 preferred)
- **Lowercase** first letter

### Step 5: Execute Commit

```bash
git commit -m "<crafted message>"
```

### Step 6: Confirm

Output:

```text
Committed: <hash>
Message:   <type>(<scope>): <subject>
Files:     <count> changed
```

---

## Message Crafting Examples

### Single File Change

```bash
git commit -m "feat(config): add staging environment configuration"
```

### Multiple Related Files

```bash
git commit -m "feat(api): implement user profile endpoint"
```

### Bug Fix

```bash
git commit -m "fix(storage): ensure timestamps use timezone-aware UTC"
```

### Documentation

```bash
git commit -m "docs: mark Phase 2 as complete"
```

### Refactor

```bash
git commit -m "refactor(config): extract resolver helper function"
```

---

## Multi-Concern Detection

If `git diff` shows unrelated changes, warn:

```text
Detected multiple unrelated changes:
   - <file-a> (bug fix)
   - <file-b> (docs update)

Recommendation: commit separately for clean history.

Proceed with combined commit? [y/N]
```

If the user confirms, use a multi-line commit body that lists each concern.

---

## Action: `/git main`

Checkout main and merge the previous branch into it.

```bash
PREVIOUS_BRANCH=$(git branch --show-current)
git checkout main
git pull origin main
git merge "$PREVIOUS_BRANCH"
```

**Error handling:**
- If merge conflicts occur, report them and do NOT auto-resolve.
- If the working directory is dirty, warn and abort.
- If the repo has an explicit rule against committing on main directly (e.g., CLAUDE.md requiring worktrees or PRs), stop and escalate.

---

## Action: `/git push`

Push the current branch, using `--force-with-lease` when history has diverged (post-rebase or post-amend).

```bash
BRANCH=$(git branch --show-current)
git fetch origin

LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u} 2>/dev/null || echo "none")
BASE=$(git merge-base @ @{u} 2>/dev/null || echo "none")

if [ "$REMOTE" = "none" ]; then
    git push -u origin "$BRANCH"
elif [ "$LOCAL" = "$REMOTE" ]; then
    echo "Already up to date with remote"
elif [ "$BASE" = "$REMOTE" ]; then
    git push origin "$BRANCH"
else
    echo "Branch has diverged from remote, using --force-with-lease"
    git push --force-with-lease origin "$BRANCH"
fi
```

**Safety rules:**
- **Never** `--force` without `--with-lease`.
- **Never** force push `main` or `master` without explicit user confirmation.
- Warn if pushing to a protected branch.

---

## Action: `/git main push`

Combined: merge into main, then push main.

```bash
PREVIOUS_BRANCH=$(git branch --show-current)
git checkout main
git pull origin main
git merge "$PREVIOUS_BRANCH"
git push origin main
```

---

## Action: `/git pr`

Create a PR with an auto-generated description.

```bash
git push -u origin "$(git branch --show-current)"
BRANCH=$(git branch --show-current)
BASE="main"
git log "$BASE..$BRANCH" --oneline
git diff "$BASE...$BRANCH" --stat
gh pr create --title "<generated-title>" --body "<generated-body>"
```

**Title rules:**
- Use conventional-commit style: `<type>(<scope>): <subject>`.
- Derive from branch name or most significant commit.

**Body template:**

```markdown
## Summary

<2-3 bullets describing what this PR does>

## Changes

<List of key files or areas modified>

## Testing

- [ ] Unit tests pass (<detected test command, e.g. `npm test`, `pytest`, `go test ./...`>)
- [ ] Manual verification completed
- [ ] No regressions introduced

## Related

- Closes #<issue> (if applicable)
- Part of: <milestone> (if applicable)
```

---

## Action: `/git suggest`

Suggest a branch name for the next unit of work.

1. **Scan planning documents** for next incomplete tasks. Common locations: `docs/roadmap.md`, `docs/plans/*.md`, `TODO.md`, or GitHub issues via `gh issue list --state=open`.

2. **Identify the next task** by looking for:
   - Items marked `[ ]` following items marked `[x]`
   - Phase/milestone boundaries
   - Priority indicators

3. **Generate a branch name** using:

```text
<type>/<scope>-<short-description>
```

| Type | Usage |
|------|-------|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `refactor/` | Code restructuring |
| `docs/` | Documentation updates |
| `test/` | Test additions |
| `chore/` | Maintenance tasks |
| `ci/` | CI/workflow changes |

Scope should match the area conventions used in this repo (detect from recent branch names or CLAUDE.md).

---

## Hard Rules

1. **Never commit secrets.** Check for `.env`, credentials, API keys, tokens in staged files before each commit.
2. **Never force push main or master** without explicit confirmation.
3. **Conventional commits** format, always.
4. **Atomic commits.** One logical change per commit where possible.
5. **Imperative mood** in subjects ("add" not "added").
6. **Respect project rules.** If the repo's CLAUDE.md or equivalent forbids committing on main, or requires worktrees, or demands a PR, follow that over this command's default flow.

---

## Quick Reference

```bash
/git              # stage + commit with crafted message
/git main         # merge current branch into main
/git push         # push current branch (with --force-with-lease when diverged)
/git main push    # merge into main AND push
/git pr           # create a PR with auto-generated description
/git suggest      # suggest next branch name from planning docs
```

---

## Safety Checks (always run before committing)

```bash
# Potential secrets
git diff --cached | grep -iE "(api_key|secret|password|token|bearer|ghp_|sk-[A-Za-z0-9]{20,})" && echo "SECRETS SUSPECTED"

# Large additions
git diff --cached --stat | grep -E "\+[0-9]{4,}" && echo "Large addition detected"

# Binary blobs
git diff --cached --numstat | grep "^-" && echo "Binary file detected"
```