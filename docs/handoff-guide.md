# Handoff guide — cross-CLI, cross-machine session transfer

_Last updated: v2.7.0_

> **Added in v0.5.0; later reworked** to drop the `init` ceremony —
> `push` now auto-bootstraps the remote store on first run.
> Full skill reference: [`skills/handoff/SKILL.md`](../skills/handoff/SKILL.md).

The `/handoff` skill moves live session context from one agentic CLI to another —
Claude Code, GitHub Copilot CLI, OpenAI Codex CLI — on the same machine or across
machines. Seven sub-commands (doctor, fetch, list, prune, pull, push, search),
one transport (a user-owned private git repo), one scrubbed digest.

---

## When to use it

| Situation                                            | Sub-command               |
| ---------------------------------------------------- | ------------------------- |
| Continue a session in another CLI (in-place render)  | `pull latest`             |
| Pick up the same work on a different machine         | `push` (A) → `pull` (B)   |
| Persist context as a markdown file                   | `pull -o <path>`          |
| Inspect a session's summary without loading it       | `pull --summary`          |
| Find an old session by topic                         | `search "k8s networking"` |
| List recent sessions                                 | `list`                    |
| Check what's waiting on the remote                   | `list --remote`           |
| Fetch a specific session from the remote by tag/UUID | `fetch`                   |
| Remove old remote handoff branches                   | `prune --older-than 30d`  |
| Diagnose why `push`/`pull` isn't working             | `doctor`                  |

---

## Quick start — machine-to-machine handoff

**On machine A**, from any Claude / Copilot / Codex session:

```
/handoff push --tag finishing-auth-refactor --tag shipping
```

On the **first** push the binary walks you through a one-time setup:

```
DOTBABEL_HANDOFF_REPO is not set — dotbabel can set this up for you.

  Detected: gh CLI authenticated as @kaiohenricunha.
  Plan: create private repo  kaiohenricunha/<name>
        persist URL to       ~/.config/dotbabel/handoff.env

  Repo name? [dotbabel-handoff-store]
  Create kaiohenricunha/dotbabel-handoff-store and proceed? [y/N] y
  ✓ created kaiohenricunha/dotbabel-handoff-store
  ✓ wrote ~/.config/dotbabel/handoff.env
```

Subsequent pushes read the persisted URL silently. To make the URL
available in regular shells too, add:

```bash
source ~/.config/dotbabel/handoff.env
```

to your `~/.bashrc` or `~/.zshrc`.

When calling `dotbabel handoff push` with no query argument, `--from <cli>` is
required — the flag identifies which local session to upload (e.g. `--from codex`).
Skill invocations (`/handoff push`) auto-fill `--from` from the host session.

**On machine B** (any CLI):

```
/handoff pull finishing-auth-refactor
```

Bare `/handoff pull` fetches the newest handoff. With a positional, the
resolver first prefers exact-tag matches (`/handoff fetch shipping`
resolves the branch tagged exactly `shipping` even if "shipping" appears
as a substring of another branch's description), and otherwise
fuzzy-matches against tag, short UUID, project slug, hostname, or CLI
name.

---

## The transport

One transport, always: a user-owned private git repo named by
`$DOTBABEL_HANDOFF_REPO`. Any provider works (GitHub, GitLab, Gitea,
self-hosted, bare local path). Each handoff lands as a branch:

```
handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>
```

e.g. `handoff/dotbabel/claude/2026-04/aaaa1111`. `main` is untouched —
the binary only reads and writes `handoff/...` branches, so you can
reuse an existing repo without disturbing its content.

**Auto-bootstrap requirements.** For the interactive setup on first push:

- `gh` CLI on PATH, authenticated against GitHub (`gh auth status`).
- An interactive terminal (TTY on stdin + stderr).

If either is missing, `push` prints a three-line manual-setup block
(create the repo, export the env var, retry) and exits 2. Set
`$DOTBABEL_HANDOFF_REPO` manually for GitLab, Gitea, or headless
workflows.

## Config file

The auto-bootstrap writes this file on success:

```
~/.config/dotbabel/handoff.env
  # Written by dotbabel handoff on 2026-04-20T…
  # Sourceable from your shell rc:  source ~/.config/dotbabel/handoff.env
  export DOTBABEL_HANDOFF_REPO=git@github.com:<you>/dotbabel-handoff-store.git
```

Mode 0600. Edit by hand to switch stores, or delete to force a
re-bootstrap on the next push. The binary sources this file at start-up
only when `$DOTBABEL_HANDOFF_REPO` is unset or empty — an explicit
non-empty env var always
wins.

---

## The five forms

| Form                  | Behavior                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `/handoff`            | Push the host's latest session                                                              |
| `/handoff <query>`    | Local cross-agent: emit `<handoff>` block in place                                          |
| `/handoff push [<q>]` | Upload to transport; zero-arg = host latest                                                 |
| `/handoff pull [<q>]` | Fetch from transport; zero-arg = newest branch                                              |
| `/handoff list`       | Unified local + remote table (`--local`/`--remote`, `--from`, `--since`, `--limit`/`--all`) |

Sub-commands that render content accept `--summary` (terse inline) and `-o <path|auto|->` (write to file).

Every `<query>` can be a full UUID, short UUID (first 8 hex), `latest`,
or a deliberate-label alias: Claude `customTitle`/`aiTitle`, Codex
`thread_name`, Copilot `workspace.yaml:name`, or Gemini `checkpoint`
(`/chat save <tag>`). Aliases match case-insensitively. Resolution
precedence: UUID > short-UUID > `latest` > alias (no fall-through on miss).

---

## Common patterns

**Persist context as a markdown file:**

```
/handoff pull latest -o auto
# writes to docs/handoffs/<date>-claude-<short-id>.md
```

**Recover context after `/clear`:**

```
/handoff search "auth middleware" --from claude --since 2026-04-01
/handoff <uuid-from-search>      # bare <query> form drops the block in place
```

**Search with exact-string match (no regex):**

```
/handoff search "auth middleware" --from claude --fixed
```

**Resolve by deliberate label (case-insensitive):**

```
/handoff pull "refactor extract pipeline"   # matches Claude aiTitle "Refactor Extract Pipeline" (case-folded)
/handoff pull "pull latest changes"         # matches Copilot workspace.yaml:name "Pull Latest Changes"
/handoff pull "my-feature"                  # matches Codex thread_name "my-feature"
/handoff pull "test"                        # matches Gemini checkpoint "test" from /chat save test
```

**Scripting with structured output:**

```bash
dotbabel handoff pull latest --json | jq '.summary'
```

**Scheduled remote handoff** (e.g. running as a /loop or cron):

```
/handoff push --tag "nightly checkpoint"
```

Headless runs skip the interactive bootstrap — set
`$DOTBABEL_HANDOFF_REPO` in the scheduler's environment.

---

## Secrets & privacy

- **Push-side scrubbing**: eight secret patterns (AWS access keys, bearer tokens,
  `*_KEY`/`*_TOKEN`/`*_SECRET` with 20+ char values, PAT prefixes) are stripped
  before upload.
- **The handoff store is private by default** — the auto-bootstrap runs
  `gh repo create --private`. Don't flip it to public.
- The skill never invokes another CLI itself — it produces the digest and hands
  you a paste-ready block. This is deliberate: it keeps the transfer auditable
  and prevents unintended cross-session execution.

---

## Troubleshooting

See [troubleshooting.md — skills & commands](./troubleshooting.md#skills--commands-dotfile-users).
Quick diagnostic:

```
dotbabel handoff doctor
```

It prints a one-line status for `git`, the transport URL, the persisted
config file, and `gh` fallback availability. A failure is always
accompanied by an exact remediation command.
