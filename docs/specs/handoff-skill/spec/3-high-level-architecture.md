# §3 — High-Level Architecture

> System view: components, data stores, external dependencies, deployment.

## System Overview

The handoff skill is a single binary (`dotbabel handoff`) plus a thin
natural-language trigger surface (`skills/handoff/SKILL.md`) and a frozen
shell substrate that knows each agent CLI's transcript format. All three
agents (Claude Code, GitHub Copilot CLI, OpenAI Codex CLI) reach the same
binary entrypoint:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Claude Code                Copilot CLI               Codex CLI      │
│  ────────────               ───────────               ─────────      │
│  loads SKILL.md             loads SKILL.md            no skill load  │
│  /handoff … or              /handoff … or             !dotbabel     │
│  natural language           natural language          handoff …      │
│         │                          │                       │        │
│         └────────────┬─────────────┴───────────┬───────────┘        │
│                      ▼                         ▼                     │
│             Bash tool spawn:        direct shell invocation         │
│                      │                         │                     │
│                      └────────────┬────────────┘                    │
│                                   ▼                                  │
│                       ┌───────────────────────────┐                 │
│                       │   dotbabel handoff       │  ← public       │
│                       │   bin (Node.js)           │    contract     │
│                       └───────────────────────────┘                 │
│                              │                                       │
│                              ├── handoff-remote.mjs (shared lib)    │
│                              │   render, transport, encode/decode   │
│                              │                                       │
│                              ├── handoff-scrub.mjs (fail-closed)    │
│                              │                                       │
│                              └── shell substrate (frozen):          │
│                                  resolve.sh, extract.sh,            │
│                                  scrub.sh, description.sh,          │
│                                  doctor.sh                          │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                  ┌────────────────┼────────────────┐
                  ▼                ▼                ▼
         ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
         │ ~/.claude/   │ │ ~/.copilot/  │ │ ~/.codex/        │
         │ projects/    │ │ session-     │ │ sessions/        │
         │ <…>/<uuid>   │ │ state/<uuid> │ │ <yyyy>/<mm>/<dd> │
         │ .jsonl       │ │ /events.json │ │ /rollout-…jsonl  │
         └──────────────┘ └──────────────┘ └──────────────────┘
                   ↑ local read for `pull <id>`

         ┌─────────────────────────────────────────┐
         │  Private GitHub repo                    │
         │  $DOTBABEL_HANDOFF_REPO                │
         │                                         │
         │  refs/heads/handoff/                    │
         │    <project>/<cli>/<YYYY-MM>/<short>    │
         │                                         │
         │  Each branch:                           │
         │    handoff.md   (the digest block)      │
         │    metadata.json                        │
         │    description.txt                      │
         │                                         │
         │  Tags: refs/tags/<label>  (multi-tag)   │
         └─────────────────────────────────────────┘
                   ↑ remote read/write for `push`/`fetch`
```

## Public Contract: Three Primary Commands

The user-facing surface settles on three verbs, partitioned by transport:

| Verb    | Transport        | Direction                | Resolves via                                    |
| ------- | ---------------- | ------------------------ | ----------------------------------------------- |
| `pull`  | local filesystem | cross-agent same-machine | session id / alias / `latest` / `--from <cli>`  |
| `push`  | remote git repo  | upload current session   | env-detected current session, optional `--tag`  |
| `fetch` | remote git repo  | download from remote     | tag / short id / commit prefix / `--from <cli>` |

Tagged **ARCH-1**: the public surface is exactly these three primary commands
plus a bounded supporting set (`list`, `search`, `describe`, `doctor`). Bare
invocation prints `--help`; no foot-gun aliases.

## Source / Target Resolution

Tagged **ARCH-2**: target CLI is **always implicit** — it is, by definition,
wherever the binary's stdout gets pasted. The binary never asks.

Tagged **ARCH-3**: source CLI is resolved in this priority order:

1. `--from <cli>` if explicitly passed (fastest path; **mandatory** for
   `push` without a query — see below).
2. Identifier search across all three local roots; if exactly one matches,
   that's the source.
3. If multiple match (e.g. a Claude session and a Codex session share a
   short-UUID prefix or alias):
   - TTY → interactively prompt the user to pick.
   - Non-TTY → exit 2 with a TSV candidate list on stderr.

There is no env-var detection step. The previous `detectHost()` probes
(`CLAUDECODE`, `CODEX_*`, `GITHUB_COPILOT_*` / `COPILOT_*`) admit
`UNCONFIRMED` status in their own code (legacy `detectHost()` in
`plugins/dotbabel/bin/dotbabel-handoff.mjs`), and an unreliable signal that
silently picks the wrong source is exactly the failure mode §1 is
designed to stop. Instead:

- The SKILL.md auto-trigger contract instructs Claude / Copilot to pass
  `--from <its-own-cli>` when invoking `push` without a query — the host
  LLM trivially knows which agent it is.
- Codex and scripted callers pass `--from` explicitly, or pass a
  `<query>` that resolves via step 2.
- The binary refuses `push` with no query AND no `--from` — exit 64 with
  a usage hint.

This makes the source contract single-pathed and auditable: every `push`
either has a query (which pins the source) or has `--from` (which pins
the source). Nothing is silently inferred. ARCH-10's drift-test enforces
that SKILL.md, `--help`, and `docs/handoff-guide.md` all reference
`--from` for push the same way.

## Components

| Component                                          | Role                                                    | Fate in this spec                               |
| -------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `skills/handoff/SKILL.md`                          | Natural-language trigger surface for Claude/Copilot     | Shrinks to ~45 lines; points at binary `--help` |
| `plugins/dotbabel/bin/dotbabel-handoff.mjs`      | Public CLI: argv parse, dispatch, render `--help`       | Reshaped to three primaries + four supporting   |
| `plugins/dotbabel/src/lib/handoff-remote.mjs`     | Shared lib: render, encode/decode, transport, bootstrap | Restructured around the three-verb partition    |
| `plugins/dotbabel/src/lib/handoff-scrub.mjs`      | Fail-closed scrub wrapper                               | Unchanged                                       |
| `plugins/dotbabel/scripts/handoff-resolve.sh`     | Per-CLI session resolution (UUID/alias/latest)          | Frozen substrate (§2)                           |
| `plugins/dotbabel/scripts/handoff-extract.sh`     | Per-CLI jq filters for meta/prompts/turns               | Frozen substrate (§2)                           |
| `plugins/dotbabel/scripts/handoff-scrub.sh`       | Eight-pattern perl scrubber                             | Patterns frozen (§2)                            |
| `plugins/dotbabel/scripts/handoff-description.sh` | Encode/decode `handoff:v2:…` description                | Schema reviewed in §5                           |
| `plugins/dotbabel/scripts/handoff-doctor.sh`      | Preflight checks for the git transport                  | Reduced to current single transport             |
| `docs/handoff-guide.md`                            | Long-form user guide                                    | Reconciled with binary surface, drift-tested    |
| `skills/handoff/references/*.md`                   | Per-CLI reference docs + redaction + transport          | Pruned of removed transports / flags            |

## Data Stores

| Store                                    | Role                                               | Access Pattern                                             |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `~/.claude/projects/`                    | Claude Code session JSONLs                         | Read on `pull`, `push` (current), `search`, `list --local` |
| `~/.copilot/session-state/`              | Copilot CLI session JSONL + `workspace.yaml`       | Read on `pull`, `push` (current), `search`, `list --local` |
| `~/.codex/sessions/`                     | Codex CLI rollout JSONLs (deep date-bucketed tree) | Read on `pull`, `push` (current), `search`, `list --local` |
| `$DOTBABEL_HANDOFF_REPO`                | Private GitHub repo, single transport              | Write on `push`; read on `fetch`, `list --remote`          |
| `$XDG_CONFIG_HOME/dotbabel/handoff.env` | Persisted env (`DOTBABEL_HANDOFF_REPO=…`)         | Sourced at binary start; written by self-bootstrap         |

Tagged **ARCH-4**: there is exactly **one** remote per user, named by
`$DOTBABEL_HANDOFF_REPO`. Multi-remote / multi-store is out of scope (§2).
The repo URL is persisted to a config file so `gh repo create` ceremony
happens at most once per machine.

## Remote Taxonomy (CRITICAL)

The remote git repo's branch + commit-message schema is the load-bearing
piece of the cross-machine surface. It has to make `fetch <id>` cheap,
`list --remote` scan well as the store grows, and stay stable across
schema versions.

Tagged **ARCH-5** (branch naming):

```
refs/heads/handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>
```

| Segment        | Purpose                                                                 | Source                                         |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| `handoff/`     | Namespace; `main` is reserved for store metadata, never touched by push | Hardcoded                                      |
| `<project>`    | Slug of the source repo / cwd top-level. Bucket scoping for ls-remote   | `git rev-parse --show-toplevel` then slugified |
| `<cli>`        | One of `claude`, `copilot`, `codex`. Cheap CLI filter without fetch     | Resolver detects from session path             |
| `<YYYY-MM>`    | Month bucket, UTC. Caps any one prefix at ~thousands of branches        | `created_at` ISO timestamp                     |
| `<short-uuid>` | First 8 hex of the source session UUID. Stable identifier               | Session metadata extraction                    |

Tagged **ARCH-6** (description / commit-message schema):

```
handoff:v2:<project>:<cli>:<YYYY-MM>:<short>:<host>[:<tag>]
```

The same string lands in three places:

- The git commit message (so `git log --format=%s` is the index).
- A `description.txt` file in the branch (so `gh api /repos/.../git/refs`
  responses can include it without a separate fetch).
- The Github branch's UI label (free).

`fetch` decodes this string to filter without per-branch clone. The encoder
and decoder both live in `handoff-description.sh`; both are pinned-version
(`v1` legacy decode is preserved; only `v2` encodes).

Tagged **ARCH-7** (per-branch payload):

Each `handoff/...` branch's tree is exactly:

```
handoff.md       # the rendered <handoff>...</handoff> block
metadata.json    # {cli, session_id, short_id, cwd, project, month, hostname,
                 #  created_at, scrubbed_count, tag}
description.txt  # the handoff:v2:… string, redundant for offline tooling
```

No `transcript.jsonl`, no opt-in transcript upload — the previously
documented `--include-transcript` was never wired and is removed from the
spec.

Tagged **ARCH-8** (tag layer): tags are first-class for human addressing
(per PR #107). `push --tag <label>` may attach multiple tags to a single
branch; `fetch <label>` does an exact tag match before falling back to
substring on description / branch / commit. Tag namespace is flat under
`refs/tags/` to keep `git ls-remote refs/tags/*` cheap.

Tagged **ARCH-9** (scalability targets):

- A single `git ls-remote` returns enough metadata (refs + commit messages
  via subsequent description fetch) to render `list --remote` for
  ≤ 1000 branches in < 2 s on a warm connection.
- Per-branch `fetch` is one shallow clone (`--depth 1 --branch <branch>`),
  bounded by the size of `handoff.md` + `metadata.json` (≤ 50 KB typical).
- The month-bucket prefix means even pathologically active projects don't
  spam `list --remote` output.

## External APIs / Dependencies

| Tool   | Purpose                                          | Required for                         | Fallback                                 |
| ------ | ------------------------------------------------ | ------------------------------------ | ---------------------------------------- |
| `git`  | All remote transport operations                  | `push`, `fetch`, `list --remote`     | None — required                          |
| `gh`   | Auto-bootstrap of the private repo on first push | First `push` only (interactive)      | Manual `export DOTBABEL_HANDOFF_REPO=…` |
| `jq`   | Per-CLI JSONL extraction                         | `pull`, `push`, `search`, `describe` | None — required                          |
| `perl` | Scrub-pattern engine                             | `push` (fail-closed)                 | None — required (push aborts if missing) |
| `bash` | Substrate runtime                                | All shell scripts                    | None — required                          |

No HTTP libraries, no cloud SDKs, no auth daemons. Everything goes through
either `git` (which the user has authenticated for `$DOTBABEL_HANDOFF_REPO`)
or `gh` (used once at bootstrap).

## Deployment

The binary ships via the existing `@dotbabel/dotbabel` npm package
(unchanged per §2):

- Installed binary: `~/.local/bin/dotbabel` (symlink) →
  `<node-prefix>/lib/node_modules/@dotbabel/dotbabel/plugins/dotbabel/bin/dotbabel.mjs`,
  which dispatches `handoff` to `dotbabel-handoff.mjs`.
- Skill markdown: `~/.claude/skills/handoff/SKILL.md` (symlink to the
  package's `skills/handoff/SKILL.md`); auto-loaded by Claude Code and
  Copilot CLI; not loaded by Codex.
- Shell scripts: live next to the binary in the package; resolved via
  `__dirname` from the bin entrypoint.
- Config: `$XDG_CONFIG_HOME/dotbabel/handoff.env` (default
  `~/.config/dotbabel/handoff.env`), mode 0600, written by self-bootstrap.

There is no daemon, no service, no background process. The binary runs
synchronously per invocation and exits.

## Drift-Detection Constraint

Tagged **ARCH-10**: the drift gate is phased. In Phase 1, a single test
asserts that `skills/handoff/SKILL.md` and `dotbabel handoff --help`
output agree on the list of primary commands, supporting commands, and
flags. In Phase 2, `docs/handoff-guide.md` is promoted into the same
agreement check as the third source. The enforced comparison is on the
list-of-symbols, not on prose, because SKILL.md and the docs guide are
pruned content that link into `--help` for canonical detail. §6 defines
when the Phase 2 three-source gate becomes required.

## Cross-references

- §4 elaborates the data flow for each of the three primary commands and
  documents resolver / extractor pipelines.
- §5 freezes the exact CLI surface (flag list, exit codes, output formats),
  the description schema, and the metadata.json schema.
- §6 sequences the migration: keep current verbs working until cutover,
  introduce `pull`/`fetch` aliases, retire old surface, land drift-test.
- §7 captures non-functional targets (push p95, fetch p95, scrub fail-closed
  semantics, scalability ceilings tied to ARCH-9).
- §8 covers risks: env-var probe reliability, description-schema bumps,
  user-paste-the-block UX as a deliberate non-feature.
