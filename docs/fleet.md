# Fleet: file claims, CPU lanes, and merge events across Claude Code sessions

_Last updated: v3.4.0_

When several Claude Code sessions work on one machine, they get in each
other's way in three places:

- **Files.** Two sessions change the same file on two branches, and each
  finds out only at merge time. `dotbabel fleet` gives each session a claim on
  the files it edits, and it blocks an edit by another session to a claimed
  file. The blocked session gets the name of the owner, so it can use
  `SendMessage` to agree on who changes the file.
- **CPUs.** Each full test suite starts one worker per CPU, so a few suites at
  the same time overload the machine and tests time out. [CPU lanes](#cpu-lanes)
  give each heavy test run a fixed set of CPUs, and the other runs wait for a
  free lane.
- **Merges.** One session merges a pull request, and the others keep working
  on a base that moved. The [event feed](#event-feed) records each merge and
  tells every session that claims files in that repository, with the files it
  must rebase over.

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

## Limits of the claims

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

## CPU lanes

A lane is a fixed set of CPUs. The online CPUs are split into lanes of about
5, and the last CPU stays free for shells, editors, and the sessions
themselves. A machine with 16 CPUs gets 3 lanes: CPUs 0-4, 5-9, and 10-14. A
machine with fewer than 6 CPUs keeps no CPU free.

A heavy test command waits in a queue until a lane is free, then runs pinned
to that lane with `taskset`. The first command to wait is the first to get a
lane. Tools that count the CPUs they may use then start one worker per lane
CPU: Node's `os.availableParallelism()` (vitest, jest), Go's `GOMAXPROCS`, and
`nproc`. pytest-xdist counts CPUs with psutil, which ignores the pinning, so
the lane also sets `PYTEST_XDIST_AUTO_NUM_WORKERS`. The lane is free the
moment the command exits. If the lane process dies, the kernel releases its
lock.

### Set up the lanes

`bootstrap.sh` links `fleet-shell-prefix.sh` into `~/.claude/hooks/`. Add this
block to `~/.claude/settings.json` with the absolute path of your home, then
restart each Claude Code session:

```json
{
  "env": {
    "CLAUDE_CODE_SHELL_PREFIX": "/home/you/.claude/hooks/fleet-shell-prefix.sh"
  }
}
```

Claude Code then runs every shell command it starts through the wrapper:
Bash tool calls, hook commands, the status line, and MCP server startup. The
wrapper sends a Bash tool call to a lane only when it runs a heavy test
command:

- `npm`, `pnpm`, `yarn`, or `bun` with `test`, or a script whose name starts
  with `test`, `coverage`, `attest`, `mutation`, or `e2e`
- `vitest`, `jest`, `bats`, `playwright test`, `stryker run`, and `node --test`
- `go test`, `cargo test`, `make test` or `make check`, `mvn test` or
  `mvn verify`, and `gradle test` or `gradle check`
- `pytest` (also through `python -m`, `uv run`, and `poetry run`), `tox`, and
  `nox`
- `dotbabel local-attest` and `dotbabel quality check`

Watch modes (`vitest --watch`, `npm run test:watch`) never go to a lane,
because they never end. Every other command, and every hook and MCP server,
runs at once with the same shell and flags that Claude Code uses. The
command text does not change, so your permission rules match as before.

### Turn the lanes off

- **At once, for every session:** `touch ~/.local/state/dotbabel/fleet/lanes.off`.
  Remove the file to turn the lanes on again. No restart is necessary.
- **For the sessions you start next:** set `DOTBABEL_FLEET_LANES=off` in their
  environment, or remove the `CLAUDE_CODE_SHELL_PREFIX` entry and restart.

### Lane commands

| Command                                       | Purpose                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| `dotbabel fleet lanes [--json]`               | Show each lane, its holder, and the commands that wait |
| `dotbabel fleet lane [--name <label>] -- cmd` | Run any command in a lane, also from your own terminal |

A holder shows a short label (such as `npm test`), the session name, and the
directory. The lane files never hold the command line, because commands can
carry secrets.

### Lane settings

| Variable                    | Effect                                                            |
| --------------------------- | ----------------------------------------------------------------- |
| `DOTBABEL_FLEET_LANES`      | `off`, or explicit lanes as CPU lists joined by `;`: `0-4;5-9`    |
| `DOTBABEL_FLEET_LANE_COUNT` | The number of lanes in the automatic layout                       |
| `DOTBABEL_FLEET_NCPU`       | The CPU count for the automatic layout (default: the online CPUs) |

### Limits of the lanes

- **Linux only.** A lane needs `flock` and `taskset` (util-linux). Without
  them, or with bash older than 4, the command runs at once, with no lane.
- **Only the command text is read.** A script that starts a test runner, such
  as `./run-tests.sh`, is not seen. Run it with `dotbabel fleet lane --`. A
  heredoc stops the reading, so a test command after a heredoc in the same
  Bash call runs with no lane.
- **The wrapper reads Claude Code's internal form of a Bash call**
  (`eval '<command>' && pwd -P >| <file>`). If a new Claude Code version
  changes that form, heavy commands run with no lane. No command breaks.
- **Containers are outside the lane.** testcontainers and `docker run` start
  processes under the Docker daemon. Give them `--cpuset-cpus` yourself.
- **A hung test holds its lane** until it exits. `dotbabel fleet lanes` shows
  which session holds it.
- **`CLAUDE_CODE_SHELL_PREFIX` has one slot.** To use another wrapper as well,
  make one wrapper call the other.
- **Cost.** Every command pays for one bash start, which is not measurable
  next to Claude Code's own login shell. A command that names a test tool and
  a test verb also starts Node for the check, about the time of a bare
  `node -e ''`.

## Event feed

When a session runs `gh pr merge`, the `post-tool` hook asks `gh pr view`
whether the pull request merged. If it did, the hook records one event: the
repository, the pull request, the merge commit, the base branch, and the
changed files. The merging session also releases its own claims on the merged
branch, because that work has landed.

Every other session reads the events it has not seen on its next tool call
(`post-tool`) or its next prompt (`prompt`, for a session that waits for you).
A session gets a message only for a repository where it holds claims:

- If the merge changed files that the session claims, the message names them
  and tells the session to rebase onto the new base before it pushes or
  merges.
- Otherwise, one line says that the base moved and that none of the changed
  files are claimed there.

A session does not get merges from before its first hook call. Events are kept
for 7 days.

### Set up the event feed

Add these blocks to `~/.claude/settings.json`, next to the claim hooks, then
restart each Claude Code session:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/fleet-guard.sh post-tool",
            "timeout": 20
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.claude/hooks/fleet-guard.sh prompt",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

The hook runs after every tool call, so `fleet-guard.sh` decides in bash
whether there is work. It starts Node only for a Bash call that runs
`gh pr merge`, or when an event is newer than the session's seen marker. Each
other call costs about 3 ms.

### Event commands

| Command                                        | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `dotbabel fleet events [--all] [--json]`       | Show the merges of the last 7 days, newest first            |
| `dotbabel fleet event --pr <N> [--repo <o/r>]` | Record a merge made outside Claude Code, such as on the web |

A merge is recorded once per repository, pull request, and merge commit, so
running `event` after the hook recorded the same merge does nothing.

### Limits of the event feed

- **Only a merge that a session runs is seen.** A merge in the GitHub web
  interface or by another tool is not recorded until someone runs
  `dotbabel fleet event --pr <N>`.
- **The overlap comes from claims.** A file that a session changed without a
  claim (with Bash, or before the claims existed) does not count, and neither
  do the shared files (lockfiles, `CHANGELOG.md`) that are never claimed.
- **Delivery waits for activity.** An idle session learns about a merge when
  you send it the next prompt.
- **`gh` must be signed in** in the merging session, because the event comes
  from `gh pr view`.
