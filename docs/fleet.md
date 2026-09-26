# Fleet: file claims across Claude Code sessions

_Last updated: v3.4.0_

When several Claude Code sessions work in one repository, two of them can
change the same file on two branches. Each finds out only at merge time.
`dotbabel fleet` gives each session a claim on the files it edits, and it
blocks an edit by another session to a claimed file. The blocked session gets
the name of the owner, so it can use `SendMessage` to agree on who changes the
file.

## How it works

1. **The first edit claims the file.** When a session edits a file in a
   governed repository (one with a `.dotbabel.json` at the worktree root), the
   `PreToolUse` hook records a claim for that session. The claim holds the
   path, the branch, the worktree, and the time.
2. **An edit to a claimed path is denied.** When another live session edits
   the same path, the hook returns a `PreToolUse` `deny`. The reason names the
   owner and tells the blocked session to `SendMessage` it, to continue with
   other work, and not to change the file in another way.
3. **The user decides a long block.** If the same owner still blocks the path
   15 minutes after the first deny, the next attempt returns `ask`, so the user
   sees a permission prompt.
4. **A new session sees the claims.** The `SessionStart` hook prints the live
   claims of the session's repository into its context. It prints nothing when
   there are no claims.

The same path in two worktrees is one file: a claim made in
`.claude/worktrees/a/docs/hooks.md` blocks an edit to `docs/hooks.md` in the
main checkout. All worktrees and all clones of one repository share one
ledger, because the ledger key is the normalized `origin` URL
(`github.com/owner/repo`). A repository without an `origin` gets a key from
its git directory.

A claim ends when:

- its owner releases it with `dotbabel fleet release`,
- the owner's Claude Code process exits, or
- the worktree the claim was made in no longer exists.

Some edits never claim and are never denied:

- Git-ignored files.
- Shared files that sessions change as a side effect of other work: lockfiles
  (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `uv.lock`,
  `poetry.lock`, `Cargo.lock`) and `CHANGELOG.md`, at any depth. `package.json`
  is not shared on purpose: two sessions that change its scripts or
  dependencies must talk.
- Every file in a repository without a `.dotbabel.json`.

When two sessions claim one path at the same moment, both write their claim,
read the ledger again, and the later claim yields. Both sides compute the same
order.

## Set up

`bootstrap.sh` links `fleet-guard.sh` into `~/.claude/hooks/`. Add these
blocks to `~/.claude/settings.json`, then restart each Claude Code session:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/fleet-guard.sh pre-edit",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/fleet-guard.sh session-start",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

## Commands

Run these from a Claude Code session (the Bash tool). The command finds its
own session by its process tree.

| Command                                      | Purpose                                                   |
| -------------------------------------------- | --------------------------------------------------------- |
| `dotbabel fleet board [--json]`              | Show the claims in the current repository                 |
| `dotbabel fleet claim <pattern>... [--note]` | Claim paths or globs before large work                    |
| `dotbabel fleet release <pattern>...`        | Release this session's claims that match                  |
| `dotbabel fleet release --all`               | Release every claim this session holds in the repository  |
| `dotbabel fleet prune`                       | Remove the claim records of sessions that exited          |
| `dotbabel fleet hook <event>`                | The hook entry that `fleet-guard.sh` runs (JSON on stdin) |

Patterns are relative to the repository root. A bare path also covers
everything below it, so `docs` covers `docs/hooks.md`. `**` and `*` are globs.
`claim` refuses a pattern that overlaps a claim of another live session, and
lists the owners to message. `release docs/a.md` does not release a broader
claim such as `docs/**`.

Release your claims when your work lands:

```bash
dotbabel fleet release --all
```

## Configuration

In `.dotbabel.json`:

```json
{
  "fleet": {
    "mode": "off",
    "shared": ["docs/generated/**"],
    "escalate_after_minutes": 15
  }
}
```

| Key                      | Default | Effect                                              |
| ------------------------ | ------- | --------------------------------------------------- |
| `mode`                   | on      | `"off"` turns both hooks off for the repository     |
| `shared`                 | `[]`    | Extra globs that are never claimed or denied        |
| `escalate_after_minutes` | `15`    | Minutes of blocks before `ask`; `0` means never ask |

Environment variables take precedence:

| Variable                          | Effect                                                    |
| --------------------------------- | --------------------------------------------------------- |
| `DOTBABEL_FLEET_MODE=off`         | Turns the hooks off for every repository                  |
| `DOTBABEL_FLEET_ESCALATE_MINUTES` | Overrides `escalate_after_minutes`                        |
| `DOTBABEL_FLEET_STATE_DIR`        | Ledger root (default `$XDG_STATE_HOME/dotbabel/fleet`)    |
| `CLAUDE_CONFIG_DIR`               | Where Claude Code keeps `sessions/` (default `~/.claude`) |

## Limits

- **Only the edit tools are guarded.** `Edit`, `Write`, `MultiEdit`, and
  `NotebookEdit` claim and can be denied. A Bash command that writes a file
  (`sed -i`, a redirect) is not seen.
- **The session registry is internal Claude Code state.** The hooks read
  `~/.claude/sessions/<pid>.json` to identify sessions. If that format
  changes, the hook finds no session and allows every edit. It never blocks
  work because of state it cannot read.
- **The claims are advisory.** A session can delete the ledger. The deny
  reason tells it not to.
- **Liveness comes from `/proc` on Linux.** Other systems use signal 0, which
  cannot detect a reused process id.
- **Two globs overlap by their directory prefixes.** `claim` can refuse
  `src/*.js` next to a peer's `src/*.css`. A false refusal costs one message.
- **Each guarded edit starts Node.** At a load average of 42 on 16 CPUs, one
  hook call took 0.6 to 0.8 seconds, most of it Node startup.
- **Git 2.31 or later** is necessary (`rev-parse --path-format`).
