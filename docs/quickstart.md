# Quickstart

_Last updated: v3.2.0_

dotbabel is a verification layer for agentic development: skills that make an
agent ground its claims in real source, and gates that check the result.

**Two paths — pick yours:**

| I want…                                                                | Path                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Skills & commands in every Claude Code session                         | **[Dotfile bootstrap](./dotfile-quickstart.md)** — 30 seconds, no npm required |
| The CLI in my own repo (verification gates, local attestation, doctor) | **This page** — 10 minutes, Node ≥ 20 required                                 |

---

## CLI consumer — install to first green validator in under 10 minutes

### 1. Install

```bash
cd your-project
npm install --save-dev @dotbabel/dotbabel
```

The package has **zero runtime dependencies**. It registers seven bins under
`node_modules/.bin/`:

```
harness
dotbabel-doctor
dotbabel-detect-drift
dotbabel-init
dotbabel-validate-specs
dotbabel-validate-skills
dotbabel-check-spec-coverage
dotbabel-check-instruction-drift
```

### 2. Scaffold the governance tree

```bash
npx dotbabel-init --project-name your-project --project-type node
```

This writes:

- `.claude/settings.json`, `.claude/settings.headless.json`, `.claude/skills-manifest.json`
- `.claude/hooks/guard-destructive-git.sh`
- `docs/repo-facts.json`, `docs/specs/README.md`
- `.github/workflows/{ai-review,detect-drift,validate-skills}.yml`
- `githooks/pre-commit`

Every placeholder (`{{project_name}}`, `{{project_type}}`, `{{today}}`) is
substituted at scaffold time.

### 3. Run the self-diagnostic

```bash
npx dotbabel-doctor
```

You should see `✓` rows for env, repo, facts, manifest, specs, drift, and hook.
The first run may warn about missing artifacts (e.g. `docs/specs/` empty) —
that's expected until you draft your first spec.

A final row reports check-on-stop trust. On a fresh repo it reads "no trust
allowlist", which is informational and never fails the run — turn-end project
checks are simply off until you opt in. See
[hooks.md](./hooks.md#check-on-stop-trust).

### 4. Your first spec

Use the `/spec` skill (if you're in a Claude Code session) or scaffold
manually:

```
docs/specs/my-first-feature/
├── spec.json
└── spec.md
```

Minimum viable `spec.json`:

```json
{
  "id": "my-first-feature",
  "title": "My first feature",
  "status": "draft",
  "owners": ["Your Name"],
  "linked_paths": ["src/my-feature/**"],
  "acceptance_commands": ["npm test"],
  "depends_on_specs": [],
  "active_prs": []
}
```

Validate it:

```bash
npx dotbabel-validate-specs
```

Green. You're done.

### 5. Wire the PR gate

In GitHub branch protection, require the three shipped workflows:

- `validate-skills` — manifest + drift + specs
- `detect-drift` — flags stale `.claude/commands/*.md`
- `ai-review` — PR review (optional)

Any PR touching a protected path (see `docs/repo-facts.json`) must now carry
a `Spec ID:` or `## No-spec rationale` section. `dotbabel-check-spec-coverage`
enforces it.

### 6. Project-scope cross-CLI sync (optional)

If your repo has `.claude/commands/*.md` and `.claude/skills/*` that you want
visible to Codex, Gemini, and Copilot — not just Claude Code — wire them up
with `project-sync`. This is repo-local; user-scope artifacts stay in
`~/.claude/` etc. via `dotbabel bootstrap`.

```bash
cd ~/projects/my-app

# 6a. One-time scaffold (writes .dotbabel.json + a starter CLAUDE.md if missing)
npx dotbabel project-init

# 6b. Preview, then apply
npx dotbabel project-sync --dry-run
npx dotbabel project-sync

# 6c. Verify (CI-safe, read-only)
npx dotbabel check-project-sync
```

What lands where:

| Source                         | Codex / Gemini destination                | Copilot destination                                                         |
| ------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| `.claude/commands/<name>.md`   | `.codex/skills/<name>/SKILL.md` (symlink) | `.github/prompts/<name>.prompt.md` (generated, frontmatter mapped)          |
| `.claude/skills/<id>/SKILL.md` | `.codex/skills/<id>/` (whole-dir symlink) | `.github/instructions/<id>.instructions.md` (generated, frontmatter mapped) |
| `CLAUDE.md` (rule-floor block) | rendered into `AGENTS.md` + `GEMINI.md`   | rendered into `.github/copilot-instructions.md`                             |

**What Codex and Gemini get.** Every Codex/Gemini destination is a symlink to
the Claude source file, not a translated copy — they read their own
frontmatter shape, so Claude-shaped frontmatter (`allowed-tools`, `model`,
`effort`, `disable-model-invocation`, the auto-routing `description`) is not
honored. Expect only direct slash invocation by name: `/commit` works, but
natural-language auto-routing, tool restrictions, and model selection apply
in Claude Code alone. A command that describes a Claude-only flow (headless
Claude workers, Claude-specific flags) fans out verbatim unless you list it
in `cli_excluded` below. Tracked at
[#219](https://github.com/kaiohenricunha/dotbabel/issues/219).

**What Copilot gets.** Unlike Codex/Gemini, Copilot's targets are generated
files with mapped frontmatter — `description`, `name`, `argument-hint`, and
tool grants carry over correctly. `model`, `effort`, and
`disable-model-invocation` still have no Copilot equivalent and are dropped
with a warning naming the file and the key. See
[`docs/copilot-frontmatter-mapping.md`](./copilot-frontmatter-mapping.md) for
the full key-by-key table. A generated file that is hand-edited is backed up
before the next sync overwrites it.

`.dotbabel.json` is optional — without one, project-sync uses defaults
(`fan_out: ["codex", "gemini", "copilot"]`, the standard target list, no
`cli_substitutions`). When `CLAUDE.md` has no `<!-- dotbabel:rule-floor:begin -->`
markers, the whole file becomes the rule floor.

Add `$schema` to the top of the file for editor autocomplete and validation:

```json
{
  "$schema": "https://dotbabel.dev/schemas/dotbabel.config.schema.json",
  "fan_out": ["codex", "gemini", "copilot"],
  "fan_out_layout": "per-cli",
  "gate_on_cli_presence": true
}
```

`fan_out` accepts only `codex`, `gemini`, and `copilot`. A typo such as
`co-pilot` fails with `CONFIG_UNKNOWN_CLI` instead of being skipped.

`fan_out_layout` (default `per-cli`) decides whether Codex and Gemini get one
tree each or share a canonical one. Under `shared`, the table above collapses:
`.claude/` fans out once to `.cli/skills/`, and `.codex/skills` and
`.gemini/skills` become symlinks to it, so each command and skill is tracked
once instead of twice. Copilot's `.github/` shapes are unchanged. Switching an
existing repo backs the old trees up to `.codex/skills.bak-<timestamp>`; an
unknown value fails with `CONFIG_UNKNOWN_LAYOUT`. Revert to `per-cli` if a CLI
will not follow the redirect.

`gate_on_cli_presence` (default `true`) skips a CLI's symlink fan-out when its
binary is absent from `PATH`. `check-project-sync` applies the same gate, so it
does not report the un-synced CLI as drift and instead prints
`skipped <cli>: not on PATH`. Pass `--all` to either command to inspect every
CLI in `fan_out` regardless. Instruction files are always written, never gated.

`cli_excluded` (default `{}`) maps a CLI to the command basenames and skill ids
it must not receive:

```json
{
  "cli_excluded": { "codex": ["review-prs-parallel"], "copilot": ["review-prs-parallel"] }
}
```

The sync skips those entries for that CLI and removes a link it wrote on an
earlier run; `check-project-sync` reports a lingering one as
`stale (excluded but present)`. A name that matches nothing warns, an unknown
CLI key fails with `CONFIG_UNKNOWN_CLI`, and any other shape fails with
`CONFIG_INVALID_EXCLUSION`. Under `fan_out_layout: "shared"` Codex and Gemini
read one tree, so an exclusion for either applies to both and the sync warns
when their lists differ.

A repo with `.dotbabel.json` will also be picked up by `dotbabel doctor` —
the diagnostic adds a project-sync wiring check.

### Next

- [cli-reference.md](./cli-reference.md) — every flag, exit code, `--json` schema.
- [troubleshooting.md](./troubleshooting.md) — look up any failing `ERROR_CODE`.
- [personas.md](./personas.md) — map your role to the right entry-point.
