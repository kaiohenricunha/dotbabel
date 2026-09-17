---
id: markdown
name: markdown
type: command
version: 1.0.0
domain: [devex, writing]
platform: [none]
task: [documentation]
maturity: validated
description: >
  Fix markdown formatting and structure across a file or directory. Normalizes headings, tables, code blocks, link references.
argument-hint: "[file | dir]"
model: haiku
---

# Command: fix_markdown

## Purpose

Detect and fix Markdown lint issues using `markdownlint-cli2`.  
This command enforces repository documentation standards and must be run on any modified `.md` files.

## Scope

- Default: `docs/`
- Optional: entire repository or a specific file

## Execution Rules

- Prefer `npx markdownlint-cli2` (no global assumptions).
- Auto-fix whenever possible.
- Fail if issues remain after auto-fix.
- Never claim completion unless lint passes.

## Steps

### 1. Determine target scope

Use one of:

- Single file
- `docs/` directory
- Entire repository

### 2. Run markdownlint check

#### Single file

```bash
npx markdownlint-cli2 path/to/file.md
```

#### Docs directory

```bash
npx markdownlint-cli2 "docs/**/*.md"
```

#### Entire repository

```bash
npx markdownlint-cli2 "**/*.md"
```

### 3. Auto-fix issues

#### Single file

```bash
npx markdownlint-cli2 --fix path/to/file.md
```

#### Docs directory

```bash
npx markdownlint-cli2 --fix "docs/**/*.md"
```

#### Entire repository

```bash
npx markdownlint-cli2 --fix "**/*.md"
```

### 4. Re-run validation

Re-run the **same check command** from Step 2.
If any errors remain, stop and report them explicitly.

## Required Fixes to Enforce

- **MD040**: All fenced code blocks must specify a language.
- **MD036**: Do not use emphasis as headings.
- **MD051**: Internal links must point to valid anchors.
- **MD024**: Avoid duplicate headings in the same document.

## Optional Helpers (if present in repo)

### Script-based fix

```bash
./scripts/fix-markdown.sh docs/
```

### Makefile targets

```bash
make lint-docs
make fix-docs
```

## Completion Criteria

This command is complete only when:

- All targeted `.md` files pass markdownlint
- No warnings or errors remain
- No formatting regressions are introduced

If markdownlint was forgotten before commit:

```bash
./scripts/fix-markdown.sh docs/
git add docs/
git commit --amend --no-edit
```

## Prohibited Behavior

- Do not ignore markdownlint errors.
- Do not mark documentation complete without validation.
- Do not introduce new markdown violations while fixing others.
