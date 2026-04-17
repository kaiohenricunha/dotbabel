# Changelog

All notable changes to `@dotclaude/dotclaude` land here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Marketplace submission for the Claude Code plugin listing.
- `dotclaude upgrade` subcommand to migrate consumer repos across versions.
- `.d.ts` shipping for stronger type inference (via hand-authored declarations
  — TypeScript migration is out of scope per ADR-0002).

## [0.4.0] — 2026-04-17

No breaking changes. This release adds the global-lifecycle CLI
(`dotclaude bootstrap`, `dotclaude sync`), first-class agents, the
taxonomy pipeline (schemas → backfill → search/list/show → build-plugin),
and a broad set of provider and IaC agents.

### Added

- **Global lifecycle CLI** — `dotclaude bootstrap` (set up or refresh
  `~/.claude/`) and `dotclaude sync <pull|status|push>` (update an
  installation). Both are idempotent, support `--json` / `--quiet`
  / `--no-color`, and are registered as subcommands of the umbrella
  `dotclaude` dispatcher alongside the taxonomy commands (#29).
- **First-class agent support** — agents directory, model routing,
  and discovery wired into the plugin (#28). Ships with 21 agents
  across generalist, specialist, and veracity tiers (#40):
  - Kubernetes ecosystem agents + `kubernetes-specialist` skill (#31).
  - AWS, Azure, GCP provider agents + `*-specialist` skills (#32).
  - IaC tool agents (Terraform, Terragrunt, Pulumi, Crossplane) +
    `*-specialist` skills (#33).
  - Generic veracity harness: `data-scientist`, `compliance-auditor`,
    and the `veracity-audit` skill (#41).
- **Taxonomy pipeline** — a four-phase buildout that formalizes the
  skill/agent metadata layer:
  - Phase 1: schemas + index builder + non-breaking CLI (#34).
  - Phase 2: frontmatter backfill + schema tightening (#36).
  - Phase 3: `dotclaude search`, `dotclaude list`, `dotclaude show`
    + governance docs + CI gate (#37).
  - Phase 4: `build-plugin` script + generated plugin templates (#38).
- **Slash commands** — generic `/review-pr` (#22) and `/create-inspection`
  (#23), plus strengthened branch-health gates and mandatory test plans
  in `/review-pr` (#25).
- **Lint pipeline** — `npm run lint` now wires `prettier` and
  `markdownlint-cli2` (#18).

### Changed

- README and CLAUDE.md document the two-path usage model
  (bootstrap vs npm plugin) (#24) and the new `bootstrap` / `sync`
  subcommands (#30).
- CLAUDE.md absorbs the Karpathy behavioral guidelines (#26).
- `dotclaude-agents` spec registered; `.gitignore` cleaned up (#39).
- Agent spec text updated with tier rationale from audit findings (#42).
- CI bumps `actions/upload-artifact` 4.6.2 → 7.0.1 (#13).

### Fixed

- `bootstrap` now links `hooks/` into `~/.claude/hooks/` so
  guard-destructive-git and friends apply globally (#35).
- Patched `js-yaml` prototype pollution (GHSA-mh29-5h37-fv8m) (#27).
- Closed 12 open CodeQL alerts around workflow permissions and
  security (#19).
- Dogfood workflow now uses `PR_ACTOR` (derived from PR author)
  instead of the `GITHUB_ACTOR` builtin, restoring correct bot
  detection (#20, #21).

## [0.3.0] — 2026-04-14

### Breaking

- **Package renamed** from `@kaiohenricunha/harness` → `@dotclaude/dotclaude`.
  Update your `package.json` dependency and all imports.
- **All CLI bins renamed**: `harness-*` → `dotclaude-*` (e.g. `harness-doctor`
  → `dotclaude-doctor`). Update CI workflows, pre-commit hooks, and any scripts
  that invoke them directly.
- **Three env vars renamed**: `HARNESS_DEBUG` → `DOTCLAUDE_DEBUG`,
  `HARNESS_JSON` → `DOTCLAUDE_JSON`, `HARNESS_REPO_ROOT` → `DOTCLAUDE_REPO_ROOT`.
  Note: `HARNESS_CHANGED_FILES` (CI diff input) and `HARNESS_SYNC_SKIP_SECRET_SCAN`
  (sync.sh bypass) are **not** renamed — they remain `HARNESS_*`.
- **Plugin directory** moved from `plugins/harness/` → `plugins/dotclaude/`
  (affects deep imports — use the public barrel `@dotclaude/dotclaude` instead).
- **Spec ID** `harness-core` → `dotclaude-core` (update `Spec ID:` lines in PR
  bodies and any `depends_on_specs` references).

### Changed

- npm scope changed from `@kaiohenricunha` to `@dotclaude` — published under
  the public `dotclaude` npm org.
- Prose and docs de-personalized for a public audience.

## [0.2.0] — 2026-04-14

First public release targeting `npm publish --provenance --access public`.
Productizes the plugin: public Node API barrel, structured-error contract,
umbrella CLI, shell hardening, full bats + vitest coverage, dogfood wiring,
and the docs set consumers need to adopt.

### Added

- **Node API barrel** at `plugins/dotclaude/src/index.mjs` — 24+ named exports
  covering every validator + `ValidationError` + `EXIT_CODES` + `version`.
- **Structured error taxonomy** (`plugins/dotclaude/src/lib/errors.mjs`): every
  validator emits `ValidationError` instances with stable `.code`, `.file`,
  `.pointer`, `.expected`, `.got`, `.hint`, `.category`. Enumerated codes
  (`SPEC_STATUS_INVALID`, `MANIFEST_CHECKSUM_MISMATCH`,
  `COVERAGE_UNCOVERED`, `DRIFT_TEAM_COUNT`, …) are a stable contract —
  renames are breaking.
- **Named `EXIT_CODES`** (`{OK:0, VALIDATION:1, ENV:2, USAGE:64}`) consumed
  by every bin. `64` mirrors BSD `sysexits.h EX_USAGE`.
- **Umbrella `dotclaude` CLI** that dispatches to subcommands:
  `harness validate-specs|validate-skills|check-spec-coverage|check-instruction-drift|detect-drift|doctor|init`.
  Every bin also exists as a standalone — `dotclaude-doctor`, `dotclaude-init`,
  etc.
- **`dotclaude-doctor`** — runs through env, repo, facts, manifest, specs,
  drift, and hook checks and reports `✓/✗/⚠` with exit 0/1/2.
- **`dotclaude-detect-drift`** — wraps `plugins/dotclaude/scripts/detect-branch-drift.mjs`
  so `npx dotclaude-detect-drift` resolves. Fixes the broken
  `plugins/dotclaude/templates/workflows/detect-drift.yml:15` invocation.
- **Universal CLI flags** across every bin: `--help`, `--version`, `--json`,
  `--verbose`, `--no-color`, plus bin-specific flags (`--update`,
  `--project-name`, `--force`, `--target-dir`, …).
- **`--json` output** on every bin and on `validate-settings.sh`, suitable
  for `jq -r '.events[] | …'` CI pipelines.
- **`set -euo pipefail`** across every shipped shell script; ✓/✗/⚠ helpers
  factored into `plugins/dotclaude/scripts/lib/output.sh` and mirrored in
  `src/lib/output.mjs`.
- **Hardened `guard-destructive-git.sh`** — normalizes tab whitespace,
  boundary-anchors `git` tokens, adds blocks for `git branch -D` and
  `git worktree remove --force`, and exposes `BYPASS_DESTRUCTIVE_GIT=1`
  bypass. Exit 2 preserved per Claude Code PreToolUse protocol.
- **`bootstrap.sh --quiet` + `--help`** plus a trailing
  `run 'dotclaude-doctor' to verify install` hint when the bin is on PATH.
- **`sync.sh` secret scan** — literal `_KEY` / `_TOKEN` / `_SECRET` + AWS
  keys + bearer tokens are refused at push time.
  `HARNESS_SYNC_SKIP_SECRET_SCAN=1` is the documented escape hatch.
- **bats suite** at `plugins/dotclaude/tests/bats/` (34 tests) covering every
  hardened shell surface.
- **Coverage gate** — `vitest run --coverage` enforces lines 85 /
  functions 85 / branches 80 / statements 85 via `vitest.config.mjs`.
- **`examples/minimal-consumer/`** — committed post-`dotclaude-init` scaffold.
- **Dogfood**: root `.claude/{settings,skills-manifest}.json`,
  `docs/repo-facts.json`, `docs/specs/dotclaude-core/{spec.json,spec.md}`.
  Every validator exits 0 against the root (see `npm run dogfood`).
- **Docs set**: `LICENSE`, `CHANGELOG.md` (this file), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `docs/{index,quickstart,cli-reference,api-reference,architecture,personas,troubleshooting,upgrade-guide}.md`,
  `docs/adr/`, `plugins/dotclaude/templates/README.md`. README.md and
  `plugins/dotclaude/README.md` rewritten for consumer clarity.
- **Commands** (`.claude/commands/*.md`) get YAML frontmatter matching the
  `skills/*/SKILL.md` schema.

### Changed

- **Public surface** — deep imports from `plugins/dotclaude/src/*.mjs` are no
  longer a supported contract. Use the barrel import.
- **`package.json`** — `"main"` now points at the real barrel; `"exports"`
  field added; three new `"bin"` entries; `"files"` covers
  `plugins/dotclaude/scripts/` so `refresh-worktrees.sh`,
  `detect-branch-drift.mjs`, and `auto-update-manifest.mjs` ship in the
  tarball; version bumped to `0.2.0`.

### Breaking changes (for early adopters of 0.1.x)

- Validator errors are `ValidationError` instances, not strings. Existing
  CI pipelines that `grep` stderr continue to work because
  `ValidationError.prototype.toString()` preserves the
  `"<file>: <message>"` format; pipelines that consume `--json` get the
  structured payload.
- Deep imports (`import { … } from "@dotclaude/dotclaude/src/validate-specs.mjs"`)
  are no longer a supported contract — use the barrel.

## [0.1.0] — 2026-04-13

Retroactive entry. Initial plugin skeleton: spec-harness library, five
validators, template tree, hook, and `test_validate_settings.sh`. Never
published to npm — the first published version is 0.2.0.
