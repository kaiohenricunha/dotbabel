# Handoff guide — cross-CLI, cross-machine session transfer

_Last updated: v0.8.0_

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

**On machine A** (inside any session on Claude, Copilot, or Codex):

```
/handoff push --tag "finishing auth refactor"
```

(Zero-arg: pushes the host's latest session. Explicit variant:
`/handoff push <query> --tag <label>` picks a specific session.)

This:

1. Loads the relevant session transcript.
2. Runs a secret-scrubbing pass (eight token patterns — bearer, AWS key, etc.).
3. Uploads as a private GitHub Gist via `gh gist` (default), or via
   `--via git-fallback` / `--via gist-token` for restricted environments.

**On machine B** (inside any CLI):

```
/handoff pull finishing-auth-refactor
```

Bare `/handoff pull` fetches the newest handoff; the positional is a
fuzzy-match query against tag, short UUID, project slug, hostname, or
CLI name.

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

## The five forms

| Form                  | Behavior                                              |
| --------------------- | ----------------------------------------------------- |
| `/handoff`            | Push the host's latest session                        |
| `/handoff <query>`    | Local cross-agent: emit `<handoff>` block in place    |
| `/handoff push [<q>]` | Upload to transport; zero-arg = host latest           |
| `/handoff pull [<q>]` | Fetch from transport; zero-arg = newest gist          |
| `/handoff list`       | Unified local + remote table (`--local` / `--remote`) |

Every `<query>` can be a full UUID, short UUID (first 8 hex), `latest`,
a Claude `customTitle`, or a Codex `thread_name`.

**Narrowing with `--from <cli>`.** `push`, `pull`, and bare `<query>`
auto-detect the source CLI across all three roots. Short-UUID
prefixes can collide; add `--from claude` (or `copilot` / `codex`)
to force resolution into one root. Scripts that know which CLI a
handoff lives in should always pass `--from`. With no `<query>` and
no `--from`, bare `push` picks the latest session in the detected
host's root (based on `CLAUDECODE` / `CODEX_*` / `COPILOT_*` env
signals) and prints one stderr line naming the fallback; when no
host is detected, it falls back to the newest session across all
three roots.

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
/handoff push --via github --tag "nightly checkpoint"
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
