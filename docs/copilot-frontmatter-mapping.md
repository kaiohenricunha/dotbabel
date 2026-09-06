# Copilot frontmatter mapping

_Last updated: v3.2.1_

`dotbabel project-sync` fans Claude commands and skills out to Codex, Gemini,
and Copilot. Codex and Gemini read `.codex/skills` / `.gemini/skills` as
verbatim symlinks — no frontmatter translation happens there, and none is
planned; see [#219](https://github.com/kaiohenricunha/dotbabel/issues/219).

Copilot is different: `.claude/commands/<name>.md` becomes a **generated**
`.github/prompts/<name>.prompt.md`, and `.claude/skills/<id>/SKILL.md`
becomes a **generated** `.github/instructions/<id>.instructions.md`. Each
generated file's frontmatter is mapped from Claude's shape into GitHub's, per
the tables below. This page is the source of truth for that mapping — if it
ever disagrees with the code, trust
[`plugins/dotbabel/src/copilot-frontmatter.mjs`](../plugins/dotbabel/src/copilot-frontmatter.mjs)
over the prose here.

GitHub's own schema is in public preview and may change; the tables below
were verified against GitHub's and VS Code's current documentation for
prompt files and custom instructions.

## Commands → `.prompt.md`

| Claude key                                                                                                              | `.prompt.md` key | Behavior                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`                                                                                                           | `description`    | Passed through unchanged.                                                                                                                                         |
| `name`                                                                                                                  | `name`           | Passed through unchanged.                                                                                                                                         |
| `argument-hint`                                                                                                         | `argument-hint`  | Passed through unchanged — same key name on both sides.                                                                                                           |
| `allowed-tools` or `tools`                                                                                              | `tools`          | Normalized to an array. `allowed-tools` wins when both are present.                                                                                               |
| `model`                                                                                                                 | _(dropped)_      | Warned. Claude's `model` is a tier enum (`opus`/`sonnet`/`haiku`/`inherit`); Copilot's is a free-form model identifier (e.g. `GPT-4o`). No safe crosswalk exists. |
| `effort`                                                                                                                | _(dropped)_      | Warned. No Copilot equivalent.                                                                                                                                    |
| `disable-model-invocation`                                                                                              | _(dropped)_      | Warned. No Copilot equivalent — Copilot has no auto-routing concept to disable.                                                                                   |
| every other key (`id`, `type`, `version`, `domain`, `platform`, `task`, `maturity`, `owner`, `created`, `updated`, ...) | _(dropped)_      | Silent. These are dotbabel taxonomy fields with no Copilot meaning; warning on every one of them would be noise with no fix available.                            |

`tools` normalization accepts both a space-separated string
(`allowed-tools: Read Grep Glob Bash`) and a comma-separated string
(`tools: Read, Grep, Glob`), since real commands use both, sometimes in the
same file.

## Skills → `.instructions.md`

`.instructions.md` has a smaller schema than `.prompt.md` — critically, **no
`tools` key at all** — so a skill's tool grant has nowhere to go.

| Claude key                  | `.instructions.md` key | Behavior                                                                                                                                            |
| --------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`               | `description`          | Passed through unchanged.                                                                                                                           |
| `name`                      | `name`                 | Passed through unchanged.                                                                                                                           |
| _(none)_                    | `applyTo`              | Always set to `**` — every generated instructions file applies repo-wide. Claude has no source key for this.                                        |
| `allowed-tools` or `tools`  | _(dropped)_            | Warned. Neither has a home on `.instructions.md`.                                                                                                   |
| `model`                     | _(dropped)_            | Warned. Same reasoning as commands.                                                                                                                 |
| `effort`                    | _(dropped)_            | Warned. No Copilot equivalent.                                                                                                                      |
| `disable-model-invocation`  | _(dropped)_            | Warned. No Copilot equivalent.                                                                                                                      |
| `argument-hint`             | _(dropped)_            | **Silent**, not warned — instructions files have no per-invocation argument concept and never will, so this would be permanent, unactionable noise. |
| every dotbabel taxonomy key | _(dropped)_            | Silent, same reasoning as commands.                                                                                                                 |

## The generated-file marker

Every file `project-sync` writes for Copilot starts with:

```
---
# dotbabel:generated — do not edit directly. Source: <path>. Regenerate with `dotbabel project-sync`.
...mapped frontmatter...
---
```

The marker is a YAML comment on the line **after** the opening `---`, never
before it — every mainstream frontmatter convention (Jekyll, Hugo,
gray-matter, and GitHub's own prompt/instructions files) requires `---` on
line 1, so a banner ahead of it would make Copilot fail to recognize the
frontmatter block at all. `dotbabel check-project-sync` uses this marker to
tell "we generated this, safe to regenerate" from "someone hand-authored
this" — a hand-authored file at a Copilot destination is backed up
(`<file>.bak-<timestamp>`) before dotbabel writes over it, exactly once.

## What this does not solve

Codex and Gemini still receive verbatim symlinks with no frontmatter
translation — that scope is intentionally out, tracked at
[#219](https://github.com/kaiohenricunha/dotbabel/issues/219). And even on
Copilot, `model`, `effort`, and `disable-model-invocation` have no home:
there is no safe way to carry Claude's model tier or auto-routing behavior
over to a different assistant.
