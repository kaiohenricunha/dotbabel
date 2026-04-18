# Handoff guide — cross-CLI, cross-machine session transfer

_Last updated: v0.5.0_

> **Added in v0.5.0.** Full skill reference: [`skills/handoff/SKILL.md`](../skills/handoff/SKILL.md).

The `/handoff` skill moves live session context from one agentic CLI to another —
Claude Code, GitHub Copilot CLI, OpenAI Codex CLI — on the same machine or across
machines. Nine sub-commands, three transports, one scrubbed digest.

---

## When to use it

| Situation                                        | Sub-command                             |
| ------------------------------------------------ | --------------------------------------- |
| Continue a Claude Code session in Codex          | `digest` → paste-in                     |
| Pick up the same work on a different laptop      | `push` (machine A) → `pull` (machine B) |
| Persist the handoff to a markdown file for later | `file`                                  |
| Inspect a session's purpose without loading it   | `describe`                              |
| Find an old session by topic                     | `search "k8s networking"`               |
| List recent sessions                             | `list claude`                           |
| Check what's waiting for you on the transport    | `remote-list`                           |
| Diagnose why `push`/`pull` isn't working         | `doctor`                                |

---

## Quick start — machine-to-machine handoff

**On machine A** (Windows/WSL, inside a Claude Code session):

```
/handoff push claude latest --to codex --tag "finishing auth refactor"
```

This:

1. Loads the most recent Claude Code session transcript.
2. Runs a secret-scrubbing pass (eight token patterns — bearer, AWS key, etc.).
3. Voices the digest for the target agent (Codex in this case).
4. Uploads as a private GitHub Gist via `gh gist`.

**On machine B** (Linux/macOS, inside Codex CLI):

```
/handoff pull latest --to codex
```

This pulls the most recent handoff addressed to Codex, prints the paste-ready
digest, and lists any follow-up prompts.

---

## Transports

Three transports, picked with `--via`:

| Transport        | Flag                 | Requirements                                                | When to use                                 |
| ---------------- | -------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| GitHub (default) | `--via github`       | `gh` CLI on PATH, authenticated with `gist` scope           | Default — works on most hosts               |
| Token-based      | `--via gist-token`   | `curl` + `DOTCLAUDE_GH_TOKEN` PAT with `gist` scope         | Hosts where `gh` isn't installable          |
| Raw git          | `--via git-fallback` | `git` + `DOTCLAUDE_HANDOFF_REPO` pointing at a private repo | Corporate hosts where GitHub API is blocked |

Run `/handoff doctor --via <transport>` to verify prerequisites and get a
platform-specific remediation block.

---

## Sub-commands at a glance

| Sub-command   | Positional args        | Flags                                            |
| ------------- | ---------------------- | ------------------------------------------------ |
| `describe`    | `<cli> <uuid\|latest>` | `--to`                                           |
| `digest`      | `<cli> <uuid\|latest>` | `--to`                                           |
| `file`        | `<cli> <uuid\|latest>` | `--to`                                           |
| `list`        | `<cli>`                | `--limit`, `--since`                             |
| `search`      | `<query>`              | `--cli`, `--limit`, `--since`                    |
| `push`        | `<cli> <uuid\|latest>` | `--to`, `--via`, `--include-transcript`, `--tag` |
| `pull`        | `<handle\|latest>`     | `--to`, `--via`, `--from-file`                   |
| `remote-list` | —                      | `--via`, `--limit`, `--since`                    |
| `doctor`      | —                      | `--via`                                          |

Full argument semantics live in [`skills/handoff/SKILL.md`](../skills/handoff/SKILL.md).

---

## Common patterns

**Persist important context as a markdown file:**

```
/handoff file claude latest --to claude
# writes to docs/handoffs/<date>-<topic>.md
```

**Recover context after `/clear`:**

```
/handoff search "auth middleware" --cli claude --since 2026-04-01
/handoff describe claude <uuid-from-search>
```

**Scheduled remote handoff** (e.g. running as a /loop or cron):

```
/handoff push claude latest --to claude --via github --tag "nightly checkpoint"
```

---

## Secrets & privacy

- **Push-side scrubbing**: eight secret patterns (AWS access keys, bearer tokens,
  `*_KEY`/`*_TOKEN`/`*_SECRET` with 20+ char values, PAT prefixes) are stripped
  before upload.
- **Gists are private by default** (`gh gist create` without `--public`). Do not
  add `--public`.
- **`--include-transcript` is opt-in** — uploading raw turns increases secret
  leakage blast radius. Off by default.
- The skill never invokes another CLI itself — it produces the digest and hands
  you a paste-ready block. This is deliberate: it keeps the transfer auditable
  and prevents unintended cross-session execution.

---

## Troubleshooting

See [troubleshooting.md — skills & commands](./troubleshooting.md#skills--commands-dotfile-users).
For transport-specific failures, start with:

```
/handoff doctor --via github
/handoff doctor --via gist-token
/handoff doctor --via git-fallback
```

Each prints a platform-specific remediation block with the exact commands to fix
the failure mode it detected.
