# §1 — Problem / Motivation

> Why does this exist? What's broken? Why now?

## Why

The handoff skill exists to solve one user-facing problem in two flavors:

1. **Cross-agent handoff (same machine).** When the user has to leave the
   current agent — Claude Code session limits hit, the model degrades, or a
   different agent is better suited for the next task — they need to continue
   the work in another agent without re-explaining context. All three
   supported agents (Claude Code, GitHub Copilot CLI, OpenAI Codex CLI) must
   work as both source and target, in any combination
   (Claude ↔ Copilot, Claude ↔ Codex, Copilot ↔ Codex).

2. **Cross-machine handoff (any agent → any agent).** When the user shifts to
   a different machine — laptop ↔ desktop, work ↔ personal, end-of-day on
   machine A ↔ morning on machine B — the same context transfer has to
   survive the move. The transport is a private GitHub repository: push from
   the source machine, pull on the target machine.

These are the **only** primary jobs. Every other capability the skill exposes
today (`search`, `describe`, `list`, `file`, `digest`, `resolve`,
`remote-list`, `doctor`) is supporting infrastructure that exists to make the
two primary jobs reliable — not a peer feature on the public surface.

## What

A skill whose **public surface is the two jobs**, not five forms and eleven
sub-commands:

- **Handoff to another agent.** One obvious invocation that produces the
  digest the user pastes into the next agent. The source CLI is auto-detected
  from where the binary is running. The target CLI is, by definition,
  whatever the user pastes into — so the user is never asked to declare the
  target.

- **Push / pull across machines.** One invocation per direction. Source is
  detected the same way; the remote is a private GitHub repository configured
  once.

Everything else (search, describe, list, …) is reachable when needed but does
not compete with the primary surface for the user's attention.

## Why Now

The skill has been iterated on across at least ten merged PRs touching the
same surface (#66 drop `<cli>` positional → #68 remove gist transports → #70
rename internals → #71 promote sub-commands into the binary → #72 slim
`SKILL.md` → #73 v2 store taxonomy → #80 self-bootstrap → #92 fail-closed
scrub → #93 shared library → #107 tags first-class). Each PR fixed a local
symptom without converging on a coherent shape. The current state has these
concrete tells:

- The skill description, the references, the binary `--help`, and the actual
  binary code disagree on what flags exist (e.g. `--from-file` is documented
  in `skills/handoff/SKILL.md` and `references/prerequisites.md` but not
  wired in `plugins/dotbabel/bin/dotbabel-handoff.mjs`).
- Cosmetic flags (`--to`) are required to do things that should be automatic
  — the target CLI is implicitly "wherever the user pastes," yet the binary
  treats it as a value the user must declare.

Three further symptoms enumerated in earlier drafts of this section
(bare `/handoff` defaulting to push, "private GitHub gist" prose in old
`SKILL.md`, and `--include-transcript` documented-but-unwired) shifted
under us while this spec was being written — all three were patched in
flight on `origin/main` (PRs #87 / silent-fix / #103). The patch-loop
tax is the spec's thesis, not its background.

The accumulated effect is that explaining what the skill does — to a new
user, to a contributor, or to the maintainer six weeks later — keeps
surfacing the same problems. A spec is needed to commit to **one** mental
model, lock the public surface, and stop the patch-on-patch loop. Future PRs
measure themselves against this spec rather than against the previous PR.
