# Using handoff from Codex (or any shell)

Codex CLI does not autoload `~/.claude/skills/`, so it cannot invoke
the `/handoff` slash command directly. Use the packaged binary via
Codex's bash tool instead. Same binary, same five-form shape.

## The five forms

```
!dotbabel handoff                              push host's latest session
!dotbabel handoff <query>                      local cross-agent: emit <handoff>
!dotbabel handoff push [<query>] [--tag LBL]   upload to transport
!dotbabel handoff pull [<query>]               fetch from transport
!dotbabel handoff list [--local|--remote] [--from <cli>] [--since <ISO>] [--limit N|--all]
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
!dotbabel handoff b8d2dd0a
```

Same works with a full UUID or a Claude `customTitle`:

```
!dotbabel handoff "test-handoff"
```

### Resume a Codex thread renamed via `codex resume <name>`

```
!dotbabel handoff my-feature
```

### Move a Codex session to the other machine

On machine A (before closing):

```
!dotbabel handoff push my-feature --tag end-of-day
```

On machine B:

```
!dotbabel handoff pull end-of-day
```

or bare `!dotbabel handoff pull` to pick up the latest handoff.

## Prerequisite

`npm install -g @dotbabel/dotbabel` (installs the `dotbabel` CLI on
PATH). Or `npx dotbabel handoff …` for ad-hoc use.

For cross-machine transport, set `DOTBABEL_HANDOFF_REPO` to a bare git
repo URL (HTTPS, SSH, `file://`, or absolute path) before running
`push`/`pull`. Example:

```bash
export DOTBABEL_HANDOFF_REPO=git@github.com:you/handoffs.git
```

## Collision handling

If a `<query>` matches a Claude session AND a Codex session (e.g. you
renamed a thread `refactor` and named a Claude session `refactor`), the
binary:

- On a TTY: prompts you to pick `[1..N]`.
- Non-TTY (scripts/CI): exits 2 with a TSV candidate list on stderr so
  the caller can parse and retry with a more specific query.

See `dotbabel handoff --help` for the full sub-command and flag reference.

## Why the binary and not the skill file?

`skills/handoff/SKILL.md` is the authoritative runbook for Claude Code
and Copilot CLI (both load it automatically). Codex does not load it.
Rather than asking Codex to ingest a 460-line spec, the binary bundles
the resolution and extraction logic into a single call. Same code path
as the skill; no skill load required.
