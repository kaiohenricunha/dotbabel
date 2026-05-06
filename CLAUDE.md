# CLAUDE.md — Global Claude Code Rules

> **Two ways to use dotbabel:**
>
> - **TL;DR — just want skills & commands:** Clone this repo and run `./bootstrap.sh`.
>   That wires `commands/`, `skills/`, and this file into `~/.claude/` in one step.
>   No npm required.
> - **Want more:** Install `@dotbabel/dotbabel` for the full CLI — `dotbabel bootstrap`,
>   `dotbabel sync`, `dotbabel doctor`, `dotbabel init`, `dotbabel detect-drift`,
>   and the spec-governance validators.
>   See [README.md](./README.md) or [docs/quickstart.md](./docs/quickstart.md).
>
> **This file is for the bootstrap path.** It gets symlinked into `~/.claude/CLAUDE.md`
> by `bootstrap.sh` and sets the global rule floor for every Claude Code session.
> **Consumers of `@dotbabel/dotbabel` do NOT inherit it** — the plugin's behavior
> lives in `plugins/dotbabel/` and [docs/](./docs/). Contributors should read
> [CONTRIBUTING.md](./CONTRIBUTING.md) first.

Universal behavior for every Claude Code session in every repo. Project-level `CLAUDE.md` files extend and may override these, but should not repeat them.

## Local filesystem conventions

- All projects live at `$HOME/projects/`. Do not search the home directory or default locations.
- Global Claude config lives wherever you cloned `dotbabel` and is symlinked into `~/.claude/`. Edit files in the clone, not `~/.claude/` directly.

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

This repository governs itself with `@dotbabel/dotbabel`. The authoritative
list of protected paths lives in `docs/repo-facts.json` and every entry must
be documented here — `dotbabel-check-instruction-drift` enforces this invariant.

- `CLAUDE.md` — this file.
- `README.md` — top-level public README.
- `.github/workflows/**` — CI pipelines.
- `.claude/**` — skill manifest, settings, hooks.
- `docs/repo-facts.json` — the facts source of truth.
- `docs/specs/**/spec.json` — spec metadata governed by the spec-anchored workflow.
- `plugins/dotbabel/src/**` — the npm package's source of truth.
- `plugins/dotbabel/bin/**` — the shipped bin entrypoints.
- `plugins/dotbabel/templates/**` — scaffolding templates consumers install.

Any PR touching one of these paths must carry either `Spec ID: dotbabel-core`
or a `## No-spec rationale` section in its body.

## Skills, Commands, and Discovery

Claude Code now treats skills and custom commands as the same slash-invoked
family: `commands/foo.md` and `skills/foo/SKILL.md` both expose `/foo`.
Skills are the preferred shape for new reusable workflows because they support
supporting files, richer frontmatter, automatic model invocation, direct user
invocation, and lazy-loaded references. Existing `commands/` files remain valid;
do not migrate them just for naming.

Use `skills/<id>/SKILL.md` when:

- Natural-language requests should route to the workflow, not only `/id`.
- The workflow needs `references/`, scripts, templates, examples, or other
  supporting files.
- Invocation behavior matters: `disable-model-invocation`, `user-invocable`,
  `allowed-tools`, `model`, `effort`, or `context` belongs in skill frontmatter.
- The capability should appear in the generated taxonomy as a reusable skill.

Use `commands/<name>.md` only for simple existing single-file prompt templates
where explicit slash invocation is the whole interface and no supporting files
or automatic routing are wanted. For side-effectful workflows implemented as
skills, set `disable-model-invocation: true`; do not fall back to commands
solely for safety.

`handoff` intentionally stays a skill: phrases like "continue in codex" and
"push handoff" should auto-route, while `/handoff` still works as a direct
invocation.

Loading model: skill descriptions are available for discovery, full `SKILL.md`
content loads only when invoked, and supporting files load only when referenced.
Do not maintain static command or skill tables in this file. When editing this
dotbabel repository, the authoritative inventory is generated from artifact
frontmatter:

```bash
node plugins/dotbabel/bin/dotbabel-index.mjs --check
node plugins/dotbabel/bin/dotbabel-list.mjs --type skill
node plugins/dotbabel/bin/dotbabel-list.mjs --type command
node plugins/dotbabel/bin/dotbabel-search.mjs <query>
node plugins/dotbabel/bin/dotbabel-show.mjs <id> --type skill
```
