# Template catalog

_Last updated: v3.4.0_

Every file under `plugins/dotbabel/templates/` is written verbatim into a
consumer repo by `dotbabel-init`, with `{{placeholder}}` tokens substituted
at scaffold time.

Substitution logic lives at
[`../plugins/dotbabel/src/init-harness-scaffold.mjs`](../plugins/dotbabel/src/init-harness-scaffold.mjs);
test coverage (including the "unrecognized placeholder survives" contract)
is at
[`../plugins/dotbabel/tests/init-harness-scaffold.test.mjs`](../plugins/dotbabel/tests/init-harness-scaffold.test.mjs).

## Placeholders

| Token              | Source                                                 | Default         |
| ------------------ | ------------------------------------------------------ | --------------- |
| `{{project_name}}` | `dotbabel-init --project-name`                         | `basename(cwd)` |
| `{{project_type}}` | `dotbabel-init --project-type`                         | `"unknown"`     |
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
│   ├── pre-commit                        → githooks/pre-commit
│   └── pre-push                          → githooks/pre-push
└── workflows/
    ├── ai-review.yml                     → .github/workflows/ai-review.yml
    ├── detect-drift.yml                  → .github/workflows/detect-drift.yml
    ├── quality.yml                       → .github/workflows/quality.yml
    ├── test.yml                          → .github/workflows/test.yml
    └── validate-skills.yml               → .github/workflows/validate-skills.yml
```

## Per-template rationale

- **`claude/hooks/guard-destructive-git.sh`** — PreToolUse hook that blocks
  destructive git calls. Exit 2 per Claude Code hook protocol. See
  [ADR-0014](./adr/0014-cli-tick-cross-warn-format.md) for the ✓/✗/⚠ format inheritance.
  This tree is the **repo-scope** surface `dotbabel-init` scaffolds, and it carries
  only the guard hook. The editor and turn-end checkers (`check-on-write.sh`,
  `check-on-stop.sh`) install **user-scope** instead — `bootstrap.sh` symlinks them
  from `plugins/dotbabel/hooks/` into `~/.claude/hooks/`. See [hooks.md](./hooks.md).
- **`claude/skills-manifest.json`** — minimal `{version:1, skills:[]}`
  seed. Run `npx dotbabel-validate-skills --update` after adding skills to
  populate checksums.
- **`claude/settings.json`** — wires the guard hook into PreToolUse.
- **`claude/settings.headless.json`** — same surface but with CI-friendly
  permissions (no interactive prompts).
- **`docs/repo-facts.json`** — the facts source of truth.
  `dotbabel-check-instruction-drift` cross-references it with
  `instruction_files` and, when present, `rule_floor_files`.
- **`docs/specs/README.md`** — onboarding doc for the spec workflow.
- **`githooks/pre-commit`** — auto-refreshes the manifest when a skill
  file changes.
- **`githooks/pre-push`** — runs the `fast` quality profile against the
  upstream merge base. Only a policy failure blocks; a missing tool, exit 2,
  or a timeout prints a notice and allows the push (KD-11). Activation is
  manual and stays that way, because the hook runs repository code:
  `git config core.hooksPath githooks`. Bypass with `BYPASS_PRE_PUSH=1`.
- **`workflows/validate-skills.yml`** — runs every validator on PR + push.
- **`workflows/detect-drift.yml`** — weekly cron flagging stale commands.
- **`workflows/ai-review.yml`** — Claude Code review wiring (same-repo PR
  gating).
- **`workflows/test.yml`** — pull-request verification. A classify job honors
  a SHA-pinned local attestation from a trusted author; a verify job runs the
  `pr` quality profile when there is none. A separate `dotbabel-criteria` job
  always runs, checks out the pull-request head SHA, and verifies acceptance
  criteria **without** `--post` — CI verifies, it never writes evidence
  (KD-10).
- **`workflows/quality.yml`** — the `deep` profile weekly and on manual
  dispatch. Deep carries mutation and race detection, which is why it is not
  on the pull-request path.

**These workflows run project commands in CI, and the scaffolder installs
them.** `test.yml` and `quality.yml` both pass `--allow-project-commands`, so
they execute the build and test commands the adopted repository declares. That
was previously the stated reason to keep a quality workflow out of this
directory and in `examples/quality/` instead; KD-10 reverses that call,
because a verification harness nobody installs verifies nothing. The exposure
is bounded by the same trust boundary GitHub Actions already applies to any CI
that runs a test suite: the trigger is `pull_request`, never
`pull_request_target`, so a fork's pull request runs the fork's code with a
read-only token and no repository secrets. Delete either file after
`dotbabel init` if you would rather opt in later — nothing else depends on
them being present.

## Changing a template

1. Edit the file under `plugins/dotbabel/templates/…`.
2. Re-run the scaffolder into a scratch tmpdir:
   ```bash
   TMP=$(mktemp -d); cd $TMP; git init -q
   node /path/to/dotbabel/plugins/dotbabel/bin/dotbabel-init.mjs \
     --project-name scratch --project-type node
   ```
3. Inspect the output.
4. **Regenerate `examples/minimal-consumer/`** in the same PR so the
   dogfood workflow stays current. See
   [../examples/minimal-consumer/README.md](../examples/minimal-consumer/README.md)
   for the exact command.
