# Spec — @dotbabel/dotbabel core

Status: **done** (v0.2.0 productization landing across PRs 1–7)

## Context

`@dotbabel/dotbabel` is an opinionated Claude Code toolkit, shipped as a
portable npm package + Claude Code plugin. It bundles a curated library of
skills, slash commands, and cloud/IaC specialists; a global `CLAUDE.md` rule
floor; an umbrella CLI surface (`dotbabel`, `dotbabel-doctor`,
`dotbabel-validate-skills`, …); a programmatic Node API
(`import { validateSpecs, createHarnessContext, … }`); a gold-standard shell
settings validator; and a destructive-git PreToolUse guard hook.

Spec-driven-development governance is one consumer-facing module of that
toolkit — repos that want PR-time spec gates can opt in via
`dotbabel-validate-specs` and `dotbabel-check-spec-coverage`; the rest of
the toolkit works without it.

This repository — `dotbabel` — is the canonical checkout. It
dogfoods its own validators on every push (dogfood.yml in PR 7) and ships the
public npm release via trusted publishing (release.yml in PR 7).

## Invariants

- The public Node-API barrel at `plugins/dotbabel/src/index.mjs` exposes ≥24
  named exports. Consumers never deep-import `src/*.mjs` directly.
- Every validator emits `ValidationError` instances with stable `.code` values
  from `ERROR_CODES`. Renames are breaking; additions are not.
- Every bin honors the harness-wide flag set (`--help`, `--version`, `--json`,
  `--verbose`, `--no-color`) and the named `EXIT_CODES` convention
  (0 ok, 1 validation, 2 env, 64 usage).
- The `guard-destructive-git.sh` hook exits **2** (Claude Code PreToolUse
  protocol) to block a tool call — this is distinct from the validator
  `EXIT_CODES.ENV = 2`.
- All shipped shell scripts use `set -euo pipefail` and source the shared
  `✓/✗/⚠` helpers from `plugins/dotbabel/scripts/lib/output.sh`.

## Linked surface

See `linked_paths` in `spec.json` — every file whose content is governed by
this spec. Any PR that modifies a linked path must either reference
`Spec ID: dotbabel-core` or provide a `## No-spec rationale` section.

## Acceptance

See `acceptance_commands` in `spec.json`. CI runs them on every push (see
`dogfood.yml` in PR 7).

## Non-goals (frozen to out-of-scope at v0.2.0)

- TypeScript migration (see ADR-0002)
- Docs site framework (plain markdown + GitHub rendering)
- Windows shell support
- A `dotbabel upgrade` subcommand (manual for now; see `docs/upgrade-guide.md`)
