# Troubleshooting

_Last updated: v2.3.0_

Indexed by `ERROR_CODES`. When a validator fails, look up the `.code` value
from its `ValidationError` here.

Debug flag: set `DOTBABEL_DEBUG=1` to route previously-silent git-probe
catches (`resolveRepoRootFromGit`, `getChangedFiles`) to stderr tagged
`[harness:git:*]`.

---

## Spec errors

### `SPEC_JSON_INVALID`

`docs/specs/<id>/spec.json` is missing or fails to parse.
**Fix**: `node -e "JSON.parse(require('fs').readFileSync('docs/specs/<id>/spec.json','utf8'))"` to locate the parse error, or create the file.

### `SPEC_STATUS_INVALID`

`status` is not one of `draft | approved | implementing | done`.
**Fix**: pick a valid status. Only `approved|implementing|done` gate PR coverage.

### `SPEC_ID_MISMATCH`

`spec.json.id` does not equal the directory name.
**Fix**: rename the directory or update `id` — they must match.

### `SPEC_MISSING_REQUIRED_FIELD`

A required field (`title`, `owners`, `depends_on_specs`, `active_prs`, …) is missing or wrong type.
**Fix**: the `pointer` on the error tells you which field.

### `SPEC_LINKED_PATH_MISSING`

`linked_paths` is missing, empty, or contains a non-string entry.
**Fix**: every entry must be a non-empty string glob or path.

### `SPEC_ACCEPTANCE_EMPTY`

`acceptance_commands` is empty or contains a non-string entry.
**Fix**: at least one command that CI can run.

### `SPEC_DEPENDENCY_UNKNOWN`

`depends_on_specs` references an id that does not exist under `docs/specs/`.
**Fix**: create the dependency spec or remove the reference.

---

## Manifest errors

### `MANIFEST_ENTRY_MISSING`

A `.claude/skills-manifest.json` entry points at a path that does not exist on disk.
**Fix**: remove the entry, or restore the file.

### `MANIFEST_CHECKSUM_MISMATCH`

A file's content drifted from the recorded sha256.
**Fix**: `npx dotbabel-validate-skills --update` to recompute and accept the new content, or restore the file to its original state.

### `MANIFEST_ORPHAN_FILE`

A file under `.claude/commands/` or `.claude/skills/<name>/SKILL.md` is not indexed in the manifest.
**Fix**: `npx dotbabel-validate-skills --update` to pick it up (add a manifest entry), or delete the file.

### `MANIFEST_DEPENDENCY_CYCLE`

The `dependencies[]` graph has a cycle.
**Fix**: break the cycle. The error `.got` field shows the path `A -> B -> A`.

---

## Coverage errors

### `COVERAGE_UNCOVERED`

A protected path changed in the PR but no `approved|implementing|done` spec covers it, and the PR body has no `## No-spec rationale` section.
**Fix**: draft a covering spec (status ≥ `approved`) or add a rationale to the PR body.

### `COVERAGE_NO_SPEC_RATIONALE`

The PR body has neither a `## Spec ID` nor a `## No-spec rationale` section, but protected files changed.
**Fix**: add one of the two sections.

### `COVERAGE_UNKNOWN_SPEC_ID`

The PR body references a `Spec ID:` that does not exist under `docs/specs/`.
**Fix**: check the spec directory, or create the spec first.

---

## Drift errors

### `DRIFT_TEAM_COUNT`

An instruction file (CLAUDE.md, README.md) mentions `N team(s)` with N ≠ `docs/repo-facts.json` `team_count`.
**Fix**: update either the file prose or `repo-facts.json.team_count`.

### `DRIFT_PROTECTED_PATH`

A `docs/repo-facts.json` `protected_paths` entry is either non-string or
absent from a file listed in `rule_floor_files`.
**Fix**: add the entry to `CLAUDE.md` §Protected paths, regenerate generated
instruction files with `dotbabel-generate-instructions`, or remove it from
the facts file.

### `DRIFT_INSTRUCTION_FILES`

`instruction_files` is missing/non-array, or `rule_floor_files` is present but
invalid in `docs/repo-facts.json`.
**Fix**: add `instruction_files` as a non-empty array, e.g.
`["CLAUDE.md", "README.md"]`. If `rule_floor_files` is present, make it a
non-empty array of files that must mirror protected-path rules.

### `DRIFT_INSTRUCTION_FILE_MISSING`

An `instruction_files` entry points at a path that does not exist.
**Fix**: create the file or drop the entry.

### `DRIFT_GENERATED_STALE`

A generated rule-floor output differs from what
`dotbabel-generate-instructions` would write.
**Fix**: run `npx dotbabel-generate-instructions` and commit the generated
outputs.

---

## Scaffold errors

### `SCAFFOLD_CONFLICT`

`dotbabel-init` refuses to overwrite an already-initialized repo.
**Fix**: pass `--force` to overwrite, or remove `.claude/skills-manifest.json` / `docs/specs/` first.

### `SCAFFOLD_USAGE`

Bad CLI invocation of `dotbabel-init` (e.g. flag without a value).
**Fix**: see `--help`.

---

## Settings-validator errors (`validate-settings.sh`)

### `SETTINGS_SEC_1`

A `*_KEY` / `*_TOKEN` / `*_SECRET` field in `~/.claude/settings.json` holds
a literal 20+ character value. **Fix**: replace with `${ENV_VAR}` reference.

### `SETTINGS_SEC_2`

`skipDangerousModePermissionPrompt` is set. **Fix**: remove it.

### `SETTINGS_SEC_3`

An MCP server args include `@latest`. **Fix**: pin the version.

### `SETTINGS_SEC_4`

`~/.claude/.credentials.json` is not mode `600`. **Fix**: `chmod 600 ~/.claude/.credentials.json`.

### `SETTINGS_OPS_1`

Settings JSON is malformed OR an MCP command / hook target / enabled plugin does not resolve.
**Fix**: read the specific message — it names the unresolved target.

### `SETTINGS_OPS_2`

`~/.claude/projects/` or `~/.claude/file-history/` exceeded its disk budget.
**Fix**: the warn message includes a `find … -delete` command to prune.

---

## Env + usage

### `ENV_REPO_ROOT_UNKNOWN`

`createHarnessContext()` could not resolve a repo root.
**Fix**: pass `--repo-root <path>` or `DOTBABEL_REPO_ROOT=<path>`, or run inside a git worktree.

### `ENV_FACTS_MISSING`

`docs/repo-facts.json` is missing or unreadable.
**Fix**: scaffold with `dotbabel-init` or author the file (see `plugins/dotbabel/templates/docs/repo-facts.json`).

### `USAGE_UNKNOWN_FLAG`

An unknown flag was passed. Exit 64. **Fix**: see `--help`.

### `USAGE_MISSING_POSITIONAL`

A required positional argument is missing. Exit 64. **Fix**: see `--help`.

---

## Skills & commands (dotfile users)

These issues apply when using the bootstrap path (`./bootstrap.sh`) rather than
the npm CLI. They are not `ERROR_CODES` — they are runtime observations.

### A skill or command isn't available in Claude Code

**Check the symlink exists:**

```bash
ls -la ~/.claude/commands/pre-pr.md
ls -la ~/.claude/skills/aws-specialist/SKILL.md
```

If missing: re-run `./bootstrap.sh`. If present: restart the Claude Code session
(`/clear` or quit and reopen) — the session may have cached the pre-bootstrap state.

### A skill runs but uses outdated behavior

The session cached an older version. Run `./sync.sh pull` (or `dotbabel sync pull`)
to fetch the latest, then restart the session.

### A specialist skill doesn't auto-activate

Specialist skills (e.g. `aws-specialist`) activate when their trigger phrases appear
in your message. Ensure the phrase matches — e.g. write "AWS Lambda" not just
"lambda". If still not triggering, check that the skill's `SKILL.md` is present:

```bash
ls ~/.claude/skills/aws-specialist/SKILL.md
```

### `bootstrap.sh` backed up files I didn't expect

Bootstrap backs up any real file (not a symlink) at a target path before replacing
it. Backups are named `<name>.bak-<timestamp>`. Review them before deleting. This
is intentional — bootstrap never silently overwrites your existing work.

### `sync push` refuses with "secret scan failed"

The push-side scan detected a likely secret (`*_KEY`/`*_TOKEN`/`*_SECRET` pattern
or AWS key format). Review the flagged file and remove the secret. To bypass for
a known-safe file (e.g. a test fixture with a fake key):

```bash
HARNESS_SYNC_SKIP_SECRET_SCAN=1 ./sync.sh push
```

### Taxonomy commands (`search`, `list`, `show`) return "index missing"

Run `dotbabel index` first to build the artifact index. The index is generated
from `agents/`, `skills/`, `commands/`, etc. and must be rebuilt after adding or
renaming artifacts.

```bash
dotbabel index
dotbabel search kubernetes
```
