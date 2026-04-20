# Handoff store schema (v2 — v0.10.0+)

_Last updated: v0.10.0_

Authoritative reference for the layout of the private git repository
that `dotclaude handoff` uses as its remote transport. Consumed by the
binary (enforced on push / surfaced on pull) and by humans browsing the
repo in the GitHub / GitLab / Gitea UI.

## TL;DR

- Each handoff is a branch: `handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>`.
- `main` holds two files: `.dotclaude-handoff.json` (the schema pin) and
  a README. `push` / `pull` / `remote-list` / `prune` never touch `main`.
- The binary refuses to push to a store whose pin doesn't match; run
  `dotclaude handoff init` once per store to stamp it.

## Branch namespace

```
handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>
```

Segments (all lowercase, `[a-z0-9-]` only, slugified via
`handoff-description.sh`'s `slugify()`):

| Segment        | Source                                                                                 |
| -------------- | -------------------------------------------------------------------------------------- |
| `<project>`    | `projectSlugFromCwd(meta.cwd)` — git-repo basename, or cwd basename outside a git repo |
| `<cli>`        | `claude`, `copilot`, or `codex`                                                        |
| `<YYYY-MM>`    | UTC month at push time (`monthBucket(now)`)                                            |
| `<short-uuid>` | First 8 hex chars of the session UUID                                                  |

Each branch carries three files at the root:

```
handoff.md           # the rendered <handoff> block (Markdown)
metadata.json        # cli, session_id, cwd, project, month, hostname,
                     # scrubbed_count, schema_version, tag, created_at
description.txt      # the encoded description string (also the commit
                     # message on the branch's first + only commit)
```

## Schema pin (`.dotclaude-handoff.json` on main)

```json
{
  "schema_version": "2",
  "created_at": "2026-04-20T01:15:00Z",
  "layout": "branch-per-handoff",
  "branch_format": "handoff/<project>/<cli>/<YYYY-MM>/<short-uuid>",
  "description_format": "handoff:v2:<project>:<cli>:<YYYY-MM>:<short-uuid>:<hostname>[:<tag>]",
  "created_by": "@dotclaude/dotclaude@0.10.0"
}
```

The binary shallow-clones `main` on every `push` to read this file.
Behaviour:

- **Pin present, version matches** → proceed.
- **Pin missing** (empty repo, or `main` lacks the file) → exit 2 with
  "run `dotclaude handoff init` first."
- **Pin present, version mismatches** → exit 2 with "upgrade
  `@dotclaude/dotclaude` on every machine before reinitialising."

## Description schema

The `description.txt` file — which also serves as the branch's commit
message — is a colon-separated string:

```
handoff:v2:<project>:<cli>:<YYYY-MM>:<short-uuid>:<hostname>[:<tag>]
```

Encoded by `plugins/dotclaude/scripts/handoff-description.sh encode`
(consult its `--help`). Decoded by the same script's `decode`
sub-command, which emits JSON with a `"schema"` field (`"v1"` or
`"v2"`) so callers can render legacy markers in UI tables.

### Legacy v1 (read-only)

Stores initialised by v0.9.0 or earlier use:

```
handoff/<cli>/<short-uuid>             # branch
handoff:v1:<cli>:<short>:<project>:<hostname>[:<tag>]   # description
```

v0.10.0+ still **reads** v1 branches so `pull` and `remote-list` work
across a staged rollout, but **writes** always emit v2. A future
`dotclaude handoff migrate` sub-command will rename legacy branches.

## Why this layout

1. **Project scoping.** Handoffs from five personal side projects
   mixed with three work repos made the v0.9.0 flat namespace
   unscrollable. Grouping by project lets `remote-list --project X`
   return a focused view.
2. **Age bucketing.** `<YYYY-MM>` turns pruning into a pattern match
   (`git ls-remote | grep 'handoff/*/*/2024-' | xargs push --delete`).
   No need to decode every branch to check its date.
3. **Enforced schema.** Without a server-side pin, two machines at
   different versions silently produce incompatible branches. The
   pin lets the binary fail fast rather than emit data the reader
   can't decode.
4. **Branch-per-handoff stays.** Every alternative we considered
   (tree on `main`, per-project repos, encrypted blobs) added
   complexity for no gain at the expected scale (O(100) handoffs per
   user per year). Force-pushing a single branch is cheap,
   conflict-free, and browsable.

## Operational sub-commands

All touch only `handoff/...` branches; `main` is reserved for the pin:

- `dotclaude handoff init` — idempotent; writes `.dotclaude-handoff.json`
  and a README. Skips README when one already exists.
- `dotclaude handoff push [<query>]` — creates a new v2 branch.
- `dotclaude handoff pull [<handle>]` — fetches one back.
- `dotclaude handoff remote-list` — enumerates branches.
- `dotclaude handoff doctor` — verifies the pin + transport.
- `dotclaude handoff prune` — (PR B) deletes stale branches.
- `dotclaude handoff migrate` — (PR C) renames v1 branches to v2.

## Editing `main` by hand

Don't. The binary tolerates extra files on `main`, but operational
commands never read them. If you want to add project notes, the README
is the right place — the binary leaves it untouched once written.
