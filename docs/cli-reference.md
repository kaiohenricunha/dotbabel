# CLI reference

_Last updated: v1.2.1_

Every bin honors the **dotclaude-wide flag set** in addition to its own:

| Flag                    | Shape | Behavior                                                                           |
| ----------------------- | ----- | ---------------------------------------------------------------------------------- |
| `--help`, `-h`          | bool  | Print usage and exit 0                                                             |
| `--version`, `-V`       | bool  | Print package version and exit 0                                                   |
| `--json`                | bool  | Emit `{events:[…], counts:{pass,fail,warn}}` on stdout; suppress ANSI              |
| `--verbose`, `-v`       | bool  | Print every `StructuredError` field (code, pointer, expected, got, hint, category) |
| `--no-color`            | bool  | Suppress ANSI escapes regardless of TTY detection                                  |
| `NO_COLOR=` env         | env   | Same as `--no-color`, honors the cross-tool convention                             |
| `DOTCLAUDE_DEBUG=1` env | env   | Route previously-silent catches through `stderr` tagged `[harness:*]`              |

**Exit codes** follow a single convention across every bin:

| Code | Name         | Meaning                                                                                       |
| ---- | ------------ | --------------------------------------------------------------------------------------------- |
| 0    | `OK`         | Success                                                                                       |
| 1    | `VALIDATION` | One or more validation rules failed (expected failure mode)                                   |
| 2    | `ENV`        | Misconfigured environment (missing file, bad git repo, unreadable facts)                      |
| 64   | `USAGE`      | Bad CLI invocation (unknown flag, missing positional). `64` matches BSD `sysexits.h EX_USAGE` |

**The umbrella `dotclaude`** forwards to each `dotclaude-<sub>` bin:

```
# Governance validators
dotclaude validate-specs [OPTIONS]
dotclaude validate-skills [OPTIONS]
dotclaude check-spec-coverage [OPTIONS]
dotclaude check-instruction-drift [OPTIONS]
dotclaude detect-drift [OPTIONS]
dotclaude doctor [OPTIONS]
dotclaude init [OPTIONS]

# Installation lifecycle (added v0.4.0)
dotclaude bootstrap [OPTIONS]
dotclaude sync <pull|push|status> [OPTIONS]

# Taxonomy discovery (added v0.4.0)
dotclaude index [OPTIONS]
dotclaude search <query> [OPTIONS]
dotclaude list [OPTIONS]
dotclaude show <id> [OPTIONS]
```

Each subcommand also exists standalone — `npx dotclaude-doctor` and
`npx dotclaude doctor` are identical.

---

## `dotclaude-validate-specs`

Validate every `docs/specs/<id>/spec.json` against the `StructuredError`
contract.

| Flag                 | Default                         |                                 |
| -------------------- | ------------------------------- | ------------------------------- |
| `--repo-root <path>` | `git rev-parse --show-toplevel` | Override the implicit repo root |

**Typical invocations:**

```bash
npx dotclaude-validate-specs
npx dotclaude-validate-specs --json | jq -r '.events[] | select(.kind == "fail") | .details.code'
```

**Emitted codes**: `SPEC_JSON_INVALID`, `SPEC_STATUS_INVALID`,
`SPEC_ID_MISMATCH`, `SPEC_MISSING_REQUIRED_FIELD`,
`SPEC_LINKED_PATH_MISSING`, `SPEC_ACCEPTANCE_EMPTY`,
`SPEC_DEPENDENCY_UNKNOWN`.

---

## `dotclaude-validate-skills`

Validate `.claude/skills-manifest.json` — checksums, orphan files on disk,
and the `dependencies[]` DAG.

| Flag                 | Default          |                                                          |
| -------------------- | ---------------- | -------------------------------------------------------- |
| `--repo-root <path>` | resolved via git | Override the repo root                                   |
| `--update`           | false            | Recompute every sha256 and rewrite the manifest in place |

**Emitted codes**: `MANIFEST_ENTRY_MISSING`, `MANIFEST_CHECKSUM_MISMATCH`,
`MANIFEST_ORPHAN_FILE`, `MANIFEST_DEPENDENCY_CYCLE`.

---

## `dotclaude-check-instruction-drift`

Cross-reference `docs/repo-facts.json` against instruction files (CLAUDE.md,
README.md). Flags stale `team_count` claims, undocumented `protected_paths`,
and broken `instruction_files` references.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

**Emitted codes**: `DRIFT_TEAM_COUNT`, `DRIFT_PROTECTED_PATH`,
`DRIFT_INSTRUCTION_FILES`, `DRIFT_INSTRUCTION_FILE_MISSING`.

---

## `dotclaude-check-spec-coverage`

PR-time gate. Confirms every change to a protected path is covered by an
`approved|implementing|done` spec, or the PR body carries a
`## No-spec rationale` section. Bot actors (`dependabot[bot]`,
`github-actions[bot]`) bypass.

Reads context from the environment — designed for GitHub Actions:

| Env var                 | Role                                          |
| ----------------------- | --------------------------------------------- |
| `GITHUB_EVENT_NAME`     | Must be `pull_request` for gating to activate |
| `GITHUB_BASE_REF`       | Base branch for the diff (defaults to `main`) |
| `GITHUB_ACTOR`          | Actor login, used for bot-bypass              |
| `PR_BODY`               | PR body text (workflow pipes it in)           |
| `HARNESS_CHANGED_FILES` | CSV override — skip the git-diff probe        |

**Emitted codes**: `COVERAGE_UNCOVERED`, `COVERAGE_NO_SPEC_RATIONALE`,
`COVERAGE_UNKNOWN_SPEC_ID`.

---

## `dotclaude-doctor`

Self-diagnostic. Walks env → repo → facts → manifest → specs → drift →
hook. Prints `✓/✗/⚠` per check.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

**Exits 2** (`ENV`) when env/repo checks fail before validation can run.

---

## `dotclaude-detect-drift`

Flags `.claude/commands/*.md` that have diverged from `origin/main` for
longer than 14 days. Thin wrapper over
`plugins/dotclaude/scripts/detect-branch-drift.mjs`.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

Exits 0 when nothing is stale; 1 when any file has been behind `origin/main`
for more than 14 days.

---

## `dotclaude-init`

Scaffold the template tree into a target repo.

| Flag                    | Default         |                                       |
| ----------------------- | --------------- | ------------------------------------- |
| `--project-name <name>` | `basename(cwd)` | Substituted for `{{project_name}}`    |
| `--project-type <type>` | `"unknown"`     | Substituted for `{{project_type}}`    |
| `--target-dir <path>`   | `cwd`           | Destination directory                 |
| `--force`               | false           | Overwrite an already-initialized repo |

Throws `ValidationError(SCAFFOLD_CONFLICT)` when
`.claude/skills-manifest.json` or `docs/specs/` already exists — use
`--force` to overwrite.

---

## `validate-settings.sh`

Shell validator for `~/.claude/settings.json`. Enforces the hardening
contract:

### Hardening contract

- **SEC-1** no secret literals in `*_KEY`/`*_TOKEN`/`*_SECRET` fields
- **SEC-2** `skipDangerousModePermissionPrompt` must not be present
- **SEC-3** no `@latest` in MCP args
- **SEC-4** `.credentials.json` mode 600
- **OPS-1** JSON well-formed; every MCP command resolves; every hook target
  exists; every `enabledPlugins` key is installed
- **OPS-2** disk-size budget warnings on `~/.claude/projects/` and
  `~/.claude/file-history/`

```bash
bash plugins/dotclaude/scripts/validate-settings.sh
bash plugins/dotclaude/scripts/validate-settings.sh --json <path>
```

`--json` emits `{events:[{check,category,status,message}], counts:{fail,warn}}`.

---

## `dotclaude-bootstrap` _(added v0.4.0)_

Set up or refresh `~/.claude/` by symlinking `commands/`, `skills/`, and
`CLAUDE.md` from the dotclaude source, and copying agent templates into
`~/.claude/agents/`. Idempotent — safe to re-run after pulling new commits.
Pre-existing real files (not symlinks) are backed up to `<name>.bak-<timestamp>`.

> **Platform note:** Windows is not supported (symlinks require elevated
> permissions). Use WSL or run `bootstrap.sh` from Git Bash instead.

| Flag              | Default     |                                                  |
| ----------------- | ----------- | ------------------------------------------------ |
| `--source <path>` | npm install | Path to a local dotclaude git clone (clone mode) |
| `--target <dir>`  | `~/.claude` | Override destination directory                   |
| `--quiet`         | false       | Suppress per-file progress; print summary only   |

**Typical invocations:**

```bash
dotclaude bootstrap
dotclaude bootstrap --source ~/projects/dotclaude   # clone mode
dotclaude bootstrap --quiet
```

**Returns** a summary with counts: `{linked, skipped, backed_up}`.

---

## `dotclaude-sync` _(added v0.4.0)_

Pull, push, or check status for a dotclaude installation. Works in two modes:
**npm mode** (default — installed globally via npm) or **clone mode** (local
git checkout, activated with `--source`).

| Flag              | Default     |                                     |
| ----------------- | ----------- | ----------------------------------- |
| `--source <path>` | npm install | Path to a local dotclaude git clone |
| `--quiet`         | false       | Suppress per-file progress          |

**Subcommands:**

| Subcommand | Description                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pull`     | npm mode: fetch latest from registry and re-bootstrap. Clone mode: `git fetch` + `git rebase origin/main` + re-bootstrap.        |
| `push`     | Clone mode only: secret-scan staged files, commit, and push to origin. Set `HARNESS_SYNC_SKIP_SECRET_SCAN=1` to bypass the scan. |
| `status`   | npm mode: print current version. Clone mode: `git status --short`.                                                               |

**Typical invocations:**

```bash
dotclaude sync pull            # update to latest
dotclaude sync status          # check installed version
dotclaude sync push            # commit + push local changes (clone mode)
```

---

## `dotclaude-index` _(added v0.4.0)_

Rebuild the taxonomy index (`index/artifacts.json`, `index/by-type.json`,
`index/by-facet.json`) from authored artifacts in `agents/`, `skills/`,
`commands/`, `hooks/`, and `templates/`. Required before `search`, `list`,
and `show` can operate.

| Flag                 | Default          |                                            |
| -------------------- | ---------------- | ------------------------------------------ |
| `--repo-root <path>` | resolved via git | Override repo root                         |
| `--check`            | false            | Verify index is fresh without writing (CI) |
| `--strict`           | false            | Fail on schema validation warnings         |

**Typical invocations:**

```bash
dotclaude index                    # rebuild
dotclaude index --check            # CI freshness gate — exit 1 if stale
dotclaude index --strict           # fail on any warning
```

**Emitted codes** (when `--check` fails): `INDEX_STALE`.

---

## `dotclaude-search` _(added v0.4.0)_

Full-text search over the taxonomy index by name, id, and description.
Requires `dotclaude index` to have been run at least once.

| Flag                 | Default          |                                                        |
| -------------------- | ---------------- | ------------------------------------------------------ |
| `--repo-root <path>` | resolved via git | Override repo root                                     |
| `--type <type>`      | —                | Filter to one artifact type (agent, skill, command, …) |

**Typical invocations:**

```bash
dotclaude search kubernetes
dotclaude search "IaC module" --type skill
dotclaude search aws --json | jq -r '.[] | .id'
```

Searches are case-insensitive. Exit 2 if the index is missing.

---

## `dotclaude-list` _(added v0.4.0)_

List all artifacts from the taxonomy index with optional facet filters.
Requires `dotclaude index` to have been run at least once.

| Flag                    | Default          |                          |
| ----------------------- | ---------------- | ------------------------ |
| `--repo-root <path>`    | resolved via git | Override repo root       |
| `--type <type>`         | —                | Filter by artifact type  |
| `--domain <domain>`     | —                | Filter by domain facet   |
| `--platform <platform>` | —                | Filter by platform facet |
| `--task <task>`         | —                | Filter by task facet     |
| `--maturity <maturity>` | —                | Filter by maturity level |

All filters are optional; omitting them lists everything. Multiple filters
combine with AND logic.

**Typical invocations:**

```bash
dotclaude list
dotclaude list --type command
dotclaude list --domain devex --maturity validated
dotclaude list --json | jq -r '.[].id'
```

---

## `dotclaude-show` _(added v0.4.0)_

Display detailed metadata for a single artifact by its id. When a skill and
agent share an id, use `--type` to disambiguate.

| Flag                 | Default          |                                                |
| -------------------- | ---------------- | ---------------------------------------------- |
| `--repo-root <path>` | resolved via git | Override repo root                             |
| `--type <type>`      | —                | Force type when multiple artifacts share an id |

**Typical invocations:**

```bash
dotclaude show aws-specialist
dotclaude show review-pr --type command
dotclaude show pre-pr --json
```

Exit 1 if the artifact is not found. Exit 2 if the index is missing.
