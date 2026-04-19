# Using handoff from Codex (or any shell)

Codex CLI does not autoload `~/.claude/skills/`, so it cannot invoke the
`/handoff` slash command directly. Use the `dotclaude-handoff` binary
via Codex's bash tool instead. One command, no skill load required.

## Prerequisite

`npm install -g @dotclaude/dotclaude` (gives you `dotclaude-handoff` on
your PATH). Or run `npx dotclaude-handoff ...` if you prefer not to
install globally.

## Typical workflows

### Claude session exceeded its token budget; continue in Codex

Claude prints its resume UUID on exit, e.g.
`claude --resume b8d2dd0a-1cb6-4cfb-b166-e0a94f20512e`.

Open Codex and invoke the binary through its Bash tool:

```
!dotclaude-handoff digest claude b8d2dd0a --to codex
```

The output is a single `<handoff>` block tuned for Codex (task-shaped
next step, filepaths inline). The block is now in Codex's context.
Continue the task.

Short UUID (first 8 hex) also works; so does the full UUID.

### Codex renamed the thread ("to resume this thread run codex resume test")

Handoff accepts the alias directly — it scans
`event_msg.payload.thread_name` across rollouts:

```
!dotclaude-handoff describe codex test
```

### Moving from Codex back to Claude

Inside Claude, run the slash-command form (skill is loaded):

```
/handoff digest codex <uuid-or-alias> --to claude
```

Or the binary form, which works from any shell:

```
!dotclaude-handoff digest codex <uuid-or-alias> --to claude
```

## Commands

```
dotclaude-handoff resolve  <cli> <id>              # file path only
dotclaude-handoff describe <cli> <id>              # inline summary
dotclaude-handoff digest   <cli> <id> --to <cli>   # paste-ready block
dotclaude-handoff list     <cli>                   # recent sessions
dotclaude-handoff file     <cli> <id> --to <cli>   # write to docs/handoffs/
```

`<cli>`: one of `claude`, `copilot`, `codex`.

`<id>`: full UUID (36 chars), short UUID (first 8 hex), the literal
`latest`, or (codex only) a thread_name alias.

`--to <cli>`: tunes the next-step suggestion for the target agent.
Defaults to `claude`.

All subcommands support `--help`, `--version`, `--json`, `--verbose`,
`--no-color`. Exit codes: 0 ok, 2 not found / parse error, 64 usage.

## Why the binary and not the skill file?

`skills/handoff/SKILL.md` is the authoritative runbook for Claude Code
and Copilot CLI (both load it automatically). Codex does not load it.
Rather than asking Codex to ingest a 460-line spec just to run one
sub-command, the binary bundles the resolution and extraction logic
into a single call. Same code path, same output shape; no skill load.
