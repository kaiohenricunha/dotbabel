---
id: project-sync
name: project-sync
type: skill
version: 0.1.0
domain: [devex]
platform: [none]
task: [scaffolding]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-09
updated: 2026-05-09
description: >
  Fan out the current repo's CLAUDE.md, .claude/commands, and .claude/skills
  into Codex, Gemini, and Copilot project-scope analogues (.codex/skills,
  .gemini/skills, .github/prompts, .github/instructions) plus refresh
  AGENTS.md, GEMINI.md, and .github/copilot-instructions.md from the project's
  rule floor. Wraps `dotbabel project-sync`. Use when adopting cross-CLI
  workflows in a repo for the first time, or when adding a new command/skill
  that needs to be visible to Codex/Gemini/Copilot. Triggers on:
  "sync this repo", "project sync", "fan out commands", "wire up gemini for
  this project", "add this command to codex", "make this skill available in
  copilot", "regenerate AGENTS.md for this project".
argument-hint: "[--dry-run] [--all] [--repo <path>]"
tools: Bash, Read, Glob
effort: low
model: sonnet
---

# project-sync — Repo-local cross-CLI fan-out

Thin wrapper around `dotbabel project-sync`. The binary owns all writes; this
skill maps natural-language requests to the right invocation and surfaces
dry-run output before mutating the repo.

## When to invoke

- The user wants to adopt cross-CLI workflows in a repo that already has
  `.claude/commands/*` or `.claude/skills/*`, but no `AGENTS.md`/`GEMINI.md`/
  `.github/prompts/`/`.github/instructions/` wiring.
- A new command or skill was just added to `.claude/`, and the user wants
  Codex/Gemini/Copilot to see it without leaving the editor.
- The user asks for "drift check" or "is this repo synced" — run
  `dotbabel check-project-sync` instead and surface the diff.
- First-time setup: if `.dotbabel.json` is missing, suggest
  `dotbabel project-init` first.

## Workflow

1. **Pre-flight.** Confirm cwd is a git repo and contains `CLAUDE.md` (with or
   without rule-floor markers) plus at least one of `.claude/commands/` or
   `.claude/skills/`. If `.dotbabel.json` is absent, mention that defaults will
   apply (no `cli_substitutions`, full fan-out to codex/gemini/copilot,
   gating on each CLI's `command -v` check).
2. **Dry-run first.** Always run `dotbabel project-sync --dry-run` before
   mutating. Summarize the planned actions to the user (count of instruction
   files, count of new symlinks per CLI). Pause for confirmation **unless**
   the user already said "do it" or "go ahead" in the same turn.
3. **Apply.** Run `dotbabel project-sync` (no `--dry-run`). If the user passed
   `--all`, propagate it.
4. **Verify.** Run `dotbabel check-project-sync` and report `ok` /
   `missing` / `stale` counts. Exit non-zero output should be surfaced.

## Triggers and invocations

| Trigger phrase                                        | Invocation                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| "sync this repo", "project sync", "fan out commands"  | `dotbabel project-sync --dry-run` then apply               |
| "wire up gemini for this project"                     | `dotbabel project-sync --all` (covers all)                 |
| "is this repo synced", "drift check the project sync" | `dotbabel check-project-sync` (read-only)                  |
| "regenerate AGENTS.md for this project"               | `dotbabel project-sync` (instructions are part of the run) |
| "set up project sync here", "first-time project sync" | `dotbabel project-init` then project-sync                  |

## Reference: Copilot mapping

The Copilot CLI fan-out targets `.github/prompts/*.prompt.md` (commands) and
`.github/instructions/*.instructions.md` (skills) inside the target repo.
See [`references/copilot-mapping.md`](references/copilot-mapping.md) for the
full layout and rationale.

## Boundaries

- Always operate on the user's current working directory unless they pass an
  explicit `--repo <path>`. Never silently target a different repo.
- Never run `--force`. The plan reserves it for collision overrides; defer
  to the binary's existing collision warnings.
- For consumer repos with no `.dotbabel.json`, the convention path applies
  (entire `CLAUDE.md` becomes the rule floor when markers are absent).
- This skill is for **project-scope** sync. For user-scope (`~/.claude/`,
  `~/.codex/`, `~/.gemini/`) bootstrap, use `dotbabel bootstrap` instead.
