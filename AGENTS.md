# Repository Guidelines

## Project Structure & Module Organization

This repository is a dual-purpose checkout: the published `@dotclaude/dotclaude` package and a personal Claude Code configuration. Core Node implementation lives in `plugins/dotclaude/src/*.mjs`; CLI entrypoints live in `plugins/dotclaude/bin/`. Shell helpers, hooks, and templates sit under `plugins/dotclaude/{scripts,hooks,templates}`. Tests live in `plugins/dotclaude/tests/` and mix Vitest, Bats, and shell harnesses. Shared content for consumers is kept in `commands/`, `skills/`, `agents/`, `schemas/`, `docs/`, and `examples/`.

## Build, Test, and Development Commands

Run `npm ci` first. Use `npm test` for the Vitest suite and `npm run coverage` for coverage output. Run `npx bats plugins/dotclaude/tests/bats/` for shell integration coverage and `bash plugins/dotclaude/tests/test_validate_settings.sh` for settings validation. `npm run lint` checks Markdown/JSON/YAML formatting and exported JSDoc coverage; `npm run shellcheck` lints shell scripts. `npm run dogfood` runs the packaged validators against this repo, and `npm run build-plugin` builds the distributable plugin.

## Coding Style & Naming Conventions

Target Node 20+ and keep source in ESM `.mjs` files. Follow `.editorconfig`: UTF-8, LF, final newline, and 2-space indentation; `Makefile` is the only tab-indented exception. Prettier governs Markdown/JSON/YAML formatting (`npm run format`) with `printWidth: 100` and double quotes. Name CLI bins `dotclaude-*`, keep tests as `*.test.mjs` or `*.bats`, and add JSDoc to every exported symbol under `plugins/dotclaude/src/`. Avoid adding new runtime dependencies without a strong justification.

## Testing Guidelines

Keep unit tests in `plugins/dotclaude/tests/**/*.test.mjs`. Use Bats for cross-shell or CLI regression scenarios and plain `.sh` harnesses where needed. Coverage thresholds are enforced in Vitest: 85% lines, 85% functions, 80% branches, and 85% statements. For bug fixes, add a failing regression test first and make it pass in the same change.

## Commit & Pull Request Guidelines

Follow conventional commits such as `feat(handoff): ...`, `fix(cli): ...`, `test(sync): ...`, and `chore(main): ...`. Prefer a dedicated worktree like `.claude/worktrees/my-change` instead of editing in the main checkout. PRs must include `## Summary` and `## Test plan`. If you touch protected paths such as `plugins/dotclaude/src/**`, `plugins/dotclaude/bin/**`, `README.md`, or `.github/workflows/**`, include either `## Spec ID` or `## No-spec rationale`. Record the exact verification commands you ran, and do not use `--no-verify` or amend published commits.
