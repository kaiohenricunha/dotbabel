# CLI reference

Every bin honors the **harness-wide flag set** in addition to its own:

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
dotclaude validate-specs [OPTIONS]
dotclaude validate-skills [OPTIONS]
dotclaude check-spec-coverage [OPTIONS]
dotclaude check-instruction-drift [OPTIONS]
dotclaude detect-drift [OPTIONS]
dotclaude doctor [OPTIONS]
dotclaude init [OPTIONS]
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
