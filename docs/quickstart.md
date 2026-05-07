# Quickstart

_Last updated: v2.0.1_

**Two paths — pick yours:**

| I want…                                                                 | Path                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Skills & commands in every Claude Code session                          | **[Dotfile bootstrap](./dotfile-quickstart.md)** — 30 seconds, no npm required |
| Governance CLI for my own repo (bootstrap, doctor, optional spec gates) | **This page** — 10 minutes, Node ≥ 20 required                                 |

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

You should see `✓` rows for env, repo, facts, manifest, specs, drift, hook.
The first run may warn about missing artifacts (e.g. `docs/specs/` empty) —
that's expected until you draft your first spec.

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

### Next

- [cli-reference.md](./cli-reference.md) — every flag, exit code, `--json` schema.
- [troubleshooting.md](./troubleshooting.md) — look up any failing `ERROR_CODE`.
- [personas.md](./personas.md) — map your role to the right entry-point.
