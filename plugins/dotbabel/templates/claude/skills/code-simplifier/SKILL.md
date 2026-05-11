---
id: code-simplifier
name: code-simplifier
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [review]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-11
updated: 2026-05-11
description: >
  Simplify and refine changed code for clarity, consistency, and maintainability
  while preserving all functionality. PR-scoped by default.
  Triggers on: "simplify code", "code simplifier", "clean up the code", "simplify the PR".
argument-hint: "[PR# | file-glob | base-branch]"
tools: Read, Grep, Glob, Bash
model: sonnet
---

Simplify and refine changed code for clarity, consistency, and maintainability while preserving all functionality. PR-scoped by default — operates only on files changed in the current branch.

Trigger: when the user asks to "simplify code", "clean up the code", "simplify the PR", or "run the code simplifier". Also triggered directly via `/code-simplifier [arg]`.

Arguments: `$ARGUMENTS` — optional. Accepts a PR number (e.g. `42`), a file glob (e.g. `src/**/*.ts`), or a base branch (e.g. `origin/develop`). If empty, defaults to files changed vs `origin/main`.

## Steps

### 1. Detect scope

Determine which files to simplify.

If `$ARGUMENTS` is a number, treat it as a PR and fetch the changed file list:

```bash
gh pr diff "$ARGUMENTS" --name-only
```

If `$ARGUMENTS` is a file glob, expand it:

```bash
git ls-files -- $ARGUMENTS
```

If `$ARGUMENTS` is a branch name or empty, diff against the base:

```bash
BASE="${ARGUMENTS:-origin/main}"
# Fallback if origin/main doesn't exist
if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/||')
  if [ -z "$BASE" ]; then
    echo "ERROR: cannot determine base branch. Pass a base branch as argument."
    exit 1
  fi
fi
MERGE_BASE=$(git merge-base HEAD "$BASE")
git diff "$MERGE_BASE" --name-only
```

Filter to code files only — skip binary files, images, lockfiles, and generated artifacts (`index/`, `.claude/skills-manifest.json`, `**/node_modules/**`).

**Gate:** if zero files are in scope, stop: "No changed code files detected — nothing to simplify."

Report: "Scope: N files changed vs $BASE."

### 2. Read project conventions

Read the project's `CLAUDE.md` (if present) to discover language-specific coding standards, naming conventions, and formatting preferences. Do not assume any language or framework — let the project's own instructions guide your simplification choices.

If no `CLAUDE.md` exists, apply universal simplification principles only.

### 3. Read changed files

Read each file identified in step 1 in full. For large files (>500 lines), focus on the changed hunks by reading the diff:

```bash
git diff "$MERGE_BASE" -- <file>
```

### 4. Analyze for simplification opportunities

For each file, identify opportunities to improve clarity without changing behavior:

- **Reduce nesting:** flatten deeply nested if/else chains, extract early returns
- **Eliminate redundancy:** remove duplicate logic, consolidate repeated patterns
- **Improve naming:** rename unclear variables and functions to express intent
- **Remove dead code:** delete unreachable code, unused imports, commented-out blocks — but only within the changed scope
- **Simplify control flow:** replace overly clever constructs with straightforward alternatives
  - Avoid nested ternary operators — prefer switch statements or if/else chains for multiple conditions
  - Choose clarity over brevity — explicit code is better than dense one-liners
- **Consolidate related logic:** group related statements, reduce unnecessary indirection
- **Remove noise comments:** delete comments that describe what the code obviously does

**Balance:** do not over-simplify. Avoid:

- Creating overly clever solutions that are harder to understand
- Combining too many concerns into single functions
- Removing helpful abstractions that improve organization
- Prioritizing "fewer lines" over readability
- Making the code harder to debug or extend

### 5. Apply edits

Edit each file using the Edit tool. One edit per logical simplification — do not batch unrelated changes into a single edit.

**Hard rules:**

- **MUST NOT edit files outside the scope from step 1.** This is the most important guardrail. If a simplification opportunity exists in an unchanged file, mention it in the report but do not touch it.
- **MUST NOT change behavior.** Only change how the code is expressed, never what it does. All original features, outputs, and behaviors must remain intact.
- **MUST NOT auto-commit.** Leave changes in the working tree. The user or calling skill (e.g. `/pre-pr`) decides whether to commit.
- **MUST NOT add new dependencies, features, or abstractions** beyond what the existing code already uses.

### 6. Report

After all edits, provide a concise summary:

```
Code simplification: <branch> (base: <base>)

  Files analyzed: N
  Files modified: M
  Files skipped:  K (no opportunities found)

  Changes:
    - <file>: <one-line description of what changed and why>
    - <file>: <one-line description>

  Out-of-scope opportunities (not applied):
    - <file>:<line>: <description> (file not in changed set)
```

If no simplification opportunities were found: "Code simplification: clean — no changes needed."
