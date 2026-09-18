# Plan Discovery

Prefer explicit input. Discovery is best-effort and must be conservative.

## Supported Input Forms

- `file:<path>`: force file mode.
- `<path>`: read a local plan file if it exists.
- `text:"..."`: force inline text mode.
- `"..."`: grade quoted inline text.
- `latest <agent> plan`: discover candidates for one of `claude`, `codex`, `copilot`, or
  `gemini`.

## Claude Code

Claude Code supports a `plansDirectory` setting. Check project and user settings when readable:

- `.claude/settings.json`
- `.claude/settings.local.json`
- `~/.claude/settings.json`

If no setting is found, use `~/.claude/plans` as the default candidate directory. Candidate files
are Markdown files sorted by modified time.

## Gemini CLI

Gemini CLI plan mode writes Markdown plans. Check `general.plan.directory` in:

- `.gemini/settings.json`
- `~/.gemini/settings.json`

If no setting is found, search the documented temporary layout:

- `~/.gemini/tmp/<project>/<session-id>/plans/*.md`

Candidate files are Markdown files sorted by modified time.

## GitHub Copilot CLI

Do not assume a standalone plan directory. Prefer:

- Explicit path or quoted text.
- A Markdown file exported with Copilot's share flow.
- Nearby files in the current directory matching `copilot-session-*.md` or
  `copilot-plan-*.md`.

Session-state or chronicle files can be inspected only as transcript extraction. Confidence is at
most `medium` unless a clear plan block is found.

## Codex CLI

Do not assume a standalone plan directory. Prefer explicit path or quoted text.

If the user asks for `latest codex plan`, inspect Codex session rollouts when readable:

- `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`
- `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

Extract only clear plan blocks. Confidence is `medium` at best for transcript extraction and `low`
when no clear block exists.

## Multiple Candidates

If discovery finds more than one plausible candidate, show the top three by modified time and ask
the user to choose. Do not silently pick one when the difference affects the grade.

## `@` Imports And Intent Files

Resolve `@path` references and obvious local path references as intent files. Resolve transitively
to depth 2:

- depth 0: the submitted plan
- depth 1: files referenced by the plan
- depth 2: files referenced by depth-1 files

Stop after depth 2 and state that deeper imports were not loaded. Missing intent files reduce
confidence and may lower intent-source alignment.

## Oversized Plans

If the plan plus required intent and harness files would exceed the available context budget, refuse
with a clear error and ask for a narrower plan or explicit excerpts. Do not silently truncate. A
truncated plan cannot be fairly scored.

## Symlinks

Follow symlinks only when the resolved target stays inside:

- the project root, or
- the documented agent plan directory being searched.

Refuse symlinks that escape those roots. State the symlink path and resolved target.

## Embedded Images And Diagrams

Do not OCR images. If a plan depends on embedded images, screenshots, or diagrams, mark that portion
partially ungradable and lower confidence if the missing visual context affects the score.
