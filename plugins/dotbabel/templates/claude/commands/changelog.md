---
id: changelog
name: changelog
type: command
description: >
  Generate a changelog entry from git history. Defaults to commits since the last tag or the last 20 commits.
version: 1.0.0
domain: [devex]
platform: [none]
task: [documentation]
maturity: validated
argument-hint: "[ref-range|count|since-deploy]"
model: haiku
---

Generate a changelog entry from git history.

Arguments: `$ARGUMENTS` (optional: a ref range like `v1.0..HEAD`, a count like `20`, or `since-deploy` to use the last deploy commit. Default: commits since the last tag, or the last 20 commits if no tags exist.)

## Steps

### 1. Determine range

```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
```

- If a tag exists: range = `$LAST_TAG..HEAD`
- If `since-deploy`: find last deploy commit (grep recent messages for `deploy`, `ship`, or `release`)
- If a number was given: last N commits
- If no tags and no argument: last 20 commits

### 2. Collect commits

```bash
git log <range> --oneline --no-merges
```

### 3. Categorize by conventional commit prefix

Group commits into:

- **Features** (`feat:`)
- **Fixes** (`fix:`)
- **Performance** (`perf:`)
- **Refactoring** (`refactor:`)
- **Infrastructure** (`chore:`, `ci:`, `build:`)
- **Documentation** (`docs:`)
- **Tests** (`test:`)
- **Data** (commits touching data/content files — detect via paths that match a repo's data directories, e.g. `data/`, `content/`, or specific generated files tracked in git)
- **Other** (commits without conventional prefix)

### 4. Generate entry

Format:

```markdown
## [Unreleased] — YYYY-MM-DD

### Added

- Feature description (abc1234)

### Fixed

- Fix description (abc1234)

### Changed

- Refactor or behavior change (abc1234)

### Data

- Content/data update description (abc1234)

### Infrastructure

- Build/CI/deps description (abc1234)
```

Omit empty sections. Include short commit hashes for traceability. Use Keep-a-Changelog section names (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`) when the project already follows that convention.

### 5. Output

Print the changelog entry to the conversation.

Ask the user:

1. "Prepend this to `CHANGELOG.md`?" (create the file if it doesn't exist — use a standard Keep-a-Changelog header).
2. "Create a git tag for this release?" Suggest a SemVer bump based on the nature of the changes:
   - **patch** (x.y.Z) for fixes, docs, infra
   - **minor** (x.Y.0) for features
   - **major** (X.0.0) for breaking changes

Do NOT auto-commit or auto-tag.
