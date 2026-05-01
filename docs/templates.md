# Template catalog

_Last updated: v1.2.1_

Every file under `plugins/dotclaude/templates/` is written verbatim into a
consumer repo by `dotclaude-init`, with `{{placeholder}}` tokens substituted
at scaffold time.

Substitution logic lives at
[`../plugins/dotclaude/src/init-harness-scaffold.mjs`](../plugins/dotclaude/src/init-harness-scaffold.mjs);
test coverage (including the "unrecognized placeholder survives" contract)
is at
[`../plugins/dotclaude/tests/init-harness-scaffold.test.mjs`](../plugins/dotclaude/tests/init-harness-scaffold.test.mjs).

## Placeholders

| Token              | Source                                                 | Default         |
| ------------------ | ------------------------------------------------------ | --------------- |
| `{{project_name}}` | `dotclaude-init --project-name`                        | `basename(cwd)` |
| `{{project_type}}` | `dotclaude-init --project-type`                        | `"unknown"`     |
| `{{today}}`        | `new Date().toISOString().slice(0,10)` (scaffold time) | —               |

Tokens not listed above pass through unchanged. That's intentional — a
consumer template can reference e.g. `{{custom_marker}}` knowing the
scaffolder won't touch it.

## Tree

```
templates/
├── claude/
│   ├── hooks/
│   │   └── guard-destructive-git.sh      → .claude/hooks/
│   ├── skills-manifest.json              → .claude/skills-manifest.json
│   ├── settings.json                     → .claude/settings.json
│   └── settings.headless.json            → .claude/settings.headless.json
├── docs/
│   ├── repo-facts.json                   → docs/repo-facts.json
│   └── specs/
│       └── README.md                     → docs/specs/README.md
├── githooks/
│   └── pre-commit                        → githooks/pre-commit
└── workflows/
    ├── ai-review.yml                     → .github/workflows/ai-review.yml
    ├── detect-drift.yml                  → .github/workflows/detect-drift.yml
    └── validate-skills.yml               → .github/workflows/validate-skills.yml
```

## Per-template rationale

- **`claude/hooks/guard-destructive-git.sh`** — PreToolUse hook that blocks
  destructive git calls. Exit 2 per Claude Code hook protocol. See
  [ADR-0014](./adr/0014-cli-tick-cross-warn-format.md) for the ✓/✗/⚠ format inheritance.
- **`claude/skills-manifest.json`** — minimal `{version:1, skills:[]}`
  seed. Run `npx dotclaude-validate-skills --update` after adding skills to
  populate checksums.
- **`claude/settings.json`** — wires the guard hook into PreToolUse.
- **`claude/settings.headless.json`** — same surface but with CI-friendly
  permissions (no interactive prompts).
- **`docs/repo-facts.json`** — the facts source of truth.
  `dotclaude-check-instruction-drift` cross-references it with `CLAUDE.md`
  and `README.md`.
- **`docs/specs/README.md`** — onboarding doc for the spec workflow.
- **`githooks/pre-commit`** — auto-refreshes the manifest when a skill
  file changes.
- **`workflows/validate-skills.yml`** — runs every validator on PR + push.
- **`workflows/detect-drift.yml`** — weekly cron flagging stale commands.
- **`workflows/ai-review.yml`** — Claude Code review wiring (same-repo PR
  gating).

## Changing a template

1. Edit the file under `plugins/dotclaude/templates/…`.
2. Re-run the scaffolder into a scratch tmpdir:
   ```bash
   TMP=$(mktemp -d); cd $TMP; git init -q
   node /path/to/dotclaude/plugins/dotclaude/bin/dotclaude-init.mjs \
     --project-name scratch --project-type node
   ```
3. Inspect the output.
4. **Regenerate `examples/minimal-consumer/`** in the same PR so the
   dogfood workflow stays current. See
   [../examples/minimal-consumer/README.md](../examples/minimal-consumer/README.md)
   for the exact command.
