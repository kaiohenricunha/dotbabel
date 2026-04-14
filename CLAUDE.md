# CLAUDE.md — Global Claude Code Rules

> **Persona note.** This file is the global rule floor for Kaio's personal
> Claude Code environment — it gets symlinked into `~/.claude/CLAUDE.md`
> by `bootstrap.sh`. **Consumers of `@kaiohenricunha/harness` do NOT
> inherit it.** The plugin's behavior is defined by its own docs under
> `plugins/harness/` and [docs/](./docs/). Contributors to this repo
> should read [CONTRIBUTING.md](./CONTRIBUTING.md) first; this file
> covers the author's universal working agreements, not project-specific
> development conventions.

Universal behavior for every Claude Code session in every repo. Project-level `CLAUDE.md` files extend and may override these, but should not repeat them.

## Local filesystem conventions

- All projects live at `$HOME/Projects/kaiohenricunha/`. Do not search the home directory or default locations.
- Global Claude config lives at `$HOME/Projects/kaiohenricunha/dotclaude/` and is symlinked into `~/.claude/`. Edit files under `dotclaude/`, not `~/.claude/` directly.

## Code Changes

- Before proposing fixes, **read the relevant source files**. Use `Grep` + `Glob` + `Read` to locate current behavior.
- Cite `file:line` references in every analysis. Claims without citations are not grounded.
- Do not propose edits until the analysis is confirmed against real code. "The file is probably named X" is not grounding — open it.
- When unsure, run `/ground-first <subject>` to enforce the read-first discipline.

## Testing

- Run the project's **full** test suite locally before merging any PR that modifies `/data`, calibration, rankings, fixtures, or anything consumed by downstream pipelines.
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
- **When editing Go files, run `gofmt -w <file>` immediately after editing.** Never leave Go files with formatting issues.
- **When reporting status or roadmap progress, verify each item against actual code or config before marking it complete.** Do not assume completion — show the evidence.

## Version control discipline

- **Never push to `main` (or any branch) without explicit user instruction.** Commit locally and wait for the user to say "push".
- **Never force-push, force-rebase, or `git reset --hard` a branch that is not yours.** If conflict resolution is ambiguous, stop and ask.
- **Never undo or revert another session's committed work.** Prior session commits are authoritative. If a merge conflict arises with prior session work, stop and ask.
- Before pushing any commit, review staged files for sensitive content (.env, credentials, API keys). Use `.gitignore` proactively.
- Prefer new commits over `--amend`. Never pass `--no-verify` or `--no-gpg-sign` unless the user explicitly asks.

## Worktree discipline (for any non-trivial change)

- **Default to git worktrees for anything non-trivial.** New features, bug fixes, code reviews, refactors, and spec work belong in a fresh worktree under `.claude/worktrees/<slug>/`, branched from the latest `origin/main` (run `git fetch origin main` first).
- The main checkout is effectively read-only for agentic work unless the user says "do it on main" for this specific task. A one-line typo fix they want committed directly is fine; anything larger is not.
- Never use `gh pr checkout`, `git checkout <other-branch>`, `git switch`, or `git stash` in the main checkout as a way to swap contexts; those operations silently corrupt any concurrent session editing the same checkout.
- **Respect other sessions' worktrees and branches.** Multiple agents and humans work concurrently. Before creating a worktree, run `git worktree list` and scan for anything that looks active (recent HEAD, branch name matching your intent). Never remove, rename, or force-overwrite a worktree you did not create in this session.

## PR Conventions

- Create PR bodies via `gh pr create --body-file <file>`, not heredoc. Heredocs mangle backticks and break the required Spec ID block.
- Required sections in every PR body:
  - `## Summary` — 1–3 bullets describing the change.
  - `## Test plan` — bulleted markdown checklist.
  - `Spec ID: <id>` — if the project uses spec IDs (check for `specs/` or `docs/specs/`).
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

For recurring sweeps (Dependabot, cron, CI-triggered agents), use headless mode to skip tool-approval prompts:

```bash
claude -p "Check rebase status of all open Dependabot PRs and report CI status" \
  --allowedTools "Bash(gh:*),Read,Grep"
```

Scope `--allowedTools` tightly — prefer `Bash(gh:*)` over `Bash(*)`. Combine with cron or GitHub Actions for unattended runs.

## Communication

- Match response length to the task. A simple question gets a direct answer, not headers and sections.
- State results and decisions directly. Don't narrate internal deliberation.
- Bias toward action. Write a brief plan (5 bullets max), then start implementing. Do not iterate on plans without producing code.

## Protected paths (dogfood)

This repository governs itself with `@kaiohenricunha/harness`. The authoritative
list of protected paths lives in `docs/repo-facts.json` and every entry must
be documented here — `harness-check-instruction-drift` enforces this invariant.

- `CLAUDE.md` — this file.
- `README.md` — top-level public README.
- `.github/workflows/**` — CI pipelines.
- `.claude/**` — skill manifest, settings, hooks.
- `docs/repo-facts.json` — the facts source of truth.
- `docs/specs/**/spec.json` — spec metadata governed by the spec-anchored workflow.
- `plugins/harness/src/**` — the npm package's source of truth.
- `plugins/harness/bin/**` — the shipped bin entrypoints.
- `plugins/harness/templates/**` — scaffolding templates consumers install.

Any PR touching one of these paths must carry either `Spec ID: harness-core`
or a `## No-spec rationale` section in its body.

## Slash Commands Reference

Quick-invoke disciplines for recurring friction:

| Command                       | When                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `/ground-first <subject>`     | Before any non-trivial fix — forces code-inspection analysis before edits                 |
| `/merge-pr <N>`               | Before merging a PR that touches data/calibration/rankings — runs full local verification |
| `/fix-with-evidence <issue>`  | For any bug fix — enforces Reproduce → Fix → Verify → PR loop                             |
| `/dependabot-sweep`           | Batch-triage all open Dependabot PRs with parallel subagents                              |
| `/audit-and-fix <domain>`     | Long-running audit-then-implement pipeline across many PRs                                |
| `/create-audit <subject>`     | Evidence-based audit doc to `docs/audits/`                                                |
| `/create-assessment <target>` | 0–10 graded assessment doc to `docs/assessments/`                                         |
| `/spec <subject>`             | Only when a spec/design doc is explicitly requested                                       |
