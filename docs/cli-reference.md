# CLI reference

_Last updated: v3.4.0_

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

`dotbabel-quality` is the one exception to the `--json` shape: it emits a
`schema_version: 1` quality envelope rather than `{events, counts}`. See
[`dotbabel-quality`](#dotbabel-quality).

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

# Language-aware quality (added v3.2.0)
dotbabel quality [check|detect|explain|baseline] [OPTIONS]

# Task contract and state for work without a spec
dotbabel task <new|update|show|list|close|hook> [OPTIONS]
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
hook → hook registration → check-on-stop trust → attestation policy. Prints
`✓/✗/⚠` per check.

| Flag                 | Default          |          |
| -------------------- | ---------------- | -------- |
| `--repo-root <path>` | resolved via git | Override |

The hook registration rows compare the hooks the package ships with the hooks
that three settings files register: `$CLAUDE_CONFIG_DIR/settings.json` (default
`~/.claude/settings.json`), `.claude/settings.json`, and
`.claude/settings.local.json`. Doctor does not read managed settings, plugin
hooks, or `--settings`, and it does not check matchers, so a hook registered
only there shows as unregistered, and a hook under the wrong matcher still
shows as registered.

A registration counts when a shipped script's basename appears anywhere in the
command, so a repository's own `.claude/hooks/` copy and a wrapped command such
as `timeout 10 …/check-on-write.sh` both count. `fleet-guard.sh` needs five
entries, told apart by the argument after the script: `PreToolUse` with
`pre-edit` and with `pre-bash`, `SessionStart`, `PostToolUse`, and
`UserPromptSubmit`. `fleet-shell-prefix.sh` counts when `CLAUDE_CODE_SHELL_PREFIX`
names it. That variable is one slot: the highest-precedence settings file that
sets it wins (local, then project, then user), else the environment.

One `✓` row lists the registered hooks with their events and the scopes that
register them. There is one `⚠` row for each unregistered hook, with the entries
it expects, and one for each partly registered hook, with the entries it lacks.
A settings file that does not parse or is not a JSON object is a `⚠` row, and so
is a `hooks` key that is not an event name; doctor prints that key escaped,
because a cloned repository controls the project files. A
`CLAUDE_CODE_SHELL_PREFIX` set by the project or local settings is a `⚠` row as
well, because it wraps every shell command. These rows never fail the run. See
[hooks.md](./hooks.md#registering-a-hook).

The trust row reports whether this repo may run turn-end project checks. It
never fails the run — a repo deliberately left off the allowlist is a valid
state. See [hooks.md](./hooks.md#check-on-stop-trust).

The attestation rows check `.dotbabel.json`'s `attestation` policy against the
local-attest config, and fail when enforcement is on but cannot work (no config,
an ungoverned config, an unknown required leg). They load an executable
`.local-attest.config.mjs` only when the repo is on the trust allowlist. See
[attestation.md](./attestation.md#doctor-findings).

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

| Flag              | Default     |                                                                                               |
| ----------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `--source <path>` | npm install | Path to a local dotbabel git clone (clone mode)                                               |
| `--target <dir>`  | `~/.claude` | Override destination directory                                                                |
| `--all`           | false       | Link every CLI's instruction file and fan out skills to each CLI's user-scope skills dir.[^1] |
| `--quiet`         | false       | Suppress per-file progress; print summary only                                                |

[^1]: Skills fan out to `~/.codex/skills/`, `~/.gemini/skills/`, `~/.gemini/config/skills/` (Antigravity), and `~/.config/opencode/skills/`. Copilot has no skill auto-discovery directory, so only its instruction file is linked.

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
Codex / Gemini / Antigravity / OpenCode / Copilot project-scope analogues.
Repo-local; user-scope artifacts are `dotbabel bootstrap`'s job.

| Flag            | Default |                                        |
| --------------- | ------- | -------------------------------------- |
| `--repo <path>` | `cwd`   | Target repo root                       |
| `--all`         | false   | Fan out regardless of CLI presence     |
| `--force`       | false   | Replace conflicting existing targets   |
| `--dry-run`     | false   | Report planned actions, mutate nothing |

Gated on CLI presence by default: a target is skipped when its CLI is not on
PATH. `.dotbabel.json` `gate_on_cli_presence` controls that; `--all` overrides.

`.dotbabel.json` `fan_out_layout` chooses the shape for the runtimes whose
skills trees are interchangeable — Codex, Gemini, and OpenCode:

| Value               | Result                                                                       |
| ------------------- | ---------------------------------------------------------------------------- |
| `per-cli` (default) | `.codex/skills/`, `.gemini/skills/`, `.opencode/skills/` are identical trees |
| `shared`            | one `.cli/skills/` tree; each of those paths becomes a symlink to it         |

Switching to `shared` backs the old trees up to `.codex/skills.bak-<timestamp>`.
Copilot's `.github/prompts/` and `.github/instructions/` are unaffected.

`.dotbabel.json` `cli_excluded` maps a CLI to command basenames and skill ids
it must not receive, for commands that describe a Claude-only flow. An excluded
link written by an earlier run is removed (`removed: <path>`; `would remove:`
under `--dry-run`). Under `shared`, an exclusion for `codex` or `gemini`
applies to every runtime sharing that tree.

Limitation (Codex/Gemini): targets are symlinks to the Claude source, never
per-CLI translations. Claude-shaped frontmatter (`allowed-tools`, `model`,
`effort`, `disable-model-invocation`, auto-routing `description`) is not
honored; those CLIs get direct slash invocation by name only. Commands that
describe Claude-only flows fan out unchanged unless listed in
`cli_excluded`. Tracked at
[#219](https://github.com/kaiohenricunha/dotbabel/issues/219).

Copilot is different: its targets are generated files whose frontmatter is
mapped into GitHub's `.prompt.md`/`.instructions.md` shape (`description`,
`name`, `argument-hint`, tool grants). `model`, `effort`, and
`disable-model-invocation` still have no Copilot equivalent and are dropped
with a warning. See
[`docs/copilot-frontmatter-mapping.md`](./copilot-frontmatter-mapping.md) for
the full mapping.

---

## `dotbabel-check-project-sync`

Read-only counterpart. Verifies the wiring matches what `project-sync` would
produce, without writing anything — the CI-safe form. Honors `fan_out_layout`,
so it checks whichever shape the config asks for.

| Flag            | Default |                                                        |
| --------------- | ------- | ------------------------------------------------------ |
| `--repo <path>` | `cwd`   | Target repo root                                       |
| `--all`         | false   | Check every `fan_out` CLI, even one absent from `PATH` |

Without `--all` a CLI missing from `PATH` is reported as
`skipped <cli>: not on PATH` rather than as drift, matching what `project-sync`
declined to write.

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

| Flag              | Default                |                                                                                  |
| ----------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `--pr <N>`        | open PR for the branch | Target PR                                                                        |
| `--no-push`       | false                  | Do not `git push` after attesting                                                |
| `--dry-run`       | false                  | Print the comment; post nothing                                                  |
| `--fail-fast`     | false                  | Stop launching legs after the first hard failure; a stopped run cannot attest    |
| `--full`          | false                  | On-demand full run: ignore every leg's `when` and `scope`; run every leg in full |
| `--only <leg>`    | —                      | Diagnostic mode: run only the named leg(s); relaxed preconditions; never attests |
| `--from <leg>`    | —                      | Diagnostic mode: run the matrix from the named leg to the end                    |
| `--config <path>` | discovered             | Override the config file location                                                |

Config discovery, in order: `.local-attest.config.mjs`,
`.local-attest.config.json`, then `package.json#local-attest`.

An attest run is PR-scoped: a leg with `scope: true` receives the pull
request's changed files and runs only what they reach, and a leg with
`when.changedPaths` runs only when a changed file matches. The full suite runs
only on demand (`--full`) or on a schedule.

The attestation is SHA-pinned, so a push after attesting invalidates it. Commit
first, attest second.

To let `/merge-pr` reuse an attestation instead of re-running the suite, see
[attestation.md](./attestation.md).

---

## `dotbabel-quality`

_Added v3.2.0._ Measure one language-independent quality policy using the tools
the repository already has. Discovers analyzers, never installs one. Full policy
semantics — rule catalog, language adapters, baselines, trust — live in
[quality.md](./quality.md).

| Subcommand          | Purpose                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `check` _(default)_ | Execute the selected profile and emit a verdict                               |
| `detect`            | Inspect components, tools, exclusions, and trust; executes no project command |
| `explain`           | Print every resolved rule with shipped / user / project provenance            |
| `baseline`          | Print a candidate legacy baseline; `--write` saves it                         |

| Flag                         | Default                                |                                                                                        |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| `--repo <path>`              | current directory                      | Repository root                                                                        |
| `--profile <fast\|pr\|deep>` | `quality.default_profile`, else `fast` | Rule set to run                                                                        |
| `--base <revision>`          | see resolution order below             | Comparison base; the diff runs from its merge-base                                     |
| `--head <revision>`          | working tree                           | Compare a committed revision. Without it, untracked files join the change set          |
| `--path <glob>`              | —                                      | Repeatable. Narrow the run to matching files. A glob-free value is a directory prefix  |
| `--all`                      | false                                  | Check the whole repository instead of a diff. Cannot combine with `--base` or `--head` |
| `--jobs <1-8>`               | `2`                                    | Components checked concurrently; plans inside one component stay serial                |
| `--allow-project-commands`   | false                                  | Authorize project commands for this run only. Never persists                           |
| `--pass-env <name>`          | —                                      | Repeatable. Add one variable to the otherwise fixed child environment                  |
| `--rule <id>`                | —                                      | `explain` only. Show one rule; an unknown id exits `64`                                |
| `--write`                    | false                                  | `baseline` only. Requires a clean worktree **and** trust                               |

**Base resolution order**: `--base` → `DOTBABEL_QUALITY_BASE` → `quality.base_ref`
→ `origin/HEAD` → `origin/main` → `main` → `master`. A revision missing from the
local clone is `QUALITY_BASE_UNAVAILABLE`, exit `2` — in CI that usually means a
shallow checkout, so set `fetch-depth: 0`.

**Exit codes**: `0` no error verdict, `1` policy failure, `2` environment failure
(missing tool, report, base, scope, or trust), `64` invalid usage. Exit `2` is not a pass.

Usage errors that exit `64`: a `--path` matching no repository file, an absolute
or `..`-escaping `--path`, `--path` with `explain`, `--path` with `baseline --write`,
and `--all` with `--base`/`--head`.

**Emitted error codes**: `QUALITY_CONFIG_INVALID`, `QUALITY_BASE_UNAVAILABLE`,
`QUALITY_SCOPE_UNAVAILABLE`,
`QUALITY_REPORT_INVALID`, `QUALITY_BASELINE_INVALID`, `QUALITY_TRUST_REQUIRED`,
`QUALITY_EXECUTION_FAILED` — each with remediation in
[troubleshooting.md](./troubleshooting.md#quality-errors).

**`--json` envelope** carries `schema_version`, `command`, `state`, `profile`,
`policy_hash`, `scope`, `path_scope`, `all_files`, `components`, `exclusions`,
`executions`, `results[]`, `exceptions[]`, `verdict`, and `environment_error`.
`path_scope` and `all_files` are always present, so a consumer can tell a scoped
run from a full one without an `undefined` check. `policy_hash` deliberately
excludes `base_ref`, `head_ref`, and `jobs`, so it is stable across commits for
the same policy.

```bash
npx dotbabel-quality detect
npx dotbabel-quality explain --rule complexity.cognitive
npx dotbabel-quality check --profile pr --base origin/main --allow-project-commands --json
npx dotbabel-quality check --all --path src/api          # one package, entirely
npx dotbabel-quality check --json | jq -r '.results[] | select(.verdict=="fail") | .rule'
```

---

## `dotbabel-pr-stack`

Reason about stacked pull requests — dependency graph, merge order, and the
exact commands a child needs once its parent has merged.

| Subcommand        | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `graph`           | Print the raw dependency graph                                        |
| `plan`            | What can land now, what is blocked, and any structural problems       |
| `next`            | The commands to move a child PR after its parent merged               |
| `gate`            | Evaluate a gate (`local-attest` \| `merge` \| `skip-ci` \| `budget`)  |
| `phases`          | The canonical pipeline phase order                                    |
| `entry`           | The phase the conductor should start at for this branch               |
| `review-complete` | Post the SHA-pinned marker that the review stage finished             |
| `record`          | Append one phase attempt to the pull request's run receipt            |
| `receipt`         | Print the run receipt: verdict, attempts, rollback point              |
| `spot-check`      | Decide whether `/merge-pr` verifies an attested PR explicitly anyway  |
| `main-status`     | Show which default-branch commits a CI run verified, and the debt     |
| `contradiction`   | Raise the alarm when a real failure contradicts a passing attestation |

| Flag                       | Default    |                                                                                                                                                                            |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--trunk <ref>`            | `main`     | Trunk branch name. `spot-check`, `main-status`, `contradiction`: the repository default branch when not given                                                              |
| `--limit <N>`              | 100        | Max PRs to enumerate. `main-status`: commits to show (default 20)                                                                                                          |
| `--pr <N>`                 | —          | Required except by `graph`, `plan`, `phases`, `main-status`, `--gate skip-ci`, `contradiction --sha`; optional for `entry`                                                 |
| `--parent <N>`             | —          | Required by `next`                                                                                                                                                         |
| `--parent-sha <sha>`       | —          | Parent head SHA, captured **before** merging                                                                                                                               |
| `--remote <name>`          | `origin`   | Git remote                                                                                                                                                                 |
| `--gate <name>`            | —          | Gate to evaluate                                                                                                                                                           |
| `--sha <rev>`              | `HEAD`     | `--gate skip-ci`: commit to inspect. `record`: full head SHA, used only when gh cannot answer. `contradiction`: the full SHA of the default-branch commit whose run failed |
| `--dry-run`                | off        | `review-complete`: check and print, post nothing                                                                                                                           |
| `--phase <id>`             | —          | `record`, `--gate budget`: the conductor phase                                                                                                                             |
| `--outcome <o>`            | —          | `record`: `pass` \| `fail` \| `blocked` \| `skipped`                                                                                                                       |
| `--reason <CODE>`          | —          | `record`: the blocking reason code                                                                                                                                         |
| `--evidence <url>`         | —          | `record`: a link to evidence the phase produced; repeatable                                                                                                                |
| `--workflow <file>`        | `test.yml` | `spot-check`, `main-status`, `contradiction`: the test workflow file on the default branch                                                                                 |
| `--show`                   | off        | `spot-check`: print the recorded decisions and explicit runs; decide nothing                                                                                               |
| `--record-explicit <r>`    | —          | `spot-check`: record the explicit run's result, `pass` or `fail`                                                                                                           |
| `--local`                  | off        | `main-status`: also run the local-attest matrix on the default-branch tip. Needs project-command trust                                                                     |
| `--allow-project-commands` | off        | `main-status --local`: run without the trust allowlist entry, for this run only                                                                                            |
| `--test-result <r>`        | —          | `contradiction`: the test job's result: `success`, `failure`, `cancelled` or `skipped`                                                                                     |
| `--local-failure`          | off        | `contradiction`: the explicit run of `--pr` failed on this machine                                                                                                         |
| `--post`                   | off        | `contradiction`: add the `attestation-contradicted` label to each suspect and open one issue                                                                               |

Capture `--parent-sha` before the parent merges. The repo squash-merges, so the
parent's original commits are not ancestors of the squashed commit and
`git rebase --onto` needs that SHA to know what to drop. `merge-pr` deletes the
branch, so the ref can be gone by the time you want it.

**Exits 1** from `plan` on a structural problem (cycle, orphan base, two open
PRs on one head). Those need a human decision, not a retry.

`entry` derives where `/pr-conductor` should start from two SHA-pinned comments
on the current head: a review-complete marker and a passing attestation. It
returns `NO_PR`, `PR_OPEN`, `REVIEWED_AT_HEAD` (resume at `local-attest`), or
`REVIEWED_AND_ATTESTED` (stop and hand off). An attestation alone never skips the
review stage. Evidence it cannot read degrades to `PR_OPEN`, never to an error.

`review-complete` is the sanctioned writer of that marker. It posts only after
checking that a `post-pr-review` receipt exists for an ancestor of the head, that
no finding `post-pr-review` posted is still unresolved, and that the criteria half
of the merge gate has no blocking reason, and it re-reads the head immediately
before posting. Exit `0` posted (or dry run passed), `1` refused with a reason
code, `2` environment error. See [`docs/attestation.md`](./attestation.md) for the
sibling attestation evidence.

`record` appends one attempt to the run receipt at
`<git-common-dir>/dotbabel/receipts/pr-<N>.json`
([schema](../schemas/dotbabel.run-receipt.schema.json)). The git common
directory is shared by every worktree, so a phase that runs in another worktree
extends the same history, and the file can never dirty a working tree. A lock
file (`pr-<N>.json.lock`) stops two concurrent calls from losing an attempt; a
lock held longer than 2 seconds is an environment error (exit `2`), and one
older than 30 seconds is cleared as stale.

Each attempt keeps the head it ran on, the outcome and reason code, the evidence
links, the merge base as the rollback point, the `model` the phase artifact's
frontmatter requests, and the dotbabel version. The head comes from
`gh pr view`. `--sha` is a fallback for when gh cannot answer: it must be a full
SHA of a local commit, and it is refused (exit `64`) when it differs from the
head gh reports. The model is read in the order Claude Code loads the artifact:
`~/.claude/<artifact>`, then the project's `.claude/<artifact>`; a copy that
names no model falls through to the next. A value it cannot observe stays
`null`: the receipt records no cost or model route. The log is append-only. A
damaged receipt, or one whose `pr` is not the file's, is an environment error
(exit `2`) and is left unchanged rather than started over.

Warning: the receipt is self-reported. It records what the conductor says each
phase did, and nothing checks that against the evidence comments. It is a log,
not evidence, and the merge gate never reads it.

`receipt` prints the verdict, each phase's attempt count, last outcome, and
consecutive failures, and the rollback point. The verdict is `ready` only when
the `stop` hand-off is the latest attempt and passed, no other phase's latest
non-skipped attempt failed, and a passing `local-attest` names the same head as
`stop`. It is `blocked` while the latest attempt, or a phase that `stop`
contradicts, failed; otherwise it is `in-progress`. No receipt yet exits `0`.

`gate --gate budget --pr <N> --phase <id>` is the conductor's attempt cap. It
counts the phase's consecutive `fail` and `blocked` attempts in the receipt since
the phase last passed, and fails with `CONDUCTOR_BUDGET_EXHAUSTED` when the count
reaches the cap. A `skipped` attempt neither counts nor resets, except one with
reason `USER_ALLOWED_RETRY`: that records the user's explicit permission to try
again, and it resets the count without reading as a pass.

The cap comes from `.dotbabel.json` on the pull request's base ref
(`<remote>/<baseRefName>` from `gh pr view`, or `<remote>/<trunk>` when gh cannot
answer), never from the working tree or the branch. The conductor edits and
commits in that tree, so a cap it could read there is a cap it could raise:

```json
{ "conductor": { "max_attempts": 3, "phase_max_attempts": { "local-attest": 1 } } }
```

`max_attempts` defaults to 3, and every value must be from 1 to 10. A value out of
range, a misspelled key, an unknown phase key, or a `conductor` block of the wrong
shape is an environment error (exit `2`), never a silent default, because a typo
must not raise or remove the cap. A base ref that is not in this clone is exit
`2` as well: fetch it and retry. A damaged receipt is exit `2`, as for `receipt`.

### Merge verification: `spot-check`, `main-status`, `contradiction`

These three subcommands detect a forged attestation. They do not prevent one.
See [Spot checks and the contradiction alarm](./attestation.md#spot-checks-and-the-contradiction-alarm)
for the design and its limits. All three read the repository default branch
(`gh repo view --json defaultBranchRef`) unless you pass `--trunk`.

`spot-check --pr <N>` decides whether `/merge-pr` verifies an attested pull
request explicitly anyway. It reads `attestation.spot_check` from
`.dotbabel.json` at the pull request's base commit. When that policy is off
(both rates `0` and no `always_paths`), it prints `not selected (off)` and
stops. It then reads no changed files and no CI runs, and records nothing.
Otherwise it reads the changed files with the old path of each rename, and the
newest completed run of `--workflow` on the default branch.

The roll is the first 32 bits of `sha256("<head>:<pr>")`, so it is fixed for a
head. The command prints `SELECTED` or `not selected` with the reason (`off`,
`always_path`, `ci_unavailable`, `rate`, or `not_selected`). It records the
decision in the spot-check log,
`<git-common-dir>/dotbabel/receipts/pr-<N>.spot-checks.json`
([schema](../schemas/dotbabel.spot-checks.schema.json)). The log is a sibling
of the run receipt, with its own lock (`pr-<N>.spot-checks.json.lock`), so an
older `dotbabel` still reads `pr-<N>.json`. Each entry records the workflow
file and the branch that were read.

A selection stays. Once a head was selected, a later call on the same head
prints `SELECTED` with the first reason, marked `sticky`. A non-selection can
change when the CI state or the base policy changes.

- `--record-explicit pass|fail` records the explicit run's result for the
  current head as an `explicit-run` entry.
- `--show` prints, for each head, the decision that stands and the recorded
  explicit run. It reads only the log.

CI is `available` when the newest completed run tested one of the last 10
first-parent commits of the default branch and is green or red. It is
`unavailable` when that run tested an older commit, when there is no completed
run, or when the run is `unverified`. It is `unknown` when the runs, the jobs
or the recent commits cannot be read. Unknown is never `available`, and the
normal `rate` then applies.

`spot-check` exits `0` for any decision. It exits `2` when the pull request, the
base commit or the default branch cannot be read. It also exits `2` when the log
is damaged or the policy is invalid. An invalid policy is never replaced by the
default. It exits `64` on a usage error.

`main-status` lists the recent first-parent commits of `<remote>/<trunk>`, after
a best-effort `git fetch`. It classifies the runs of `--workflow` for them as
`green`, `red`, `unverified` or `unknown`. `unverified` is a billing limit, a
startup failure, a cancel, a job that never started, or no run. `unknown` means
that the run or its jobs could not be read. A green run verifies its commit and
every older commit. The output names the last green commit and the debt: the
`red`, `unverified` and `unknown` commits newer than it. When the runs list
cannot be read, every commit is `unknown`, never verified. For each merged pull
request with a local spot-check log, it also shows the decision and the explicit
run.

`main-status --local` also runs the local-attest matrix on the default-branch
tip. Warning: this runs repository code as you, from that tip: the local-attest
config module, the lifecycle scripts of the install, and every leg. So it needs
the repository on the project-command trust allowlist, which `dotbabel quality`
and `doctor` also use. Grant it with `dotbabel project-init --trust`, or pass
`--allow-project-commands` for one run. Without either, it exits `2` before it
runs anything.

It creates a temporary detached worktree and installs dependencies from the
lockfile with the table that `/merge-pr` uses: `npm ci`,
`pnpm i --frozen-lockfile`, `yarn --immutable`, `go mod download`, or
`uv sync`. With no supported lockfile, it installs nothing and says so in the
detail. Then it runs `dotbabel local-attest --from <first leg>` and removes the
worktree. An attest run refuses a detached HEAD and needs an open pull request,
so the command uses the diagnostic mode. The diagnostic mode runs the whole
matrix, and it never posts, labels or pushes.

The local result is `pass`, `fail`, or `unknown`: the worktree, the config, the
install, or the run itself failed. It is labelled "local (same machine as the
agent; weaker than CI)", and it never verifies a commit. An `unknown` local
result is not a pass.

`main-status` exits `0` when it reports, even when the local result is
`unknown`. It exits `1` when the `--local` matrix fails, and `2` when the
default branch or `<remote>/<trunk>` cannot be read, or `--local` has no
trust. It exits `64` on a usage error: a ref that is not a plain name, or a bad
`--limit` or `--workflow`.

`contradiction --sha <sha> --test-result <r>` is what the test workflow's
`contradiction` job runs after a failed push. A result other than `failure` is
no contradiction. Otherwise it classifies the run (`$GITHUB_RUN_ID` in CI, else
the latest run of `--workflow` for the commit). A `green` or `unverified` run
is no contradiction. An `unknown` run exits `2`.

A `red` run can come from any commit since the last green run. So the command
walks the first-parent history back from `<sha>` to the last commit with a
green run, not included, and at most 20 commits. When the first parent's own
run was already red, it raises no new alarm: it prints why and exits `0`. For
each pull request merged in the range, it reads the trust list from that merge
commit's first parent, never from the merge commit. A first parent with no
`.dotbabel.json` uses `["OWNER"]`; the `trustListSource` field names the true
source. A pull request with a trusted, passing attestation for its head is a
suspect. A comment that was edited after it was posted still counts, and the
result says so.

`contradiction --pr <N> --local-failure` is the same check for an explicit run
that failed on this machine, before the merge. Its trust list comes from the
pull request's base commit.

With `--post`, the command adds the label `attestation-contradicted` to each
suspect (it creates the label when it is missing) and opens one issue. On the
default branch, a hidden marker
`<!-- dotbabel:attestation-contradicted commit=<sha> -->` keeps one issue per
failing commit. For `--local-failure`, the marker is
`<!-- dotbabel:attestation-contradicted pr=<N> sha=<head> -->`. When
`GITHUB_ACTIONS=true`, only an issue that the workflow identity opened counts.
A closed match is reopened with a comment, and the output says so. The issue
names the failing commit, the range, every suspect, and the failed run
(`$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID`).

`contradiction` exits `1` when it finds a contradiction, and `0` when it finds
none. It exits `2` when posting fails. It also exits `2` when it cannot read the
run, its jobs, the first parent's run, the history, a trust list, a pull
request, or its comments. It exits `64` on a usage error.

---

## `dotbabel-fleet`

File claims, CPU lanes, merge events, and the merge token for concurrent Claude Code sessions.
See [fleet.md](./fleet.md) for how claims start and end, how lanes work, and
how the event feed reports merges, and [hooks.md](./hooks.md) for the hooks.

| Subcommand             | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `board`                | Show the claims in the current repository                        |
| `claim <pattern>...`   | Claim paths or globs for this session                            |
| `release <pattern>...` | Release this session's matching claims                           |
| `release --all`        | Release every claim this session holds in the repository         |
| `prune`                | Remove the claim records of sessions that exited                 |
| `hook pre-edit`        | `PreToolUse` entry: claim, or deny / ask with a reason           |
| `hook pre-bash`        | `PreToolUse` entry on `Bash`: take the merge token, or deny      |
| `hook session-start`   | `SessionStart` entry: print the live claims as context           |
| `hook post-tool`       | `PostToolUse` entry: record a `gh pr merge`, report merges       |
| `hook prompt`          | `UserPromptSubmit` entry: report merges the session has not seen |
| `lane -- <command>`    | Run a command in a free CPU lane, with its exit status           |
| `lanes`                | Show each CPU lane, its holder, and the waiting commands         |
| `events`               | Show the merges of the last 7 days in this repository            |
| `event --pr <N>`       | Record a merge made outside Claude Code                          |
| `token [status]`       | Show who holds this repository's merge token                     |
| `cpu-share [--status]` | Give every live session's scope an equal CPU weight              |
| `token take`           | Take the merge token for this session                            |
| `token release`        | Give this session's merge token back                             |

| Flag             | Default        |                                                            |
| ---------------- | -------------- | ---------------------------------------------------------- |
| `--note <text>`  | —              | `claim`: the intent other sessions see                     |
| `--name <label>` | the command    | `lane`: the label that `lanes` shows                       |
| `--pr <N>`       | —              | `event`: the merged pull request                           |
| `--repo <o/r>`   | the cwd's repo | `event`: the repository of the pull request                |
| `--all`          | off            | `release`: release every claim; `events`: every repository |
| `--json`         | off            | `board`, `claim`, `lanes`, `events`, `token`: JSON output  |

`claim`, `release`, and `board` find their own session by walking up the
process tree to a process in `~/.claude/sessions/`, so run them from a Claude
Code session.

**Exits 1** from `claim` when a live session holds an overlapping claim; the
refusal lists each owner. **Exits 2** outside a git repository, and from
`claim` and `release` outside a Claude Code session. `hook` always exits 0: it
fails open. `lane` exits with the command's own status, and 64 without a
command. `event` exits 1 when the pull request is not merged, and 2 when
`gh pr view` fails. `token take` exits 1 when a live session holds the token,
and `token release` exits 1 when this session holds none.

---

## `dotbabel-task`

The contract and the durable state of work that has no spec. `new` fixes the
goal and the `done_when` checks before execution starts, so success is defined
first. `update` records where the work stands. The
[`task-context.sh`](./hooks.md#task-contextsh) hook prints the open tasks at
session start, so a new or resumed session reads that state.

| Subcommand           | Purpose                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `new <slug>`         | Create an open task. Needs `--goal` and at least one `--done-when`                                |
| `update <slug>`      | Set the phase, append decisions and pending items, finish pending items, add or drop dependencies |
| `show <slug>`        | Print one task                                                                                    |
| `list [--all]`       | Print the open tasks, or every task with `--all`, most recently updated first                     |
| `close <slug>`       | Mark a task closed. The record stays and `show` still prints it                                   |
| `graph [--json]`     | Every open task of the clone, its edges, the dependency order, and any cycle                      |
| `next [--json]`      | The ready tasks, then the blocked ones with the references they wait on                           |
| `hook session-start` | `SessionStart` entry: print the open tasks as context                                             |

| Flag                      | Used by         | Meaning                                                               |
| ------------------------- | --------------- | --------------------------------------------------------------------- |
| `--goal <text>`           | `new`           | What the work must achieve                                            |
| `--done-when <text>`      | `new`           | A check that decides the work is done. Repeatable                     |
| `--constraint <t>`        | `new`           | A limit on how the work is done. Repeatable                           |
| `--phase <p>`             | `new`, `update` | The phase, in the vocabulary of the driving skill (default `started`) |
| `--decision <text>`       | `update`        | Append a decision with its time. Repeatable                           |
| `--pending <text>`        | `update`        | Append a pending item. Repeatable                                     |
| `--done <text>`           | `update`        | Remove a pending item, matched exactly. Repeatable                    |
| `--depends-on <ref>`      | `new`, `update` | A reference this task waits on (see below). Repeatable                |
| `--drop-depends-on <ref>` | `update`        | Remove a dependency, matched exactly. Repeatable                      |
| `--all`                   | `list`          | Include closed tasks                                                  |
| `--json`                  | all             | Print `{ok, task}` or `{ok, tasks, problems}`                         |

A slug is lowercase letters, digits, and dashes, up to 64 characters, and it is
unique across the worktrees of the clone: `new` refuses a slug that another
worktree already holds. Tasks live in `<git-dir>/dotbabel/tasks/<slug>.json`
([schema](../schemas/dotbabel.task-state.schema.json), version 2; a version-1
file reads as version 2 with no dependencies), so they never appear in
`git status`, and each worktree has its own. They survive a context reset, a
crash, and a new session in that worktree. They do not travel to another
machine; that is what [`/handoff`](./handoff-guide.md) is for.

A dependency reference takes one of three forms: a task of this clone
(`<slug>`), a task of another clone on this machine
(`github.com/owner/repo:<slug>`), or a pull request or issue
(`owner/repo#123`). A task may name a slug that no worktree holds yet. `new`
and `update` refuse a reference that closes a cycle through the tasks of the
clone, including a task that names itself, and write nothing when they do.

`graph` and `next` read the task files of every worktree of the clone on each
call, and call nothing else: no index, no network, no `gh`. A dependency is
`satisfied` when its task is closed, `open` while it is open, `missing` when no
worktree holds the slug, and `unknown` for a task of another clone or a pull
request or issue, which this version does not resolve. A task is ready when
every dependency is satisfied; `unknown` counts as blocked. The dependency
order lists each task after the open tasks it depends on, ties by slug, so it
is the same on every read; a cycle written on disk is reported and its tasks
are left out of the order. `--json` prints `{ok, tasks, edges, order, cycle,
problems}` for `graph` and `{ok, order, ready, blocked, problems}` for `next`,
where each blocked entry carries `waits_on: [{ref, kind, state}]`. A task file
that does not read is named in `problems` and as a warning, and the read goes
on.

A task file's slug must be its file name; a copied or renamed file is reported
as invalid rather than written to another task. `update` and `close` hold a
per-task lock (`<slug>.json.lock`), so two writers cannot lose each other's
decisions; a lock older than 30 seconds is cleared as stale. The record is
self-reported and advisory: put deferred work in an issue, because the task
goes away with the worktree.

**Exits 1** when the task already exists (`new`), its slug is held by another
worktree of the clone (`new`), does not exist, is closed (`update`, `close`),
when `--done` names an item that is not pending, when `--drop-depends-on` names
a reference the task does not have, or when a dependency closes a cycle.
**Exits 2** outside a git repository, for a symbolic link on the task path, for
a task file that does not parse or whose slug is not its file name, while
another writer holds the task's lock, and for any filesystem error. `list`
reports an unreadable file as a warning and still exits 0, as `graph` and
`next` do. **Exits 64** for a
bad slug, a missing or blank `--goal` or `--done-when`, any other blank text
value, a malformed dependency reference, or an `update` with nothing to change. `hook` always exits 0: it fails
open.

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
