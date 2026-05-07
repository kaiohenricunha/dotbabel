# Context Resolution

The grader must understand the harness before scoring. Plans that ignore project or user harnesses
can be well-written and still unsafe to execute.

## Layering Model

1. `AGENTS.md` is the cross-agent baseline. Treat it as shared project guidance read by Codex,
   Copilot CLI, Gemini CLI, and other agents that honor the AGENTS convention.
2. Agent-specific project overrides layer on top:
   - Claude Code: `CLAUDE.md`, nested `CLAUDE.md`, and `CLAUDE.local.md` when readable.
   - Codex: `AGENTS.override.md` when present; otherwise `AGENTS.md`.
   - GitHub Copilot: `.github/copilot-instructions.md` and
     `.github/instructions/*.instructions.md`.
   - Gemini CLI: `GEMINI.md` and nested `GEMINI.md`.
3. User/global files are preference context:
   - Claude Code: `~/.claude/CLAUDE.md`
   - Codex: `~/.codex/AGENTS.md`
   - Copilot CLI: `$HOME/.copilot/copilot-instructions.md`
   - Gemini CLI: `~/.gemini/GEMINI.md`

User/global files can raise expectations but cannot weaken repo-local rules around protected paths,
specs, CI, release gates, safety, or validation.

## Audit Flow

1. Read `AGENTS.md` when present.
2. Read agent-specific project files that exist and are relevant to the source agent or affected
   paths.
3. Read `docs/repo-facts.json` when present to identify protected paths and regression paths.
4. Inspect the plan for claimed touched paths, generated artifacts, PR body requirements, test
   commands, and release operations.
5. Apply caps when the plan conflicts with any effective harness rule.

## What Counts As A Harness Violation

- Touching protected paths without planning the required Spec ID or No-spec rationale.
- Skipping required validation listed in project instructions.
- Planning to use forbidden flags such as `--no-verify` when the harness disallows them.
- Mutating generated artifacts by hand when the harness requires regenerating from source.
- Ignoring worktree, commit, or PR conventions that affect reviewability or safety.
- Weakening user/global safety rules without explicit user approval.
