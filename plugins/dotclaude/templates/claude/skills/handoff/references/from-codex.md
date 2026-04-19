# Using handoff from Codex (or any shell)

Codex CLI does not autoload `~/.claude/skills/`, so it cannot invoke
the `/handoff` slash command directly. Use the packaged binary via
Codex's bash tool instead. Same binary, same five-form shape.

## The five forms

```
!dotclaude handoff                              push host's latest session
!dotclaude handoff <query>                      local cross-agent: emit <handoff>
!dotclaude handoff push [<query>] [--tag LBL]   upload to transport
!dotclaude handoff pull [<query>]               fetch from transport
!dotclaude handoff list [--local|--remote]      unified table
```

`<query>` auto-detects the source CLI across all three roots. It
accepts: full UUID, short UUID (first 8 hex), `latest`, Claude
`customTitle`, or Codex `thread_name`.

## Examples

### Claude hit its token limit; continue in Codex

Claude prints on exit:

```
claude --resume b8d2dd0a-1cb6-4cfb-b166-e0a94f20512e
```

In a fresh Codex session:

```
!dotclaude handoff b8d2dd0a
```

Same works with a full UUID or a Claude `customTitle`:

```
!dotclaude handoff "test-handoff"
```

### Resume a Codex thread renamed via `codex resume <name>`

```
!dotclaude handoff my-feature
```

### Move a Codex session to the other machine

On machine A (before closing):

```
!dotclaude handoff push my-feature --tag end-of-day
```

On machine B:

```
!dotclaude handoff pull end-of-day
```

or bare `!dotclaude handoff pull` to pick up the latest handoff.

## Prerequisite

`npm install -g @dotclaude/dotclaude` (installs the `dotclaude` CLI on
PATH). Or `npx dotclaude handoff …` for ad-hoc use.

For cross-machine transport, set `DOTCLAUDE_HANDOFF_REPO` to a bare git
repo URL (HTTPS, SSH, `file://`, or absolute path) before running
`push`/`pull`. Example:

```bash
export DOTCLAUDE_HANDOFF_REPO=git@github.com:you/handoffs.git
```

## Collision handling

If a `<query>` matches a Claude session AND a Codex session (e.g. you
renamed a thread `refactor` and named a Claude session `refactor`), the
binary:

- On a TTY: prompts you to pick `[1..N]`.
- Non-TTY (scripts/CI): exits 2 with a TSV candidate list on stderr so
  the caller can parse and retry with a more specific query.

## Power-user sub-commands

The five-form shape above is the primary surface. For scripting you
can still use:

```
dotclaude handoff resolve  <cli> <id>        # file path only
dotclaude handoff describe <cli> <id>        # inline markdown summary
dotclaude handoff digest   <cli> <id>        # full <handoff> block
dotclaude handoff file     <cli> <id>        # write to docs/handoffs/
```

All subcommands support `--help`, `--version`, `--json`, `--verbose`,
`--no-color`. Exit codes: 0 ok, 2 not found / parse error, 64 usage.

## Why the binary and not the skill file?

`skills/handoff/SKILL.md` is the authoritative runbook for Claude Code
and Copilot CLI (both load it automatically). Codex does not load it.
Rather than asking Codex to ingest a 460-line spec, the binary bundles
the resolution and extraction logic into a single call. Same code path
as the skill; no skill load required.
