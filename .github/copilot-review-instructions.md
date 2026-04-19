# Copilot PR review instructions for `@dotclaude/dotclaude`

> Paste the body of this file into **Repo Settings → Code & automation →
> Copilot → Code review → Custom instructions** so the GitHub Copilot PR
> reviewer picks it up. This in-repo copy is the versioned source of truth.
> For general session context (build/test/architecture) see
> [`copilot-instructions.md`](./copilot-instructions.md).

## Review priorities (in order)

1. **Correctness over style.** This repo is dogfooded — a wrong validator
   silently breaks consumer CI. Skip nits about wording/whitespace.
2. **Contract violations** in the bin/library surface.
3. **Repo-specific invariants** (listed below).
4. **Test coverage gaps** for the changed behavior.
5. Everything else.

Be terse. One comment per real issue. No "consider extracting…" suggestions
unless they prevent a bug.

## Things to flag (high-signal)

### Spec & governance invariants

- **Protected paths without spec coverage.** If the PR touches any path in
  `docs/repo-facts.json → protected_paths` (`CLAUDE.md`, `README.md`,
  `.github/workflows/**`, `.claude/**`, `docs/repo-facts.json`,
  `docs/specs/**/spec.json`, `plugins/dotclaude/{src,bin,templates}/**`)
  the PR body **must** contain either an H2 `## Spec ID` block (e.g.
  `Spec ID: dotclaude-core`) or `## No-spec rationale`. Flag if missing —
  this is what `dotclaude-check-spec-coverage` enforces and a missing
  block fails CI.
- **`spec.json status`** must be one of `draft | approved | implementing
| done`. Coverage only counts `approved | implementing | done`.
- **Drift between `CLAUDE.md` "Protected paths" and `docs/repo-facts.json`.**
  Every protected path in the JSON must appear in `CLAUDE.md`'s list and
  vice versa — `dotclaude-check-instruction-drift` enforces this.
- **Doc version stamps.** Every `docs/*.md` carries
  `_Last updated: vX.Y.Z_` matching `package.json → version`. If
  `version` was bumped, `npm run docs:stamp` must have been run. Flag any
  hand-edited stamp.

### CLI / library contract (`plugins/dotclaude/`)

- **New runtime dependency.** ADR-0002 aims to avoid adding new runtime
  deps. Adding anything to `dependencies` (not `devDependencies`) needs
  an explicit rationale in the PR body. Block if missing.
- **TypeScript / build step.** Plain Node 20+ ESM only, no bundler
  (ADR-0002). Block.
- **Bin without the standard pipeline.** Validator-style
  `plugins/dotclaude/bin/*.mjs` must use
  `parse(lib/argv) → validator → createOutput(lib/output) →
formatError(lib/errors) → exit(lib/exit-codes)`. Flag raw
  `console.log` / `process.exit(N)` / `throw new Error("string")` in
  validator bins. Exception: `dotclaude.mjs` (umbrella dispatcher) and
  `dotclaude-detect-drift.mjs` (thin wrapper) intentionally use
  `spawn` / `process.exit`.
- **Wrong exit code.** Bins must exit with the named `EXIT_CODES`:
  `OK=0`, `VALIDATION=1`, `ENV=2`, `USAGE=64`. Flag literal numbers other
  than these or misuse (e.g. exiting `1` for a usage error — should be
  `64`).
- **Missing CLI flags.** Non-wrapper bins must honor `--help`,
  `--version`, `--json`, `--verbose`, `--no-color`. For
  wrapper/dispatcher bins, it's acceptable to own only `--help` /
  `--version` if they transparently forward `--json`, `--verbose`, and
  `--no-color` to the delegated command. Flag bins that neither
  implement nor forward the standard flags correctly.
- **Unstructured errors.** Validator `errors.push(...)` must push a
  `ValidationError(code, …)` from `src/lib/errors.mjs`. New failure
  classes need a new entry in `ERROR_CODES`. Flag string-only errors.
- **Missing JSDoc on exports.** `scripts/check-jsdoc-coverage.mjs` fails
  CI on undocumented `export`s under `plugins/dotclaude/src/`. Flag any
  new export without JSDoc.
- **Direct `fs` / `child_process` in validators.** Filesystem and git
  primitives belong in `spec-harness-lib.mjs`. Validators should consume
  it, not reach for `node:fs` directly.
- **Cross-plugin import.** `plugins/dotclaude/` and `plugins/harness/`
  must not import from each other.

### Shell scripts

- Missing `set -euo pipefail` at the top of any new `.sh`.
- `zsh` shebang or `zsh`-specific syntax — bash only (`zsh` makes
  `$status` read-only, breaks scripts silently).
- Reserved variable names: `status`, `path`, `pwd`, `prompt`, `HISTFILE`.
- Direct `echo`/`printf` for status output instead of `pass` / `fail` /
  `warn` / `out_summary` from `plugins/dotclaude/scripts/lib/output.sh`.
- JSON output not gated behind `DOTCLAUDE_JSON=1`.
- Bats tests asserting on stderr without `2>&1` redirect — `run` only
  captures stdout, and handoff scripts deliberately print to stderr.

### Commands, skills, templates (shipped artifacts)

- Files under `commands/`, `skills/`, `schemas/`, `CLAUDE.md`,
  `plugins/dotclaude/{src,bin,scripts,templates,hooks}/`,
  `plugins/dotclaude/README.md`, and
  `plugins/dotclaude/.claude-plugin/` ship in the npm tarball
  (`package.json → files`). Treat changes here as user-visible API —
  flag breaking changes without a `CHANGELOG.md` entry.
- New `.claude/commands/*` file not added to `.claude/skills-manifest.json`
  → `validate-skills` will fail with `MANIFEST_ORPHAN_FILE`.
- Agent template under `plugins/dotclaude/templates/claude/agents/`
  missing YAML frontmatter (`name`, `description`, `tools`, `model`),
  using a `model` outside `opus | sonnet | haiku | inherit`, or — if its
  `name` matches auditor / reviewer / inspector — including `Write` or
  `Edit` in `tools`.
- Command markdown under `commands/` missing frontmatter (`name`,
  `description`, `argument-hint`).

### Tests

- New code path in `plugins/dotclaude/src/` without a corresponding
  `plugins/dotclaude/tests/*.test.mjs` covering it. Coverage thresholds
  are 85/85/80/85 (lines/functions/branches/statements) — flag changes
  that obviously push coverage below those.
- Test that imports a bin's `main()` without the import-safety guard
  (bins must only run `main()` when invoked directly, so they're
  importable by Vitest).
- New shell script without a `bats` or `test_*.sh` companion in
  `plugins/dotclaude/tests/`.

### PR hygiene

- Missing `## Summary` or `## Test plan` section in the PR body.
- Commit message not in conventional-commits form
  (`feat(scope): …`, `fix(scope): …`, `chore(scope): …`).
- `.env`, credentials, or API-key-shaped strings in the diff. Block.
- Force-push or `--amend` of a commit that's already in a published PR.

## Things NOT to flag

- Wording, whitespace, or import ordering — `prettier` /
  `markdownlint-cli2` handle these and are gated by `npm run lint`.
- Missing `.prettierignore` entries — `npm run lint` runs prettier with
  `--ignore-path .gitignore`, so `.prettierignore` is intentionally not
  consulted.
- Suggestions to migrate to TypeScript or add a build step — ADR-0002
  rejects both.
- Suggestions to add a runtime dep "for convenience".
- Style preferences inside `docs/specs/**` markdown bodies.
- "Consider adding a comment" — only flag missing JSDoc on exports.
