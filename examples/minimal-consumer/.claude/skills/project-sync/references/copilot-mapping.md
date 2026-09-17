# Copilot CLI mapping reference

`dotbabel project-sync` fans out repo-local artifacts to three places GitHub
Copilot CLI reads. Unlike Codex and Gemini (both of which auto-load anything
under their `skills/<id>/SKILL.md` shape), Copilot has no single
"skills directory" — it has two related but distinct discovery paths.

## Layout

| Source                         | Copilot destination                         | What it does                                                  |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------- |
| `.claude/commands/<name>.md`   | `.github/prompts/<name>.prompt.md`          | Slash-command analogue. The user types `/<name>` in Copilot.  |
| `.claude/skills/<id>/SKILL.md` | `.github/instructions/<id>.instructions.md` | Auto-loaded instruction file. Behavior shifts model defaults. |
| `CLAUDE.md` (rule-floor block) | `.github/copilot-instructions.md`           | Repo-wide instructions injected into every Copilot session.   |

Each row is a symlink. A real file at the destination is renamed to
`<dst>.bak-<YYYYMMDD-HHmmss>` before the symlink is placed; stale symlinks
are silently updated.

## Why two destinations and not one?

- `.github/prompts/*.prompt.md` is Copilot's slash-command discovery. It
  expects one file per command and a `.prompt.md` suffix. Wrapping a Claude
  command as `<name>/SKILL.md` would not be picked up.
- `.github/instructions/*.instructions.md` is Copilot's instruction-style
  context loading. It expects flat files with `.instructions.md` suffix, not
  a directory tree.

Real-world consumer repos already use this convention; the project-sync
fan-out matches that established shape.

## Detection and gating

Project-sync gates Copilot fan-out on `command -v copilot >/dev/null` unless
the caller passes `--all`. This mirrors the user-scope bootstrap behavior at
`plugins/dotbabel/src/bootstrap-global.mjs:347-378`.

If `copilot` is not on PATH and `--all` is not set, the Copilot rows above are
skipped. The instruction-file write to `.github/copilot-instructions.md` is
NOT skipped — that file is part of the rule-floor injection step, which
always runs, since it's how the repo signals project-wide rules to Copilot
even when the CLI is not installed locally.
