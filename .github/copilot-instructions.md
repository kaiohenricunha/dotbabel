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

## Universal rule floor

<!-- dotbabel:rule-floor:begin -->
<!-- AUTO-GENERATED FROM CLAUDE.md by dotbabel-generate-instructions. Do not edit. -->

## Local filesystem conventions

- All projects live at `$HOME/projects/`. Do not search the home directory or default locations.
- Global Copilot config lives wherever you cloned `dotbabel` and is symlinked into `~/.copilot/`. Edit files in the clone, not `~/.copilot/` directly.

## Code Changes

- Before proposing fixes, **read the relevant source files**. Use `Grep` + `Glob` + `Read` to locate current behavior.
- Cite `file:line` references in every analysis. Claims without citations are not grounded.
- Do not propose edits until the analysis is confirmed against real code. "The file is probably named X" is not grounding — open it.
- When unsure, invoke the `/ground-first` skill to enforce the read-first discipline.
- **Surface assumptions before coding.** If a request has multiple valid interpretations, list them explicitly. In interactive sessions, ask before picking one. In autonomous/headless mode, state the chosen interpretation and proceed. "Make it faster" → clarify which dimension (latency, throughput, perceived UX) before writing code.
- **Surgical orphan cleanup.** When your changes make an import or variable unused, remove it. Remove a function only after verifying it is not part of a public/exported API and has no remaining references (use a repo-wide search); otherwise keep it or deprecate it. Don't remove pre-existing dead code your changes didn't create — mention it instead.

## Root Cause Before Fix

- For any bug or data discrepancy, perform a grounded audit (read the actual code paths, check deployment state, verify data sources) BEFORE proposing a fix or plan. Do not accept the first plausible hypothesis.
- State evidence (file:line, log snippet, commit sha) for each claim in the diagnosis.
- Present at least two candidate root causes with evidence for and against each before settling on one.
- **Do not write code until the user approves the audit.** In interactive sessions, wait for explicit sign-off. In autonomous/headless mode, emit the audit and state the chosen root cause before proceeding.

## Testing

- Run the project's **full** test suite locally before merging any PR that modifies files listed in `regression_paths` (see `docs/repo-facts.json`) or anything consumed by downstream consumers.
- Never claim a test failure is "pre-existing" without proving it. Required proof:
  ```bash
  git stash && <test-command> ; git stash pop
  ```
  If the failure survives the stash, it's pre-existing. If it disappears, your change introduced it.
- Detect the test runner from the project, don't guess:
  - `Makefile` with a `test` target → `make test`
  - `package.json` → `npm test` (or `pnpm test` / `yarn test` based on the lockfile)
  - `go.mod` → `go test ./...`
  - `pyproject.toml` → `pytest` or `uv run pytest`
- Partial test subsets are fine for iteration. Full suite is required before pushing or merging.

## TDD and verification

- **Always follow TDD for new features:** write tests first (positive, negative, boundary), then implement until tests pass.
- **For bug fixes:** write a failing test that reproduces the issue, fix, then verify.
- **Transform vague tasks into verifiable goals before starting.** "Fix the bug" → "write a test that reproduces it, then make it pass." For multi-step tasks, emit a concise plan with explicit verification at each step: `Step → verify: [check]`. Default to 5 bullets or fewer; exceed that only when the task is genuinely complex.
- **When editing Go files, run `gofmt -w <file>` immediately after editing.** Never leave Go files with formatting issues.
- **When reporting status or roadmap progress, verify each item against actual code or config before marking it complete.** Do not assume completion — show the evidence.

## Test Plan Verification

- Run every command in the test plan verbatim, in order. Paste the **last 10 lines of output** for each.
- If any command was skipped or inferred rather than run, say so explicitly. Never claim completion based on partial runs.

## Version control discipline

- **Never push to `main` (or any branch) without explicit user instruction.** Commit locally and wait for the user to say "push".
- **Never merge a PR without explicit user instruction.** Do not use `--auto`, `gh pr merge`, or any merge path unless the user says "merge" for that specific PR.
- **Never force-push, force-rebase, or `git reset --hard` a branch that is not yours.** If conflict resolution is ambiguous, stop and ask.
- **Never undo or revert another session's committed work.** Prior session commits are authoritative. If a merge conflict arises with prior session work, stop and ask.
- Before pushing any commit, review staged files for sensitive content (.env, credentials, API keys). Use `.gitignore` proactively.
- Prefer new commits over `--amend`. Never pass `--no-verify` or `--no-gpg-sign` unless the user explicitly asks.

## Worktree discipline (for any non-trivial change)

- **Default to git worktrees for anything non-trivial.** New features, bug fixes, code reviews, refactors, and spec work belong in a fresh worktree under `.claude/worktrees/<slug>/`, branched from the latest `origin/main` (run `git fetch origin main` first).
- The main checkout is effectively read-only for agentic work unless the user says "do it on main" for this specific task. A one-line typo fix they want committed directly is fine; anything larger is not.
- Never use `gh pr checkout`, `git checkout <other-branch>`, `git switch`, or `git stash` in the main checkout as a way to swap contexts; those operations silently corrupt any concurrent session editing the same checkout.
- **Respect other sessions' worktrees and branches.** Multiple agents and humans work concurrently. Before creating a worktree, run `git worktree list` and scan for anything that looks active (recent HEAD, branch name matching your intent). Never remove, rename, or force-overwrite a worktree you did not create in this session.

## Worktree & Sandbox Conventions

- Before starting work in a worktree, verify it is clean (`git status`) and not already claimed by a concurrent headless worker (check for lockfiles/PID files).
- Use `$CLAUDE_PROJECT_DIR` in hooks and scripts rather than relative paths.
- When sandbox blocks writes to `/tmp` or the worktree path, emit results to stdout as a fallback and flag the limitation explicitly.

## PR Conventions

- Create PR bodies via `gh pr create --body-file <file>`, not heredoc. Heredocs mangle backticks and break the required Spec ID block.
- Required sections in every PR body:
  - `## Summary` — 1–3 bullets describing the change.
  - `## Test plan` — bulleted markdown checklist.
  - `## Spec ID` heading followed by the spec id — if the project uses spec IDs (check for `specs/` or `docs/specs/`). Must be an H2 heading; `dotbabel-check-spec-coverage` extracts it via H2 regex.
- Never merge a PR with failing CI without explicit user approval.

## Shell & Scripting

- Use `bash` (not `zsh`) for monitor scripts, loops, and anything using `read`, `$?`, or `$status`. `zsh` makes `status` read-only and breaks scripts silently.
- Avoid reserved variable names: `status`, `path`, `pwd`, `prompt`, `HISTFILE`. Prefer `result`, `workdir`, `current_status`.
- Before long-running work, verify session sanity:
  - `pwd` exists (sessions die silently on deleted worktrees).
  - `git status` is clean (or intentionally dirty) — no unexpected locks.
  - The branch is what you expect.
- Prefer `gh <cmd> --body-file` or `--json` + `--jq` over shell-interpolated strings.

## Deploy discipline

- **Never deploy to production without explicit user instruction.** Use the project's sanctioned deploy command (e.g. `/ship`, not direct `vercel --prod` or `flyctl deploy`).
- **When designated as autonomous** (batch task, pipeline, overnight run), do not stop for permission at intermediate steps. Execute fully. Only pause for genuinely destructive or irreversible actions.
- **Autonomous dry-run contract.** Before invoking any command that writes to production data, emit a one-block plan: exact command, every flag with a justification, expected scope, estimated runtime. Then execute without further prompts. Never pass `--force` without explicit user authorization for the specific run.

## Implementation vs Spec

- When the user asks for an implementation, a fix, a PR, or "just do X" — **cap planning at a 5-bullet sketch, then edit**. Do not spin up spec docs.
- Use `/spec` only when the user explicitly asks for a spec, design doc, RFC, or says "let's spec this out."
- If a task genuinely needs a plan longer than 5 bullets, write it inline in the response — don't create a planning file unless asked.

## Headless Mode

For recurring sweeps (Dependabot, cron, CI-triggered agents), use headless mode to skip tool-approval prompts.

## Communication

- Match response length to the task. A simple question gets a direct answer, not headers and sections.
- State results and decisions directly. Don't narrate internal deliberation.
- Bias toward action. Write a brief plan (5 bullets max), then start implementing. Do not iterate on plans without producing code.

## Protected paths (dogfood)

This repository governs itself with `@dotbabel/dotbabel`. The authoritative
list of protected paths lives in `docs/repo-facts.json` and every entry must
be documented in every rule-floor file listed in
`docs/repo-facts.json:rule_floor_files`; `dotbabel-check-instruction-drift`
enforces this invariant.

- `CLAUDE.md` — canonical rule-floor source.
- `README.md` — top-level public README.
- `AGENTS.md` — project-scoped instructions for Codex / Copilot CLI.
- `GEMINI.md` — project-scoped instructions for Gemini CLI.
- `.github/workflows/**` — CI pipelines.
- `.github/copilot-instructions.md` — project-scoped instructions for GitHub Copilot.
- `.claude/**` — skill manifest, settings, hooks.
- `docs/repo-facts.json` — the facts source of truth.
- `docs/specs/**/spec.json` — spec metadata governed by the spec-anchored workflow.
- `plugins/dotbabel/src/**` — the npm package's source of truth.
- `plugins/dotbabel/bin/**` — the shipped bin entrypoints.
- `plugins/dotbabel/templates/**` — scaffolding templates consumers install (includes `plugins/dotbabel/templates/cli-instructions/**`, the user-scope rule-floor templates generated by `dotbabel-generate-instructions`).

Any PR touching one of these paths must carry either `Spec ID: dotbabel-core`
or a `## No-spec rationale` section in its body.

The rule-floor block (between `<!-- dotbabel:rule-floor:begin -->` and `<!-- dotbabel:rule-floor:end -->` markers) in `AGENTS.md`, `GEMINI.md`, and `.github/copilot-instructions.md` is **auto-generated from this file** by `dotbabel-generate-instructions`. Edit the rule floor here in `CLAUDE.md`; re-run the generator (`npx dotbabel-generate-instructions` or `dotbabel sync`) to fan it out. Hand-editing the block in a host file will be reverted by the next regen and is detected by `dotbabel-check-instruction-drift`.

## Skills, Commands, and Discovery

Do not maintain static command or skill tables in instruction files. When editing
this dotbabel repository, the authoritative inventory is generated from artifact
frontmatter:

```bash
node plugins/dotbabel/bin/dotbabel-index.mjs --check
node plugins/dotbabel/bin/dotbabel-list.mjs --type skill
node plugins/dotbabel/bin/dotbabel-list.mjs --type command
node plugins/dotbabel/bin/dotbabel-search.mjs <query>
node plugins/dotbabel/bin/dotbabel-show.mjs <id> --type skill
```

<!-- dotbabel:rule-floor:end -->
