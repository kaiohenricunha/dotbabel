# Handoff digest — common schema and rendering

The digest is the normalized payload the skill hands to the target
agent. It is CLI-agnostic: a Claude transcript and a Codex transcript
should produce the same shape.

## Fields

```yaml
origin:
  cli: claude | copilot | codex
  session_id: <full-uuid>
  short_id: <first-8-chars-of-uuid>
  cwd: <absolute-path>
  model: <model-id-or-list>
  started_at: <ISO-8601>
  turn_count: <int> # user turns only
summary: |
  2–4 sentences, plain English, describing what the session was about
  and where it left off. No CLI-specific jargon.
user_prompts:
  - <verbatim prompt 1>
  - <verbatim prompt 2>
key_findings:
  - <single-sentence claim the assistant established>
  - ...
artifacts:
  files_touched:
    - <absolute path>
  commands_run:
    - <non-read-only shell command>
next_step_suggestion: |
  One sentence the target agent should pick up from.
```

## Rendering: `<handoff>` block (for `digest` and `file` sub-commands)

```markdown
<handoff origin="<cli>" session="<short-id>" cwd="<cwd>">

**Summary.** <summary prose>

**User prompts (verbatim, in order).**

1. <prompt 1>
2. <prompt 2>

**Key findings.**

- <finding 1>
- <finding 2>

**Artifacts.**

- Files touched: <path1>, <path2>
- Commands run: `<cmd1>`, `<cmd2>`

**Next step.** <next_step_suggestion>

</handoff>
```

The `<handoff>` tag is intentional: target agents can detect it
reliably and distinguish digest content from surrounding commentary.

## Rendering: `describe` sub-command (terse inline summary)

```markdown
**<cli>** `<short-id>` — `<cwd>` — <started-at>

**User prompts.**

- <prompt 1>
- <prompt 2>

**Summary.** <2–4 sentence summary>
```

No `<handoff>` wrapper. No key findings, artifacts, or next step —
those belong in `digest`/`file`.

## Rendering: `file` sub-command (markdown doc)

```markdown
# Handoff: <origin.cli> → <target.cli>

_Generated: <ISO-timestamp>_
_Origin session: `<full-uuid>` (cwd: `<cwd>`)_

<handoff origin="..." session="..." cwd="...">
... (same block as digest) ...
</handoff>

---

## Full user prompt log

1. <prompt 1>

<!-- etc -->

## Notes

- Prompts 1–N verbatim; assistant responses summarized above.
- Source transcript: `<absolute path to jsonl>`
```

File path: `docs/handoffs/<YYYY-MM-DD>-<origin.cli>-<short-id>.md` when
a `docs/` directory exists at the repo root, else
`~/.claude/handoffs/<YYYY-MM-DD>-<origin.cli>-<short-id>.md`.

## Target-CLI tuning (the `--to` flag)

The only field that changes with `--to` is `next_step_suggestion`:

- `--to claude` — phrase the next step as an imperative Claude can
  follow directly ("Continue the refactor by editing …").
- `--to codex` — include explicit filepaths and a concrete sub-task,
  since Codex prefers task-shaped inputs.
- `--to copilot` — phrase as a question or "help me with …" since
  Copilot pairs with the user.

All other fields are identical regardless of target.

## Size bounds

- `summary`: ≤ 400 characters.
- `key_findings`: ≤ 5 bullets.
- `user_prompts`: cap at the last 10 prompts if the session has more;
  note the truncation in `summary`.
- `files_touched`: ≤ 20 paths; dedupe; prefer ones the assistant
  wrote/edited over ones it merely read.
