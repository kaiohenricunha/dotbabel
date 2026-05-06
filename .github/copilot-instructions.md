# Copilot instructions for `@dotbabel/dotbabel`

This repo is a **dual-purpose checkout**: a portable npm package
(`@dotbabel/dotbabel`) **and** the maintainer's personal global Claude Code
config that gets symlinked into `~/.claude/`. Most contributions land in the
package. See `docs/personas.md` for the distinction. Read `CLAUDE.md` first —
it sets the global rule floor every session inherits.

## Build, test, lint

Node ≥ 20. Avoid adding new runtime dependencies (ADR-0002) — any new
runtime dep needs a very strong case (devdeps OK).

```bash
npm ci
npm test                                     # vitest, must stay 90/90+ green
npm test -- plugins/dotbabel/tests/validate-specs.test.mjs   # single file
npm test -- -t "regex matching test name"                     # single test
npm run coverage                             # thresholds: lines 85 / fns 85 / branches 80 / stmts 85
npm run lint                                 # prettier + markdownlint + JSDoc coverage
npm run shellcheck                           # all bash scripts
npm run dogfood                              # runs the validators against this repo
npm run docs:stamp-check                     # docs/*.md must carry _Last updated: vX.Y.Z_

# Shell test suites (not part of `npm test`)
bash plugins/dotbabel/tests/test_validate_settings.sh
npx bats plugins/dotbabel/tests/bats/
```

`npm run dogfood` is the same gate CI runs in `.github/workflows/dogfood.yml`;
run it before pushing changes that touch `plugins/dotbabel/src/`,
`docs/specs/**`, `CLAUDE.md`, or `README.md`.

## Architecture (the big picture)

Layered Node ESM, no TypeScript, no bundler. Read `docs/architecture.md` for
the full diagram; the short version:

- `plugins/dotbabel/bin/*.mjs` — CLI entry points. Validator-style bins
  follow the standard pipeline:
  `parse(lib/argv) → validator → createOutput(lib/output) →
formatError(lib/errors) → exit(lib/exit-codes)`. Exceptions include
  `plugins/dotbabel/bin/dotbabel.mjs` (the umbrella dispatcher) and
  `plugins/dotbabel/bin/dotbabel-detect-drift.mjs` (a thin wrapper that may
  use `spawn` / `process.exit`). Validator bins are exposed as standalone
  `npx dotbabel-<thing>` commands, and most are also reachable as
  subcommands of `dotbabel`.
- `plugins/dotbabel/src/lib/` — shared primitives (`argv`, `output`,
  `errors`, `exit-codes`, `debug`). Validators must use these, not raw
  `console.log` / `process.exit` / `throw new Error(string)`.
- `plugins/dotbabel/src/*.mjs` — the validators themselves
  (`validate-specs`, `validate-skills-inventory`, `check-spec-coverage`,
  `check-instruction-drift`, `init-harness-scaffold`, `bootstrap-global`,
  `sync-global`, `build-index`). Every `errors.push(...)` emits a
  `ValidationError(code, …)` from `src/lib/errors.mjs`.
- `plugins/dotbabel/src/spec-harness-lib.mjs` — the only place that touches
  filesystem / git / PR-context primitives. Validators consume it; they do
  not reach for `fs` or `child_process` directly.
- `plugins/dotbabel/src/index.mjs` — the public Node API barrel
  (`createHarnessContext`, `validateSpecs`, `ERROR_CODES`, `EXIT_CODES`, …).
  Excluded from coverage on purpose; treat it as wiring only.

The other plugin slot, `plugins/harness/`, is a sibling consumer-facing
plugin with its own `scripts/lib/output.sh` + `src/lib/argv.mjs` conventions
— do not cross-import between `plugins/dotbabel/` and `plugins/harness/`.

## Repo conventions worth knowing

- **Worktrees, not branches on the main checkout.** Non-trivial work belongs
  in `.claude/worktrees/<slug>/` branched from `origin/main`. Multiple
  agents/humans run concurrently; the main checkout is effectively read-only.
  Enforced by `CLAUDE.md §Worktree discipline`.
- **Spec-anchored PRs.** Any PR touching a path listed in
  `docs/repo-facts.json → protected_paths` (currently `CLAUDE.md`,
  `README.md`, `.github/workflows/**`, `.claude/**`, `docs/repo-facts.json`,
  `docs/specs/**/spec.json`, `plugins/dotbabel/{src,bin,templates}/**`)
  must carry either `Spec ID: dotbabel-core` (H2 heading — the validator
  extracts it via H2 regex) **or** a `## No-spec rationale` section in the
  PR body. `dotbabel-check-spec-coverage` is the gate.
- **Spec status vocabulary.** `docs/specs/**/spec.json` `status` is one of
  `draft | approved | implementing | done`. Coverage only counts
  `approved | implementing | done`.
- **CLI contract for every bin.** Honor `--help`, `--version`, `--json`,
  `--verbose`, `--no-color`. Exit via the named `EXIT_CODES`:
  `OK=0`, `VALIDATION=1`, `ENV=2`, `USAGE=64` (BSD `sysexits.h EX_USAGE`).
- **Structured errors.** Add new failure classes to `ERROR_CODES` rather
  than throwing string errors; consumers branch on the code.
- **JSDoc every export.** `scripts/check-jsdoc-coverage.mjs` fails CI on
  undocumented `export`s under `plugins/dotbabel/src/`.
- **Shell discipline.** `set -euo pipefail` at the top of every script;
  source `plugins/dotbabel/scripts/lib/output.sh` for `pass` / `fail` /
  `warn` / `out_summary`; gate JSON output via `DOTCLAUDE_JSON=1`. `bash`
  only — never `zsh` (its read-only `$status` silently breaks scripts).
- **Bats tests** capture stderr by redirecting `2>&1` because `run` only
  captures stdout; handoff scripts intentionally print usage/errors to
  stderr.
- **Doc version stamps.** `docs/*.md` carry `_Last updated: vX.Y.Z_`
  matching `package.json` `version`. Never edit by hand — run
  `npm run docs:stamp` after a version bump; CI runs `docs:stamp-check`.
- **Commands & skills are part of the published package.** Files under
  `commands/`, `skills/`, `schemas/`, and `CLAUDE.md` ship in the npm
  tarball (see `package.json → files`). Treat them as user-visible API.
- **Manifest invariant.** Every file under `.claude/commands/` must be
  indexed in `.claude/skills-manifest.json` or `validate-skills` fails
  with `MANIFEST_ORPHAN_FILE`.
- **Agent template rules.** Templates under
  `plugins/dotbabel/templates/claude/agents/` require YAML frontmatter
  (`name`, `description`, `tools`, `model`); `model` must be one of
  `opus | sonnet | haiku | inherit`. Agents whose name matches
  auditor / reviewer / inspector must **not** include `Write` or `Edit`
  in `tools`.
- **Prettier ignore.** `npm run lint` invokes prettier with
  `--ignore-path .gitignore`, so `.prettierignore` is **not** consulted
  unless the script changes.
- **Release flow.** Bump `package.json` `version` → `npm run docs:stamp`
  → add `## [X.Y.Z] — YYYY-MM-DD` to `CHANGELOG.md` → PR titled
  `chore(release): vX.Y.Z` with a `## No-spec rationale` block.
- **Commits.** Conventional commits (`feat(scope): …`,
  `fix(scope): …`, `chore(scope): …`). Never `--amend` a published
  commit, force-push someone else's branch, or pass `--no-verify` /
  `--no-gpg-sign`. Prefer new commits over `--amend` once a PR is in
  review.
