# Plan — Raise `@kaiohenricunha/dotclaude` (dotclaude) from 6.5/10 to 10/10

## Context

The repo at `/mnt/storage/Projects/kaiohenricunha/dotclaude` is graded **6.5/10 — Passable** by `docs/assessments/claude-config-management-2026-04-14.md`. It is a dual-purpose repository: a portable npm package + Claude Code plugin (`@kaiohenricunha/dotclaude`) that bootstraps spec-driven-development governance into consumer repos, _and_ Kaio's personal global Claude Code dotfiles symlinked into `~/.claude/` via `bootstrap.sh`. The code layer is solid (quality 7.8, tests 7.2, security 7.2) but productization is weak: `package.json:6` `"main"` points at a non-existent `plugins/dotclaude/src/index.mjs`; both READMEs advertise a broken Node API import with _different_ wrong paths; there is no `.github/workflows/` at root so the library publishes CI templates to consumers but runs zero CI on itself; `LICENSE`, `CHANGELOG`, `CONTRIBUTING`, `SECURITY.md` are missing; hardening decisions are crammed into a README table with no ADR context; `commands/*.md` lack the YAML frontmatter that `skills/*/SKILL.md` already uses; the repo ships a contract it does not itself follow (no root `docs/repo-facts.json`, no `.claude/skills-manifest.json`); every CLI's exit codes are inconsistent and no CLI supports `--json` / `--verbose` / `--help` / `--version`; the shipped `plugins/dotclaude/templates/workflows/detect-drift.yml:15` invokes a non-existent `npx @kaiohenricunha/dotclaude detect-drift` subcommand.

**Intended outcome.** Deliver a single coherent effort, split across seven reviewable PRs, that takes every rubric dimension to 9–10. The repo ends up publishing to the public npm registry with `--provenance` on tag-push, dogfooding its own validators in CI on every push, carrying an ADR record for every hardening decision, documenting every CLI + Node API entry, and exposing a structured-error + `--json` contract every consumer CI pipeline can parse. A first-time consumer reaches "first green validator run" inside 10 minutes via `docs/quickstart.md`.

**User-confirmed scope decisions.** (1) Publish to public npm with provenance via a release workflow triggered by `v*.*.*` tag. (2) Roll out as **seven phased PRs**, one per workstream cluster, so CI stays green between landings. (3) **Full dogfood**: add `.claude/skills-manifest.json` + `docs/repo-facts.json` + `docs/specs/dotclaude-core/{spec.json,spec.md}` at repo root, plus a `dogfood.yml` CI job that runs every harness bin against the root and against `examples/minimal-consumer/`.

## Target state at a glance

```
dotclaude/
├─ README.md                 (EDIT: full rewrite — persona split, working imports, link to docs/)
├─ CLAUDE.md                 (EDIT: persona header; move contributor rules → CONTRIBUTING.md)
├─ LICENSE                   (NEW: MIT full text, holder "Kaio Henrique Cunha", 2026)
├─ CHANGELOG.md              (NEW: Keep-a-Changelog; retroactive 0.1.0 + 0.2.0)
├─ CONTRIBUTING.md           (NEW)
├─ CODE_OF_CONDUCT.md        (NEW: Contributor Covenant 2.1)
├─ SECURITY.md               (NEW: disclosure policy + symlink/hook/workflow threat model)
├─ package.json              (EDIT: main→real index.mjs, add "exports", 3 new bins, "0.2.0", scripts)
├─ bootstrap.sh, sync.sh     (EDIT: --quiet flag; secret-scan in sync pre-stage)
├─ .prettierrc.json / .editorconfig / .shellcheckrc / .markdownlint-cli2.jsonc   (all NEW)
├─ vitest.config.mjs         (NEW: 85% coverage thresholds)
│
├─ .claude/                  (NEW — dogfood)
│  ├─ skills-manifest.json   (indexes commands/*.md + skills/*/SKILL.md + plugins/dotclaude/commands/init-harness.md)
│  ├─ settings.json          (minimal: wires guard-destructive-git hook)
│  └─ hooks/guard-destructive-git.sh   (symlink to plugins/dotclaude/hooks/)
│
├─ docs/                     (NEW subtree + existing docs/assessments/ kept)
│  ├─ index.md  quickstart.md  architecture.md  cli-reference.md
│  ├─ api-reference.md  troubleshooting.md  upgrade-guide.md  personas.md
│  ├─ repo-facts.json        (dogfood)
│  ├─ specs/
│  │  ├─ README.md
│  │  └─ dotclaude-core/{spec.json, spec.md}   (status: done; linked_paths cover the full plugin)
│  ├─ adr/
│  │  ├─ README.md + 0001..0014 ADRs   (monorepo layout, no-TS, SEC-1..4, OPS-1..2, lsp-ownership,
│  │  │                                  context7-global, project-bound-mcps, structured-errors,
│  │  │                                  exit-code convention, ✓/✗/⚠ CLI format)
│  └─ api/generated/         (gitignored; output of scripts/generate-api-reference.mjs)
│
├─ examples/minimal-consumer/   (NEW — committed post-dotclaude-init scaffold; source for dogfood.yml)
│
├─ .github/                  (ALL NEW at repo root)
│  ├─ CODEOWNERS  dependabot.yml  PULL_REQUEST_TEMPLATE.md
│  ├─ ISSUE_TEMPLATE/{bug_report.yml, feature_request.yml, config.yml}
│  └─ workflows/{test, lint, dogfood, links, codeql, docs, release}.yml
│
├─ commands/*.md             (EDIT all 12: prepend YAML frontmatter matching skills' schema)
├─ skills/                   (unchanged — already has frontmatter)
│
├─ scripts/                  (NEW repo-root helpers used by CI)
│  ├─ check-jsdoc-coverage.mjs
│  └─ generate-api-reference.mjs
│
└─ plugins/dotclaude/
   ├─ README.md              (EDIT: slim to npm-tarball README; point to root docs/)
   ├─ .claude-plugin/plugin.json  (EDIT: version, license, homepage, repository)
   ├─ src/
   │  ├─ index.mjs           (NEW — barrel; re-exports 24 symbols + version + ValidationError + EXIT_CODES)
   │  ├─ lib/                (NEW directory)
   │  │  ├─ errors.mjs       ValidationError + formatError + StructuredError @typedef taxonomy
   │  │  ├─ exit-codes.mjs   EXIT_OK=0, EXIT_VALIDATION=1, EXIT_ENV=2, EXIT_USAGE=64
   │  │  ├─ output.mjs       ✓/✗/⚠ printer, --json buffer-and-flush, --no-color, NO_COLOR env
   │  │  ├─ argv.mjs         parseArgs(argv, spec) → {flags, positional, help?, version?}
   │  │  └─ debug.mjs        DOTCLAUDE_DEBUG=1 gate (replaces silent catches)
   │  ├─ spec-harness-lib.mjs             (EDIT: JSDoc all 18 exports; replace silent catches at :28-29 + :184-186)
   │  ├─ validate-specs.mjs               (EDIT: emit StructuredError instead of string)
   │  ├─ validate-skills-inventory.mjs    (EDIT: same)
   │  ├─ check-spec-coverage.mjs          (EDIT: same)
   │  ├─ check-instruction-drift.mjs      (EDIT: same)
   │  └─ init-harness-scaffold.mjs        (EDIT: same)
   ├─ bin/
   │  ├─ harness.mjs                      (NEW — umbrella dispatcher; owns --version / --help)
   │  ├─ dotclaude-doctor.mjs               (NEW — env + manifest + specs + facts + drift + hook check)
   │  ├─ dotclaude-detect-drift.mjs         (NEW — wraps scripts/detect-branch-drift.mjs; fixes detect-drift.yml)
   │  └─ harness-{validate-skills, validate-specs, check-spec-coverage,
   │             check-instruction-drift, init}.mjs           (EDIT all: use lib/*; +--json/--verbose/--help/--version)
   ├─ scripts/
   │  ├─ validate-settings.sh             (EDIT: set -euo pipefail; source lib/output.sh; +--json)
   │  ├─ lib/output.sh                    (NEW — shared ✓/✗/⚠ helpers)
   │  ├─ refresh-worktrees.sh             (EDIT: +--dry-run; shipped in npm files)
   │  ├─ detect-branch-drift.mjs          (EDIT: use EXIT_CODES; +--json)
   │  └─ auto-update-manifest.mjs         (EDIT: forward --verbose)
   ├─ hooks/guard-destructive-git.sh      (EDIT: hardened regex; BYPASS_DESTRUCTIVE_GIT=1; bypass hint in block msg)
   ├─ templates/
   │  ├─ README.md                        (NEW — placeholder catalog + per-template rationale)
   │  ├─ workflows/detect-drift.yml       (EDIT: call `npx dotclaude-detect-drift`; Node 20+22 matrix)
   │  ├─ workflows/validate-skills.yml    (EDIT: add --json + matrix)
   │  ├─ githooks/pre-commit              (EDIT: secret-scan step)
   │  └─ claude/hooks/guard-destructive-git.sh   (EDIT: mirror hardening)
   └─ tests/
      ├─ bats/ {bootstrap, sync, refresh-worktrees, guard-destructive-git}.bats + helpers.bash  (all NEW)
      ├─ detect-branch-drift.test.mjs  auto-update-manifest.test.mjs           (NEW)
      ├─ errors.test.mjs  output.test.mjs  argv.test.mjs  dotclaude-doctor.test.mjs  index.test.mjs   (NEW)
      ├─ integration/end-to-end-scaffold.test.mjs                              (NEW)
      ├─ test_validate_settings.sh       (EDIT: +4 cases: set-e propagation, --json, OPS-1 hook-missing, tag formatting)
      └─ [unchanged existing tests]
```

## Phased rollout (7 PRs)

Each PR lands with CI green. Later PRs depend on earlier ones; order is strict.

**PR 1 — Foundation libs.** Create `plugins/dotclaude/src/lib/{errors,exit-codes,output,argv,debug}.mjs` + unit tests (`errors.test.mjs`, `output.test.mjs`, `argv.test.mjs`). No behavior change yet. Establishes the `StructuredError` taxonomy (codes like `SPEC_STATUS_INVALID`, `MANIFEST_CHECKSUM_MISMATCH`, `COVERAGE_UNCOVERED`, `DRIFT_TEAM_COUNT`, `SETTINGS_SEC_1..4`) and the named exit-code enum. `output.mjs` mirrors the ✓/✗/⚠ format at `plugins/dotclaude/scripts/validate-settings.sh:43-45` — that file is the house gold standard; reuse it verbatim.

**PR 2 — Barrel + umbrella CLI + package contract fixes.** Create `plugins/dotclaude/src/index.mjs` re-exporting the 24-symbol public API (18 from `spec-harness-lib.mjs` + `validateSpecs`, `validateManifest`, `refreshChecksums`, `checkSpecCoverage`, `checkInstructionDrift`, `scaffoldHarness`, plus `version` / `ValidationError` / `EXIT_CODES`). Add `plugins/dotclaude/bin/{harness, dotclaude-doctor, dotclaude-detect-drift}.mjs`. Edit `package.json`: valid `"main"`, new `"exports"` field (`"."`, `"./errors"`, `"./exit-codes"`, `"./package.json"`), add three new `"bin"` entries, add `"homepage"`, `"bugs"`, `"keywords"`, bump `"version": "0.2.0"`, add `"scripts"` (`lint`, `shellcheck`, `coverage`, `docs:links`, `dogfood`, `format:check`). Add `plugins/dotclaude/scripts/` to `"files"` so `refresh-worktrees.sh` + `detect-branch-drift.mjs` + `auto-update-manifest.mjs` actually ship (currently advertised at `README.md:77-80` but excluded from `package.json:18-25`). Edit `plugins/dotclaude/templates/workflows/detect-drift.yml:15` to `npx dotclaude-detect-drift`. Edit both READMEs' import blocks (`README.md:67-72` and `plugins/dotclaude/README.md:38-39`) to the single barrel form. Add `index.test.mjs` asserting 24 named exports.

**PR 3 — Adopt structured errors across validators.** Edit all six `src/*.mjs` modules to push `StructuredError` objects rather than strings. Every current error line gets a `code`, `file`, optional `pointer` / `line`, `expected`, `got`, `hint`, `category`. The enumerated rewrites: `validate-specs.mjs:47,55,61,66,71,76,85,87,96,98,103,108,125`; `validate-skills-inventory.mjs:49,54,61,73`; `check-instruction-drift.mjs:32,42,53,59,74,90`; `check-spec-coverage.mjs:43,50,55`; `init-harness-scaffold.mjs` conflict + usage messages. Update the six existing test files to assert on `.code` + `.message` (backwards-compat `toString()` on `ValidationError`). Add JSDoc `@param`/`@returns`/`@typedef HarnessContext` / `@typedef ValidationResult` to every export in `spec-harness-lib.mjs`. Replace the silent catches at `spec-harness-lib.mjs:28-29` (`resolveRepoRootFromGit`) and `:184-186` (`getChangedFiles`) with `debug("git:rev-parse", err.message)` etc. Rewrite every bin to use `lib/{argv, output, errors, exit-codes}` and add `--help`, `--version`, `--json`, `--verbose`, `--no-color`. Normalize exits per the convention (0/1/2/64). `dotclaude-init.mjs:25,33,62` switch to the named constants.

**PR 4 — Shell upgrades + bats suite.** Change `plugins/dotclaude/scripts/validate-settings.sh:26` from `set -u` to `set -euo pipefail`. Factor the ✓/✗/⚠ helpers at `:43-45` into `plugins/dotclaude/scripts/lib/output.sh` and `source` them; same file adds a `--json` mode emitting `{check, category, status, message}`. Harden `plugins/dotclaude/hooks/guard-destructive-git.sh:16`: normalize tabs → single space, match on `(^|[[:space:]]|[;&|])git[[:space:]]+` plus each destructive verb; add `BYPASS_DESTRUCTIVE_GIT=1` env bypass; rewrite block message to show the bypass form. **Preserve the existing `exit 2` semantics** — that is Claude Code's hook protocol (exit 2 blocks the tool call), not the validator exit convention. Mirror the hardening into `plugins/dotclaude/templates/claude/hooks/guard-destructive-git.sh`. Edit `bootstrap.sh` to add a `--quiet` flag and a trailing `"run harness doctor to verify install"` line when `dotclaude-doctor` is on PATH. Edit `sync.sh:15` to run a secret-scan before `git add -A`. Add bats-core suite under `plugins/dotclaude/tests/bats/`: `bootstrap.bats` (first-run, idempotency, real-file backup, broken symlink repair, stale target update), `sync.bats` (pull/push/status with fake-git shim; secret-scan abort), `refresh-worktrees.bats` (dirty skip, FF-merge, conflict reporting), `guard-destructive-git.bats` (every blocked pattern, tab/space variants, bypass env, harmless `git reset --soft` allowed). Add `.shellcheckrc`, `.prettierrc.json`, `.editorconfig`, `.markdownlint-cli2.jsonc`. Extend `plugins/dotclaude/tests/test_validate_settings.sh` from 8 to 12 cases.

**PR 5 — Dogfood + integration + missing script tests.** Create root `.claude/skills-manifest.json` inventorying every file under `commands/`, `skills/*/SKILL.md`, and `plugins/dotclaude/commands/init-harness.md`; `.claude/settings.json` wiring the guard hook; `.claude/hooks/guard-destructive-git.sh` symlinked to `plugins/dotclaude/hooks/`. Create root `docs/repo-facts.json` with `team_count: 1`, protected_paths covering `CLAUDE.md`, `README.md`, `.github/workflows/**`, `.claude/**`, `docs/repo-facts.json`, `docs/specs/**/spec.json`, `plugins/dotclaude/src/**`, `plugins/dotclaude/bin/**`, `plugins/dotclaude/templates/**`. Create `docs/specs/dotclaude-core/{spec.json,spec.md}` with `status: done`, full `linked_paths` and `acceptance_commands: ["npm test", "npx dotclaude-doctor", "node -e 'import(\"@kaiohenricunha/dotclaude\").then(m => process.exit(Object.keys(m).length >= 24 ? 0 : 1))'"]`. Create `docs/specs/README.md` framed for this repo (reuse the template at `plugins/dotclaude/templates/docs/specs/README.md`). Add the missing `plugins/dotclaude/tests/{detect-branch-drift,auto-update-manifest}.test.mjs`. Add `plugins/dotclaude/tests/integration/end-to-end-scaffold.test.mjs` that `git init`s a tmpdir, runs `dotclaude-init`, then runs each validator sequentially and asserts exit 0. Create `examples/minimal-consumer/` by running `dotclaude-init` into it and committing the output. Add `vitest.config.mjs` with `coverage.thresholds: {lines: 85, functions: 85, branches: 80, statements: 85}`.

**PR 6 — Docs workstream (the priority).** Create in this order so later files cite earlier ones:

- `LICENSE` (MIT full text).
- `CHANGELOG.md` — Keep-a-Changelog; `[0.1.0] - 2026-04-13` retroactive; `[0.2.0] - <ship date>` enumerating every change from this plan (barrel export, structured errors, named exit codes, `--json`/`--verbose`/`--help`/`--version`/`--no-color`, `harness doctor`, `dotclaude-detect-drift`, umbrella `dotclaude` bin, bats suite, full CI, Dependabot, CodeQL, release automation with provenance, ADRs, LICENSE, all docs); call out as breaking for consumers parsing validator stderr.
- `CONTRIBUTING.md` — clone → bootstrap → test (`npm test && bash plugins/dotclaude/tests/test_validate_settings.sh && bats plugins/dotclaude/tests/bats/`); spec-before-code discipline pointing at `docs/specs/dotclaude-core/`; commit + PR conventions; worktree discipline lifted from current `CLAUDE.md:48-52`.
- `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1.
- `SECURITY.md` — supported versions, private disclosure workflow, 90-day window; three threat-model subsections: (a) bootstrap symlink trust (cite `bootstrap.sh:19-36`), (b) guard-destructive-git defense-in-depth (cite `hooks/guard-destructive-git.sh:16`, explain alias bypass), (c) workflow secret handling (cite `templates/workflows/ai-review.yml:19` same-repo PR gating); supply chain: npm provenance + zero runtime deps + 2FA on publisher account.
- `docs/adr/README.md` + 14 ADRs (`0001-monorepo-dual-persona-layout`, `0002-no-typescript`, `0003-sec1-no-secret-literals`, `0004-sec2-no-skip-dangerous-mode`, `0005-sec3-no-at-latest-in-mcp-args`, `0006-sec4-credentials-mode-600`, `0007-ops1-hooks-block-minimal`, `0008-ops2-age-based-retention`, `0009-lsp-plugins-owned-by-claude-code-lsps`, `0010-context7-runs-globally`, `0011-project-bound-mcps-live-in-project`, `0012-structured-error-contract`, `0013-exit-code-convention`, `0014-cli-ui-tick-cross-warn-format`). Each: Status / Context / Decision / Consequences / Alternatives. Every SEC/OPS ADR cites the enforcement line in `plugins/dotclaude/scripts/validate-settings.sh`.
- `docs/index.md` (nav map), `docs/quickstart.md` (5-minute install → scaffold → validate), `docs/architecture.md` (ASCII layer diagram + data-flow sequence for PR-time `checkSpecCoverage` using `getPullRequestContext` at `spec-harness-lib.mjs:160-166`), `docs/cli-reference.md` (one H2 per bin: synopsis, flag table, exit codes, examples, `--json` schema, env vars), `docs/api-reference.md` (narrative + per-symbol generated), `docs/troubleshooting.md` (one H3 per `StructuredError.code`, mirroring the `hint` field), `docs/upgrade-guide.md` (three scenarios: hand-written `.claude/` migration; 0.1.0 → 0.2.0 breaking changes; forking the dotfiles), `docs/personas.md` (consumer vs dotfile user vs contributor entry-point matrix).
- `plugins/dotclaude/templates/README.md` — placeholder catalog (`{{project_name}}`, `{{project_type}}`, `{{today}}` cite `init-harness-scaffold.mjs:21-27` + `init-harness-scaffold.test.mjs:116-129`) + per-template rationale.
- `README.md` — full rewrite, ≤180 lines, persona-split quickstart, working import block using the barrel, hardening decisions table where each row links to its ADR, dead `README.md:129` line deleted, further-reading table linking docs/.
- `plugins/dotclaude/README.md` — slimmed to npm-tarball-only, ≤80 lines, pointer back to root docs/.
- `CLAUDE.md` — prepend a persona header marking it as the global rule floor for Kaio's environment (consumers do NOT inherit); move `CLAUDE.md:48-52` worktree rules to CONTRIBUTING.md keeping a one-line pointer.
- Prepend YAML frontmatter (`name:`, `description:`, `argument-hint:`) to every file under `commands/*.md` (12 files) so they match the `skills/spec/SKILL.md:1-11` schema.
- Add `scripts/generate-api-reference.mjs` (tiny regex-based JSDoc → markdown pass; no new runtime deps — deliberate trade-off to keep the zero-runtime-deps guarantee).
- Add `scripts/check-jsdoc-coverage.mjs` (fail if any `export` lacks a preceding `/** */`).
- Run `lychee docs/ **/*.md` locally to confirm no dead links before PR lands.

**PR 7 — CI + release.** Create `.github/CODEOWNERS`, `.github/dependabot.yml` (weekly npm + github-actions ecosystems; inspect `plugins/dotclaude/templates/workflows/` too so consumers get SHA refreshes), `.github/PULL_REQUEST_TEMPLATE.md` (enforces Spec ID / `## No-spec rationale` per `check-spec-coverage.mjs:42-44`), `.github/ISSUE_TEMPLATE/{bug_report.yml, feature_request.yml, config.yml}`. Add workflows in dependency order:

- `test.yml` — matrix `{node: [20, 22]}` × ubuntu-latest; `npm ci`, `npm test -- --coverage`, `bash plugins/dotclaude/tests/test_validate_settings.sh`, `bats plugins/dotclaude/tests/bats/`; upload coverage artifact.
- `lint.yml` — `prettier --check`, `shellcheck`, `markdownlint-cli2`, `node scripts/check-jsdoc-coverage.mjs`.
- `codeql.yml` — javascript + shell analyzers; push/pr/weekly.
- `links.yml` — lychee on `docs/**` + `*.md`; schedule weekly + PR when `**/*.md` changes.
- `dogfood.yml` — two jobs: `self` runs every harness bin against the root; `example` runs against `examples/minimal-consumer/`.
- `docs.yml` — on PRs touching `plugins/dotclaude/src/**.mjs`: regenerate `docs/api-reference.md` via `scripts/generate-api-reference.mjs`; fail PR if disk ≠ regenerated.
- `release.yml` — triggered by tag `v*.*.*`; `id-token: write` permission; `npm ci && npm test && npm publish --provenance --access public`; fail if `package.json` version ≠ tag; `gh release create` with body extracted from the matching CHANGELOG section.

Pin every action by commit SHA, mirroring `plugins/dotclaude/templates/workflows/validate-skills.yml:19-20`. After all workflows are green on a dry-run PR, finalize CHANGELOG, tag `v0.2.0`, push → `release.yml` publishes.

## Critical files

- `plugins/dotclaude/src/index.mjs` (NEW — barrel of 24 public symbols; fixes `package.json:6`)
- `plugins/dotclaude/src/lib/errors.mjs` (NEW — StructuredError taxonomy; adopted by all six validators)
- `plugins/dotclaude/src/lib/output.mjs` (NEW — mirrors `plugins/dotclaude/scripts/validate-settings.sh:43-45` ✓/✗/⚠ format with `--json` + `--no-color`)
- `plugins/dotclaude/src/lib/exit-codes.mjs` (NEW — `{OK:0, VALIDATION:1, ENV:2, USAGE:64}`)
- `plugins/dotclaude/src/spec-harness-lib.mjs` (EDIT — JSDoc all 18 exports; replace silent catches at :28-29 + :184-186 with `debug()`)
- `plugins/dotclaude/bin/harness.mjs`, `dotclaude-doctor.mjs`, `dotclaude-detect-drift.mjs` (NEW bins)
- `package.json` (EDIT — main, exports, bin × 3, scripts × 6, files += scripts/, version bump)
- `plugins/dotclaude/scripts/validate-settings.sh` (EDIT — `set -u` → `set -euo pipefail` at :26; source shared `lib/output.sh`)
- `plugins/dotclaude/hooks/guard-destructive-git.sh` (EDIT — harden regex at :16; add bypass; **preserve `exit 2` per Claude Code hook protocol**)
- `plugins/dotclaude/templates/workflows/detect-drift.yml` (EDIT — fix :15 to `npx dotclaude-detect-drift`)
- `README.md` (EDIT — full rewrite; fix broken import block at :67-72; delete dead-link line at :129)
- `plugins/dotclaude/README.md` (EDIT — slim; single barrel import)
- `CLAUDE.md` (EDIT — persona header; relocate contributor rules)

## Reuse map (existing helpers to build on — do not reinvent)

- **`createHarnessContext` at `plugins/dotclaude/src/spec-harness-lib.mjs:5-21`** — every new bin (`dotclaude-doctor`, umbrella `dotclaude`) resolves repo root through this, preserving the three-step fallback (arg → `DOTCLAUDE_REPO_ROOT` → `git rev-parse`).
- **`readJson` / `readText` / `pathExists` / `git` / `loadFacts` / `listSpecDirs` / `listRepoPaths` / `toPosix`** (`spec-harness-lib.mjs:33-98`) — `dotclaude-doctor` and the end-to-end integration test reuse these verbatim; no new filesystem helpers.
- **`getPullRequestContext` + `isBotActor` + `getChangedFiles`** (`spec-harness-lib.mjs:160-187`) — dogfood's `check-spec-coverage` run on the root must use these (they already handle `GITHUB_BASE_REF`, `HARNESS_CHANGED_FILES`, bot-actor detection).
- **PREFIX_MAP + substitutePlaceholders** at `plugins/dotclaude/src/init-harness-scaffold.mjs:5-9,21-27` — the `plugins/dotclaude/templates/README.md` placeholder catalog cites these as the canonical substitution site; no behavior change to the scaffolder itself.
- **Gold-standard shell UI** at `plugins/dotclaude/scripts/validate-settings.sh:43-45` — `plugins/dotclaude/src/lib/output.mjs` and `plugins/dotclaude/scripts/lib/output.sh` both reproduce the exact `pass()`/`fail()`/`warn()` prefix format (✓/✗/⚠ + ANSI gate on `-t 1`).
- **SHA-pinning convention** at `plugins/dotclaude/templates/workflows/validate-skills.yml:19-20` and `ai-review.yml:21` — every new `.github/workflows/*.yml` follows the same commit-SHA pinning.
- **Fixture helper pattern** at `plugins/dotclaude/tests/validate-specs.test.mjs:12-16` (`mkdtempSync` + `cpSync`) — all new hermetic tests use the same.
- **Existing JSDoc house style** at `plugins/dotclaude/src/validate-specs.mjs:17-33` + `check-instruction-drift.mjs:7-24` — the JSDoc rollout across `spec-harness-lib.mjs` matches this voice and `@param`/`@returns` shape.
- **In-repo doc-generation skills** — `/create-audit` (`commands/create-audit.md`), `/create-assessment` (`commands/create-assessment.md`), `/spec` (`skills/spec/SKILL.md`), `/validate-spec` (`skills/validate-spec/SKILL.md`) are the authoring path for every ADR, audit, assessment. Do not bypass them when writing `docs/adr/*`.

## Verification plan (dimension → runnable signal)

Each rubric dimension hits 9–10 only when its named signal goes green.

- **Architecture (target ≥9).** `node -e 'import("@kaiohenricunha/dotclaude").then(m => process.exit(Object.keys(m).length >= 24 ? 0 : 1))'` exits 0. `grep -R "plugins/dotclaude/src" README.md plugins/dotclaude/README.md` returns nothing. `npx dotclaude-detect-drift --help` prints flags. Dogfood: root `npx dotclaude-validate-skills && npx dotclaude-validate-specs && npx dotclaude-check-instruction-drift && npx dotclaude-check-spec-coverage` all exit 0.
- **Code quality (≥9).** `npm run lint` (prettier) green. `shellcheck -x bootstrap.sh sync.sh plugins/dotclaude/scripts/*.sh plugins/dotclaude/hooks/*.sh plugins/dotclaude/tests/*.sh plugins/dotclaude/templates/claude/hooks/*.sh plugins/dotclaude/templates/githooks/pre-commit` green. `node scripts/check-jsdoc-coverage.mjs plugins/dotclaude/src` green. `markdownlint-cli2 "**/*.md" "#node_modules"` green.
- **Test coverage (≥9).** `npm test -- --coverage` meets all four thresholds. `bats plugins/dotclaude/tests/bats/` all pass. `bash plugins/dotclaude/tests/test_validate_settings.sh` reports 12/12. `plugins/dotclaude/tests/integration/end-to-end-scaffold.test.mjs` green. `test.yml` green on Node 20 + 22.
- **CI/CD (≥9).** All seven workflows green on a representative PR. `dogfood.yml` green against both root and `examples/minimal-consumer/`. `release.yml` successfully publishes `v0.2.0` with `npm view @kaiohenricunha/dotclaude@0.2.0` showing provenance. First Dependabot PR arrives within a week.
- **Documentation (≥9).** `npx lychee docs/ **/*.md` reports zero dead links. `links.yml` green. Quickstart walkthrough ≤10 minutes against a fresh tmpdir (manual signoff). Every ADR cites ≥1 `file:line` from plugin source. `docs.yml` green (generated api-reference matches committed).
- **Security (≥9).** `.github/dependabot.yml` active, first PRs landing. `codeql.yml` green. `bats guard-destructive-git.bats` green (≥12 cases including bypass). `npm publish --provenance` recorded (visible in the npmjs.com provenance UI). `SECURITY.md` linked from README. Repo settings (secret scanning, push protection, private vuln reporting, Dependabot security updates) toggled per SECURITY.md contributor-setup section.
- **Observability (≥9).** Every bin's `--help`, `--version`, `--json`, `--verbose`, `--no-color` works; exit codes follow `{0,1,2,64}` (asserted in integration test). `npx dotclaude doctor` runs in `dogfood.yml` and reports every check green. `bats guard-destructive-git.bats` asserts block message contains `BYPASS_DESTRUCTIVE_GIT=1`. `validate-settings.sh --json` returns valid JSON (asserted in `test_validate_settings.sh` case #12).

Combined with the rubric weights (arch 0.20, code 0.15, tests 0.15, CI 0.10, docs 0.10, security 0.15, observability 0.15), this lifts the overall score from 6.5 to ≥9.4 — comfortably in the Excellent band.

## Out of scope (explicit)

- TypeScript migration — captured in ADR-0002; revisit at v0.3 if `.d.ts` consumer demand surfaces (mitigation: hand-write `plugins/dotclaude/src/index.d.ts` later).
- Docs site (VitePress / Docusaurus / Starlight) — markdown under `docs/` is sufficient; GitHub renders it.
- i18n / localization of docs.
- Node ≤ 18 support — `engines.node: ">=20"` stays; matrix tail is 22.
- Multi-plugin workspace split under `plugins/` — directory anticipates siblings but keep single root `package.json` until a second plugin materializes.
- Windows / PowerShell shell support. All shell is bash-first; CI runs ubuntu-latest only.
- Splitting personal dotfiles into a separate repo — dual-persona layout is load-bearing; preserved in ADR-0001.
- Publishing the plugin to the Claude Code plugin marketplace — separate submission flow; leave as `[Unreleased]` TODO in CHANGELOG.
- A `harness upgrade` subcommand — upgrade guidance lives in `docs/upgrade-guide.md`; automation can come at v0.3+.
- Migrating `ValidationError` to a Zod schema / tagged union — plain class with `@typedef` is sufficient.
