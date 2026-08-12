# CLI reference

_Last updated: v2.15.0_

Every bin honors the **dotbabel-wide flag set** in addition to its own:

| Flag                   | Shape | Behavior                                                                           |
| ---------------------- | ----- | ---------------------------------------------------------------------------------- |
| `--help`, `-h`         | bool  | Print usage and exit 0                                                             |
| `--version`, `-V`      | bool  | Print package version and exit 0                                                   |
| `--json`               | bool  | Emit `{events:[…], counts:{pass,fail,warn}}` on stdout; suppress ANSI              |
| `--verbose`, `-v`      | bool  | Print every `StructuredError` field (code, pointer, expected, got, hint, category) |
| `--no-color`           | bool  | Suppress ANSI escapes regardless of TTY detection                                  |
| `NO_COLOR=` env        | env   | Same as `--no-color`, honors the cross-tool convention                             |
| `DOTBABEL_DEBUG=1` env | env   | Route previously-silent catches through `stderr` tagged `[harness:*]`              |

**Exit codes** follow a single convention across every bin:

| Code | Name         | Meaning                                                                                       |
| ---- | ------------ | --------------------------------------------------------------------------------------------- |
| 0    | `OK`         | Success                                                                                       |
| 1    | `VALIDATION` | One or more validation rules failed (expected failure mode)                                   |
| 2    | `ENV`        | Misconfigured environment (missing file, bad git repo, unreadable facts)                      |
| 64   | `USAGE`      | Bad CLI invocation (unknown flag, missing positional). `64` matches BSD `sysexits.h EX_USAGE` |

**The umbrella `dotbabel`** forwards to each `dotbabel-<sub>` bin:

```
# Governance validators
dotbabel validate-specs [OPTIONS]
dotbabel validate-skills [OPTIONS]
dotbabel check-spec-coverage [OPTIONS]
dotbabel check-instruction-drift [OPTIONS]
dotbabel check-instructions-fresh [OPTIONS]
dotbabel check-instruction-parity [OPTIONS]
dotbabel detect-drift [OPTIONS]
dotbabel doctor [OPTIONS] [--install-hooks]
dotbabel init [OPTIONS]

# Installation lifecycle (added v0.4.0)
dotbabel bootstrap [OPTIONS]
dotbabel sync <pull|push|status> [OPTIONS]

# Taxonomy discovery (added v0.4.0)
dotbabel index [OPTIONS]
dotbabel search <query> [OPTIONS]
dotbabel list [OPTIONS]
dotbabel show <id> [OPTIONS]
```

Each subcommand also exists standalone — `npx dotbabel-doctor` and
`npx dotbabel doctor` are identical.

---

## `dotbabel-validate-specs`

Validate every `docs/specs/<id>/spec.json` against the `StructuredError`
contract.

| Flag                 | Default                         |                                 |
| -------------------- | ------------------------------- | ------------------------------- |
| `--repo-root <path>` | `git rev-parse --show-toplevel` | Override the implicit repo root |

**Typical invocations:**

```bash
npx dotbabel-validate-specs
npx dotbabel-validate-specs --json | jq -r '.events[] | select(.kind == "fail") | .details.code'
```

**Emitted codes**: `SPEC_JSON_INVALID`, `SPEC_STATUS_INVALID`,
`SPEC_ID_MISMATCH`, `SPEC_MISSING_REQUIRED_FIELD`,
`SPEC_LINKED_PATH_MISSING`, `SPEC_ACCEPTANCE_EMPTY`,
`SPEC_DEPENDENCY_UNKNOWN`.

---

## `dotbabel-validate-skills`

Validate `.claude/skills-manifest.json` — checksums, orphan files on disk,
and the `dependencies[]` DAG.

| Flag                 | Default          |                                                          |
| -------------------- | ---------------- | -------------------------------------------------------- |
| `--repo-root <path>` | resolved via git | Override the repo root                                   |
| `--update`           | false            | Recompute every sha256 and rewrite the manifest in place |

**Emitted codes**: `MANIFEST_ENTRY_MISSING`, `MANIFEST_CHECKSUM_MISMATCH`,
`MANIFEST_ORPHAN_FILE`, `MANIFEST_DEPENDENCY_CYCLE`.

---

## `dotbabel-check-instruction-drift`

Cross-reference `docs/repo-facts.json` against instruction files (CLAUDE.md,
README.md, AGENTS.md, GEMINI.md, generated CLI templates). Flags stale
`team_count` claims, undocumented `protected_paths` in `rule_floor_files`,
stale generated rule-floor outputs, and broken instruction-file references.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

**Emitted codes**: `DRIFT_TEAM_COUNT`, `DRIFT_PROTECTED_PATH`,
`DRIFT_INSTRUCTION_FILES`, `DRIFT_INSTRUCTION_FILE_MISSING`,
`DRIFT_GENERATED_STALE`.

---

## `dotbabel-check-instructions-fresh`

Re-render cross-CLI instruction outputs from `CLAUDE.md` and fail when any
generated target or manifest differs from the committed file.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

**Emitted codes**: `DRIFT_GENERATED_STALE`, plus span/marker drift codes from
the generator when `CLAUDE.md` is malformed.

---

## `dotbabel-check-instruction-parity`

Verify each generated CLI instruction target preserves every `#` / `##`
heading that applies to that target after CLI-conditional spans are rendered.
Headings intentionally omitted by `<!-- dotbabel:cli ... -->` spans are not
treated as parity failures.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

**Emitted codes**: `DRIFT_PARITY_MISSING_HEADING`,
`DRIFT_INSTRUCTION_FILE_MISSING`.

---

## `dotbabel-check-spec-coverage`

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

## `dotbabel-doctor`

Self-diagnostic. Walks env → repo → facts → manifest → specs → drift →
hook → check-on-stop trust. Prints `✓/✗/⚠` per check.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

The trust row reports whether this repo may run turn-end project checks. It
never fails the run — a repo deliberately left off the allowlist is a valid
state. See [hooks.md](./hooks.md#check-on-stop-trust).

**Exits 2** (`ENV`) when env/repo checks fail before validation can run.

---

## `dotbabel-detect-drift`

Flags `.claude/commands/*.md` that have diverged from `origin/main` for
longer than 14 days. Thin wrapper over
`plugins/dotbabel/scripts/detect-branch-drift.mjs`.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

Exits 0 when nothing is stale; 1 when any file has been behind `origin/main`
for more than 14 days.

---

## `dotbabel-init`

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

## `dotbabel-project-init`

Scaffold the minimum cross-CLI project-sync layout — `.dotbabel.json`, a
`.claude/` skeleton, and a starter `CLAUDE.md`. Distinct from `dotbabel-init`,
which scaffolds the full spec-governance harness.

| Flag            | Default |                                          |
| --------------- | ------- | ---------------------------------------- |
| `--repo <path>` | `cwd`   | Target repo root                         |
| `--force`       | false   | Overwrite an existing `.dotbabel.json`   |
| `--dry-run`     | false   | Report planned actions, mutate nothing   |
| `--trust`       | false   | Also grant this repo check-on-stop trust |

`--trust` records the repo's resolved path in
`~/.config/dotbabel/check-on-stop-trusted`, which permits `check-on-stop.sh` to
run that project's build tooling at turn end. It is opt-in because build tooling
executes repo-controlled code — see [hooks.md](./hooks.md#check-on-stop-trust).
A failed grant warns and still exits 0; the scaffold has already succeeded by
then.

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
bash plugins/dotbabel/scripts/validate-settings.sh
bash plugins/dotbabel/scripts/validate-settings.sh --json <path>
```

`--json` emits `{events:[{check,category,status,message}], counts:{fail,warn}}`.

---

## `dotbabel-bootstrap` _(added v0.4.0)_

Set up or refresh `~/.claude/` by symlinking `commands/`, `skills/`, and
`CLAUDE.md` from the dotbabel source, and copying agent templates into
`~/.claude/agents/`. Idempotent — safe to re-run after pulling new commits.
Pre-existing real files (not symlinks) are backed up to `<name>.bak-<timestamp>`.

> **Platform note:** Windows is not supported (symlinks require elevated
> permissions). Use WSL or run `bootstrap.sh` from Git Bash instead.

| Flag              | Default     |                                                                                             |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `--source <path>` | npm install | Path to a local dotbabel git clone (clone mode)                                             |
| `--target <dir>`  | `~/.claude` | Override destination directory                                                              |
| `--all`           | false       | Link Copilot/Codex/Gemini instructions and fan out skills to `~/.codex/`, `~/.gemini/`.[^1] |
| `--quiet`         | false       | Suppress per-file progress; print summary only                                              |

[^1]: Skills fan out to `~/.codex/skills/` and `~/.gemini/skills/`. Copilot has no skill auto-discovery directory, so only its instruction file is linked.

**Typical invocations:**

```bash
dotbabel bootstrap
dotbabel bootstrap --source ~/projects/dotbabel   # clone mode
dotbabel bootstrap --all                          # force all CLI instruction symlinks
dotbabel bootstrap --quiet
```

**Returns** a summary with counts: `{linked, skipped, backed_up}`.

---

## `dotbabel-sync` _(added v0.4.0)_

Pull, push, or check status for a dotbabel installation. Works in two modes:
**npm mode** (default — installed globally via npm) or **clone mode** (local
git checkout, activated with `--source`).

| Flag              | Default     |                                    |
| ----------------- | ----------- | ---------------------------------- |
| `--source <path>` | npm install | Path to a local dotbabel git clone |
| `--quiet`         | false       | Suppress per-file progress         |

**Subcommands:**

| Subcommand | Description                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull`     | npm mode: fetch latest from registry and re-bootstrap. Clone mode: `git fetch` + `git rebase origin/main`, regenerate cross-CLI instructions, run freshness, then re-bootstrap. |
| `push`     | Clone mode only: secret-scan staged files, commit, and push to origin. Set `HARNESS_SYNC_SKIP_SECRET_SCAN=1` to bypass the scan.                                                |
| `status`   | npm mode: print current version. Clone mode: `git status --short`.                                                                                                              |

**Typical invocations:**

```bash
dotbabel sync pull            # update to latest
dotbabel sync status          # check installed version
dotbabel sync push            # commit + push local changes (clone mode)
```

---

## `dotbabel-index` _(added v0.4.0)_

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
dotbabel index                    # rebuild
dotbabel index --check            # CI freshness gate — exit 1 if stale
dotbabel index --strict           # fail on any warning
```

**Emitted codes** (when `--check` fails): `INDEX_STALE`.

---

## `dotbabel-search` _(added v0.4.0)_

Full-text search over the taxonomy index by name, id, and description.
Requires `dotbabel index` to have been run at least once.

| Flag                 | Default          |                                                        |
| -------------------- | ---------------- | ------------------------------------------------------ |
| `--repo-root <path>` | resolved via git | Override repo root                                     |
| `--type <type>`      | —                | Filter to one artifact type (agent, skill, command, …) |

**Typical invocations:**

```bash
dotbabel search kubernetes
dotbabel search "IaC module" --type skill
dotbabel search aws --json | jq -r '.[] | .id'
```

Searches are case-insensitive. Exit 2 if the index is missing.

---

## `dotbabel-list` _(added v0.4.0)_

List all artifacts from the taxonomy index with optional facet filters.
Requires `dotbabel index` to have been run at least once.

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
dotbabel list
dotbabel list --type command
dotbabel list --domain devex --maturity validated
dotbabel list --json | jq -r '.[].id'
```

---

## `dotbabel-show` _(added v0.4.0)_

Display detailed metadata for a single artifact by its id. When a skill and
agent share an id, use `--type` to disambiguate.

| Flag                 | Default          |                                                |
| -------------------- | ---------------- | ---------------------------------------------- |
| `--repo-root <path>` | resolved via git | Override repo root                             |
| `--type <type>`      | —                | Force type when multiple artifacts share an id |

**Typical invocations:**

```bash
dotbabel show aws-specialist
dotbabel show review-pr --type command
dotbabel show pre-pr --json
```

Exit 1 if the artifact is not found. Exit 2 if the index is missing.

---

## `dotbabel-project-sync`

Fan out this repo's `CLAUDE.md`, `.claude/commands` and `.claude/skills` into
Codex / Gemini / Copilot project-scope analogues. Repo-local; user-scope
artifacts are `dotbabel bootstrap`'s job.

| Flag            | Default |                                        |
| --------------- | ------- | -------------------------------------- |
| `--repo <path>` | `cwd`   | Target repo root                       |
| `--all`         | false   | Fan out regardless of CLI presence     |
| `--force`       | false   | Replace conflicting existing targets   |
| `--dry-run`     | false   | Report planned actions, mutate nothing |

Gated on CLI presence by default: a target is skipped when its CLI is not on
PATH. `.dotbabel.json` `gate_on_cli_presence` controls that; `--all` overrides.

---

## `dotbabel-check-project-sync`

Read-only counterpart. Verifies the wiring matches what `project-sync` would
produce, without writing anything — the CI-safe form.

| Flag            | Default |                  |
| --------------- | ------- | ---------------- |
| `--repo <path>` | `cwd`   | Target repo root |

---

## `dotbabel-generate-instructions`

Render `CLAUDE.md`'s rule-floor block into `AGENTS.md`, `GEMINI.md`,
`.github/copilot-instructions.md` and the per-CLI user-scope templates.

| Flag                 | Default          |                                       |
| -------------------- | ---------------- | ------------------------------------- |
| `--repo-root <path>` | resolved via git | Override repo root                    |
| `--dry-run`          | false            | Report planned writes, mutate nothing |

Hand-editing a generated block is reverted by the next run and is detected by
`dotbabel-check-instructions-fresh`. Edit `CLAUDE.md` and re-run this instead.

---

## `dotbabel-local-attest`

Run the configured CI matrix locally and, on a clean pass, post an attestation
comment so the remote pipeline can skip itself for that commit. Exists to
protect CI minutes.

| Flag              | Default                |                                   |
| ----------------- | ---------------------- | --------------------------------- |
| `--pr <N>`        | open PR for the branch | Target PR                         |
| `--no-push`       | false                  | Do not `git push` after attesting |
| `--dry-run`       | false                  | Print the comment; post nothing   |
| `--config <path>` | discovered             | Override the config file location |

Config discovery, in order: `.local-attest.config.mjs`,
`.local-attest.config.json`, then `package.json#local-attest`.

The attestation is SHA-pinned, so a push after attesting invalidates it. Commit
first, attest second.

---

## `dotbabel-pr-stack`

Reason about stacked pull requests — dependency graph, merge order, and the
exact commands a child needs once its parent has merged.

| Subcommand | Purpose                                                          |
| ---------- | ---------------------------------------------------------------- |
| `graph`    | Print the raw dependency graph                                   |
| `plan`     | What can land now, what is blocked, and any structural problems  |
| `next`     | The commands to move a child PR after its parent merged          |
| `gate`     | Evaluate a precondition (`local-attest` \| `merge` \| `skip-ci`) |
| `phases`   | The canonical pipeline phase order                               |

| Flag                 | Default  |                                              |
| -------------------- | -------- | -------------------------------------------- |
| `--trunk <ref>`      | `main`   | Trunk branch name                            |
| `--limit <N>`        | 100      | Max PRs to enumerate                         |
| `--pr <N>`           | —        | Required by `next` and `gate`                |
| `--parent <N>`       | —        | Required by `next`                           |
| `--parent-sha <sha>` | —        | Parent head SHA, captured **before** merging |
| `--remote <name>`    | `origin` | Git remote                                   |
| `--gate <name>`      | —        | Gate to evaluate                             |
| `--sha <rev>`        | `HEAD`   | Commit to inspect for `--gate skip-ci`       |

Capture `--parent-sha` before the parent merges. The repo squash-merges, so the
parent's original commits are not ancestors of the squashed commit and
`git rebase --onto` needs that SHA to know what to drop. `merge-pr` deletes the
branch, so the ref can be gone by the time you want it.

**Exits 1** from `plan` on a structural problem (cycle, orphan base, two open
PRs on one head). Those need a human decision, not a retry.

---

## `dotbabel-handoff`

Cross-agent and cross-machine session handoff. See
[handoff-guide.md](./handoff-guide.md) for the full surface — this entry exists
so the bin is discoverable from the reference.

| Subcommand | Purpose                                        |
| ---------- | ---------------------------------------------- |
| `pull`     | Render a local session as a handoff block      |
| `push`     | Publish to the remote transport repo           |
| `fetch`    | Retrieve a handoff pushed from another machine |
| `list`     | Enumerate local sessions                       |
| `search`   | Find a session by content                      |
| `prune`    | Delete aged transport branches                 |
| `doctor`   | Preflight the remote transport                 |

The remote transport is a user-owned private git repo named by
`DOTBABEL_HANDOFF_REPO`. `push` without a query requires `--from <cli>`.
