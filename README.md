# dotclaude

Global Claude Code configuration + a portable harness plugin for spec-driven development.

Two things live here:

1. **`@kaiohenricunha/harness`** — a dual-purpose Claude Code plugin + npm package for SDD governance, skills-manifest validation, and drift detection. Designed to be installed in any repo, not just this one. [Skip to usage →](#harness-plugin-usage)
2. **Kaio's personal dotfiles** — the global `CLAUDE.md`, slash commands, and skills symlinked into `~/.claude/`. Clone, bootstrap, use. [Skip to dotfiles →](#personal-dotfiles-usage)

---

## Harness plugin usage

The harness gives you four CLI validators and a scaffolder:

| Tool | Purpose |
|---|---|
| `harness-validate-skills` | Enforces checksums on `.claude/skills-manifest.json` — catches skill files drifting from their inventory entry |
| `harness-validate-specs` | Validates `docs/specs/<slug>/spec.json` schema + `status` enum + `id/dir-name` match |
| `harness-check-spec-coverage` | PR-time gate: changes to protected paths must be covered by an approved spec or a `## No-spec rationale` section |
| `harness-check-instruction-drift` | Cross-checks `CLAUDE.md` ↔ `README.md` ↔ `.github/copilot-instructions.md` ↔ `docs/repo-facts.json` for drift |
| `harness-init` | Scaffolds the full harness into a fresh repo — `.claude/`, `docs/specs/`, CI workflow, hooks |

### Install

```bash
# In any repo:
npm install -D github:kaiohenricunha/dotclaude#main
```

### Scaffold a fresh repo

```bash
# In an empty git repo (must have an initial commit):
npx harness-init --project-name my-project --project-type node
```

You get:
- `.claude/{settings.json, settings.headless.json, skills-manifest.json, hooks/guard-destructive-git.sh}`
- `docs/{repo-facts.json, specs/README.md}`
- `.github/workflows/{validate-skills.yml, detect-drift.yml, ai-review.yml}`
- `githooks/pre-commit` (opt-in via `git config core.hooksPath githooks`)

### Wire into CI

Add to `package.json`:

```json
{
  "scripts": {
    "verify:harness": "harness-validate-skills && harness-validate-specs && harness-check-instruction-drift && harness-check-spec-coverage"
  }
}
```

The scaffolded `.github/workflows/validate-skills.yml` runs the chain on every PR + weekly cron.

### Contract your repo must follow

- `docs/repo-facts.json` — canonical source of truth (team count, protected paths, verification commands)
- `docs/specs/<slug>/spec.json` — spec metadata: `id`, `title`, `status` (one of `draft | approved | implementing | done`), `owners`, `linked_paths`, `acceptance_commands`, `depends_on_specs`, `active_prs`
- `.claude/skills-manifest.json` — SHA256-checksummed inventory of `.claude/commands/*.md` and `.claude/skills/*/SKILL.md`

### Node API

```javascript
import {
  createHarnessContext,
  validateManifest,
  ValidationError,
  EXIT_CODES,
} from "@kaiohenricunha/harness";

const ctx = createHarnessContext({ repoRoot: "/path/to/repo" });
const { ok, errors } = validateManifest(ctx);
if (!ok) {
  for (const err of errors) {
    // err is a ValidationError with .code / .file / .hint / .category
    console.error(err.toString());
  }
  process.exit(EXIT_CODES.VALIDATION);
}
```

All exports (24+ symbols: validators, helpers, `ValidationError`, `ERROR_CODES`, `EXIT_CODES`, `version`) come from the single barrel `@kaiohenricunha/harness`. Deep imports like `@kaiohenricunha/harness/plugins/...` are not a supported contract.

All validators accept an explicit `repoRoot` or fall back to `process.env.HARNESS_REPO_ROOT`, then to `git rev-parse --show-toplevel`.

### Self-healing scripts (advanced)

- `plugins/harness/scripts/refresh-worktrees.sh` — FF-merges clean worktrees with `origin/main`, skips dirty ones
- `plugins/harness/scripts/detect-branch-drift.mjs` — flags `.claude/commands/*.md` that diverge from main for more than 14 days
- `plugins/harness/templates/githooks/pre-commit` — auto-refreshes `skills-manifest.json` checksums when commands/skills change

---

## Personal dotfiles usage

This is the owner's workflow — only relevant if you want to fork-then-adapt this repo for your own setup.

### Fresh distro setup

```bash
git clone git@github.com:kaiohenricunha/dotclaude.git ~/Projects/kaiohenricunha/dotclaude
cd ~/Projects/kaiohenricunha/dotclaude
./bootstrap.sh
```

`bootstrap.sh` creates idempotent symlinks from this repo into `~/.claude/`:
- `CLAUDE.md` → `~/.claude/CLAUDE.md` (global rule floor)
- `commands/*.md` → `~/.claude/commands/*.md` (slash commands like `/create-audit`, `/merge-pr`, `/commit`)
- `skills/*/` → `~/.claude/skills/*/` (directory-form skills like `spec/`, `validate-spec/`)

Pre-existing real files get backed up to `<name>.bak-<timestamp>` before being replaced — so first run on a populated `~/.claude/` is non-destructive.

### Sync between machines

```bash
./sync.sh pull    # fetch + rebase + re-run bootstrap
./sync.sh push    # stage + commit + push
./sync.sh status  # git status --short
```

### Adding a new global command or skill

Drop the file at its real home (`commands/new-thing.md` or `skills/new-thing/SKILL.md`), re-run `./bootstrap.sh`, commit, push. No `~/.claude/` editing required.

---

## What ships in the public npm package

The root `package.json` declares `@kaiohenricunha/harness`. Its `files` field ships only the portable subset:

- `plugins/harness/{src,bin,templates,hooks,README.md,.claude-plugin}/**`

Personal config (`CLAUDE.md`, `commands/`, `skills/`, `bootstrap.sh`, `sync.sh`) is present in the repo but **not** in the published package — consumers installing via `npm install -D github:kaiohenricunha/dotclaude#main` get only the harness.

---

## Configuration decisions (2026-04-13 hardening)

Full context: [spec](docs/specs/claude-hardening/) · [audit](docs/audits/claude-code-global-config-2026-04-13.md) · [assessment](docs/assessments/claude-code-global-config-2026-04-13.md) · [plan](docs/plans/2026-04-13-claude-code-global-config-cleanup.md).

| Decision | Rationale | Where enforced |
|----------|-----------|---------------|
| **Secrets live in shell env, not `settings.json`** | An external API key was previously embedded literal in global settings. Now sourced from shell env via `${PROVIDER_API_KEY}` reference, exported in `~/.zshrc`. | Validator SEC-1 (regex on `*_KEY`/`*_TOKEN`/`*_SECRET` fields) |
| **Dangerous-mode confirmation restored** | `skipDangerousModePermissionPrompt` was silently bypassing the prompt globally. Safer default even with more friction on long skill chains. | Validator SEC-2 |
| **No `@latest` in MCP `args`** | An MCP package was refetching on every session start. Always pin to an explicit version in MCP `args`. Applies to every MCP. | Validator SEC-3 |
| **`claude-code-lsps` owns LSPs** | Dedicated marketplace beats the generalist `*-lsp@claude-plugins-official` triplet. Those three plugins were uninstalled. | Validator: `enabledPlugins` must contain no `*-lsp@claude-plugins-official` |
| **Project-bound MCPs live in `<project>/.mcp.json`** | Project-specific MCPs (e.g. language servers, project filesystems) previously pinned at user scope. Moved to `<project>/.mcp.json`. Genuinely cross-project MCPs stay global. | Pre-flight diff + validator MCP-command-exists check |
| **Hooks block kept minimal** | All 8 Vibecraft events were removed (consumer offline, `events.jsonl` truncated from 779 MB to 0). Only `validate-edit.sh` PostToolUse survives. | Validator: every `hooks[*].command` must exist on disk |
| **60-day age-based retention** | `~/.claude/projects/` and `~/.claude/file-history/` pruned on `mtime +60`. Soft budget: projects/ ≤ 1.5 GB, file-history/ ≤ 100 MB (warn only). | Validator OPS-2 (disk budget warning) |
| **`.credentials.json` mode 600** | Token file must never widen. | Validator SEC-4 |
| **`context7` runs globally, not per-project** | Library docs lookup is cross-project value; used to be pinned to a single project scope. | Global `enabledPlugins` |

### Settings validator

`plugins/harness/scripts/validate-settings.sh` encodes every decision above as a hard or soft check. Also symlinked at `~/.claude/scripts/validate-settings.sh`.

```bash
~/.claude/scripts/validate-settings.sh            # checks ~/.claude/settings.json
~/.claude/scripts/validate-settings.sh <path>     # checks an alternative file
```

Exit 0 = pass, 1 = hard failure. Warnings don't fail exit code. Tests: `plugins/harness/tests/test_validate_settings.sh` (8 fixtures covering positive + negative cases).

### Pre-flight rollback snapshot

Before the 2026-04-13 hardening run, the previous state was captured at `~/.claude/settings.json.preflight-2026-04-13`. Restore with `cp` if anything breaks.

### Standing TODOs

- `~/.claude/projects/` is 1.85 GB (validator warns; soft limit 1.5 GB). Most transcripts are recent (< 60 days); the retention policy will reclaim space over time. For immediate relief, prune stale worktree sessions manually.
- `frontend-design`, `skill-creator`, `security-guidance`, `context7` show `version: "unknown"` in the install registry. Cosmetic; the marketplace manifest doesn't expose versions for these plugins. `claude plugins update` is a no-op.

---

## License

MIT. See [LICENSE](LICENSE) if present; otherwise the MIT terms apply to the plugin code. Personal config files (CLAUDE.md, commands/, skills/) are provided as-is.
