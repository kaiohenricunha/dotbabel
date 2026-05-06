# Contributing to `@dotbabel/dotbabel`

Thanks for considering a contribution. This repo is a dual-purpose checkout
— a portable npm package (`@dotbabel/dotbabel`) **and** Kaio's personal
global Claude Code config. Most contributions land in the former. See
`docs/personas.md` for the distinction.

## Quickstart

```bash
git clone https://github.com/kaiohenricunha/dotbabel.git
cd dotbabel
npm ci
./bootstrap.sh             # only if you also want the dotfiles in ~/.claude/
npm test                   # vitest: must be 90/90+ green
bash plugins/dotbabel/tests/test_validate_settings.sh
npx bats plugins/dotbabel/tests/bats/
npx dotbabel-doctor         # self-diagnostic
```

## Development workflow

1. **Start a worktree**, not a branch on the main checkout:
   ```bash
   git fetch origin main
   git worktree add .claude/worktrees/my-change -b feat/my-change origin/main
   cd .claude/worktrees/my-change
   ```
   This keeps multiple agents and humans from stomping on each other's
   working tree — enforced by `CLAUDE.md §Worktree discipline`.
2. **Write tests first.** Bug fixes land with a failing regression test that
   flips green in the same commit.
3. **Run the local gate** before `gh pr create`:
   ```bash
   npm test -- --coverage   # thresholds: 85/85/80/85
   npx bats plugins/dotbabel/tests/bats/
   bash plugins/dotbabel/tests/test_validate_settings.sh
   shellcheck --severity=warning -x bootstrap.sh sync.sh \
     plugins/dotbabel/scripts/*.sh plugins/dotbabel/scripts/lib/*.sh \
     plugins/dotbabel/hooks/*.sh plugins/dotbabel/tests/*.sh \
     plugins/dotbabel/templates/claude/hooks/*.sh \
     plugins/dotbabel/templates/githooks/pre-commit
   node scripts/check-jsdoc-coverage.mjs plugins/dotbabel/src
   npm run dogfood
   npm run docs:stamp-check   # verify docs/*.md version stamps match package.json
   ```
4. **Follow spec discipline.** Every PR touching a protected path (see
   `docs/repo-facts.json`) needs `Spec ID: dotbabel-core` or a
   `## No-spec rationale` section in its body. If you're adding a new
   subsystem, run `/spec` first to produce the design doc in `docs/specs/`.

## Releasing a new version

1. Bump `version` in `package.json` (semver — patch/minor/major as appropriate).
2. Run `npm run docs:stamp` to rewrite `_Last updated: vX.Y.Z_` stamps across all
   `docs/*.md` files to the new version. Never edit stamps by hand.
3. Add a `## [X.Y.Z] — YYYY-MM-DD` block to `CHANGELOG.md`.
4. Run the full local gate above to confirm everything is green.
5. Open a PR with title `chore(release): vX.Y.Z` and body:

   ```
   ## Summary
   - Bumps package version to X.Y.Z
   - Updates doc version stamps via `npm run docs:stamp`
   - Updates CHANGELOG.md

   ## Test plan
   - [ ] Full test suite green (`npm test`)
   - [ ] `npm run docs:stamp-check` exits 0
   - [ ] `npm run dogfood` exits 0

   ## No-spec rationale
   Release mechanics — no new protected paths or subsystem changes.
   ```

## Commit + PR conventions

- **Conventional commits**: `feat(scope): summary`, `fix(scope): summary`,
  `chore(scope): summary`, …
- **PR body** must contain `## Summary` + `## Test plan` sections. Use
  `gh pr create --body-file` to avoid heredoc quoting pitfalls.
- **Merge strategy**: `feat:` and `fix:` PRs → **squash-merge** (one commit
  on `main` = one CHANGELOG entry). `chore:` PRs — specifically
  release-please's own `chore(main): release X.Y.Z` — → **merge-commit**;
  release-please expects that shape. Using merge-commit on `feat:`/`fix:` PRs
  causes release-please to emit duplicate CHANGELOG entries: one from the
  merge SHA's PR reference and one from the individual conventional-commit SHA.
  PR #163 triggered this in v1.2.0 and required a manual splice.
- **Never** force-push someone else's branch, `--amend` a published commit,
  or pass `--no-verify` / `--no-gpg-sign`.
- Open commits are preferred over `--amend` once a PR is in review.

## Code style

- **No runtime dependencies.** The `package.json` manifest is zero-dep by
  contract (ADR-0002). New code ships as plain Node 20+ ESM, no bundler.
- **JSDoc every export.** `scripts/check-jsdoc-coverage.mjs` fails CI on
  undocumented `export`s under `plugins/dotbabel/src/`.
- **Structured errors.** Validators emit `ValidationError` from
  `src/lib/errors.mjs`, never raw strings. Add new codes to `ERROR_CODES`
  when the taxonomy doesn't cover your case.
- **CLI contract.** Every bin honors `--help`, `--version`, `--json`,
  `--verbose`, `--no-color` and exits via the named `EXIT_CODES`
  (`{OK:0, VALIDATION:1, ENV:2, USAGE:64}`).
- **Shell.** `set -euo pipefail` at the top of every script. Source
  `plugins/dotbabel/scripts/lib/output.sh` for `pass`/`fail`/`warn`. Run
  `shellcheck --severity=warning` locally.

## What not to send

- **TypeScript migration** — deliberately deferred (ADR-0002).
- **New runtime dependencies** — budget is zero until there's a very strong
  case. Devdeps are OK.
- **Windows-only code paths** — bash-first, `ubuntu-latest` CI only.
- **Docs-only PRs bypassing `/create-audit`/`/create-assessment`/`/spec`**
  when those skills apply — the audit trail lives in their output.

## Reporting a vulnerability

See `SECURITY.md`. TL;DR: private disclosure via GitHub Security Advisory,
not a public issue.

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).
