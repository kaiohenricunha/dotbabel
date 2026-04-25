# Handoff guide — cross-CLI, cross-machine session transfer

_Last updated: v0.11.0_

> **Added in v0.5.0; later reworked** to drop the `init` ceremony —
> `push` now auto-bootstraps the remote store on first run.
> Full skill reference: [`skills/handoff/SKILL.md`](../skills/handoff/SKILL.md).

The `/handoff` skill moves live session context from one agentic CLI to another —
Claude Code, GitHub Copilot CLI, OpenAI Codex CLI — on the same machine or across
machines. Nine sub-commands, one transport (a user-owned private git repo), one
scrubbed digest.

---

## When to use it

| Situation                                        | Sub-command                             |
| ------------------------------------------------ | --------------------------------------- |
| Continue a Claude Code session in Codex          | `digest` → paste-in                     |
| Pick up the same work on a different laptop      | `push` (machine A) → `pull` (machine B) |
| Persist the handoff to a markdown file for later | `file`                                  |
| Inspect a session's purpose without loading it   | `describe`                              |
| Find an old session by topic                     | `search "k8s networking"`               |
| List recent sessions                             | `list`                                  |
| Check what's waiting for you on the transport    | `remote-list`                           |
| Diagnose why `push`/`pull` isn't working         | `doctor`                                |

---

## Quick start — machine-to-machine handoff

**On machine A**, from any Claude / Copilot / Codex session:

```
/handoff push --tag finishing-auth-refactor --tag shipping
```

On the **first** push the binary walks you through a one-time setup:

```
DOTCLAUDE_HANDOFF_REPO is not set — dotclaude can set this up for you.

  Detected: gh CLI authenticated as @kaiohenricunha.
  Plan: create private repo  kaiohenricunha/<name>
        persist URL to       ~/.config/dotclaude/handoff.env

  Repo name? [dotclaude-handoff-store]
  Create kaiohenricunha/dotclaude-handoff-store and proceed? [y/N] y
  ✓ created kaiohenricunha/dotclaude-handoff-store
  ✓ wrote ~/.config/dotclaude/handoff.env
```

Subsequent pushes read the persisted URL silently. To make the URL
available in regular shells too, add:

```bash
source ~/.config/dotclaude/handoff.env
```

to your `~/.bashrc` or `~/.zshrc`.

**On machine B** (any CLI):

```
/handoff pull finishing-auth-refactor
```

Bare `/handoff pull` fetches the newest handoff; the positional is a
prefer exact-tag matches when present (`fetch shipping` resolves the
branch tagged `shipping` even if "shipping" appears as a substring
elsewhere); otherwise fuzzy-match the query against tag, short UUID, project slug, hostname, or
CLI name.

---

## The transport

One transport, always: a user-owned private git repo named by
`$DOTCLAUDE_HANDOFF_REPO`. Any provider works (GitHub, GitLab, Gitea,
self-hosted, bare local path). Each handoff lands as a branch:

```
handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>
```

e.g. `handoff/dotclaude/claude/2026-04/aaaa1111`. `main` is untouched —
the binary only reads and writes `handoff/...` branches, so you can
reuse an existing repo without disturbing its content.

**Auto-bootstrap requirements.** For the interactive setup on first push:

- `gh` CLI on PATH, authenticated against GitHub (`gh auth status`).
- An interactive terminal (TTY on stdin + stderr).

If either is missing, `push` prints a three-line manual-setup block
(create the repo, export the env var, retry) and exits 2. Set
`$DOTCLAUDE_HANDOFF_REPO` manually for GitLab, Gitea, or headless
workflows.

## Config file

The auto-bootstrap writes this file on success:

```
~/.config/dotclaude/handoff.env
  # Written by dotclaude handoff on 2026-04-20T…
  # Sourceable from your shell rc:  source ~/.config/dotclaude/handoff.env
  export DOTCLAUDE_HANDOFF_REPO=git@github.com:<you>/dotclaude-handoff-store.git
```

Mode 0600. Edit by hand to switch stores, or delete to force a
re-bootstrap on the next push. The binary sources this file at start-up
only when `$DOTCLAUDE_HANDOFF_REPO` is unset or empty — an explicit
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

Every `<query>` can be a full UUID, short UUID (first 8 hex), `latest`,
a Claude `customTitle`, or a Codex `thread_name`.

Power-user sub-commands (`resolve`, `describe`, `digest`, `file`) stay
reachable for scripting — each takes an explicit `<cli>` `<id>`. Full
argument semantics live in [`skills/handoff/SKILL.md`](../skills/handoff/SKILL.md).

---

## Common patterns

**Persist important context as a markdown file:**

```
/handoff file claude latest
# writes to docs/handoffs/<date>-<origin>-<short-id>.md
```

**Recover context after `/clear`:**

```
/handoff search "auth middleware" --cli claude --since 2026-04-01
/handoff <uuid-from-search>      # bare <query> form drops the block in place
```

**Scheduled remote handoff** (e.g. running as a /loop or cron):

```
/handoff push --tag "nightly checkpoint"
```

Headless runs skip the interactive bootstrap — set
`$DOTCLAUDE_HANDOFF_REPO` in the scheduler's environment.

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
dotclaude handoff doctor
```

It prints a one-line status for `git`, the transport URL, the persisted
config file, and `gh` fallback availability. A failure is always
accompanied by an exact remediation command.
