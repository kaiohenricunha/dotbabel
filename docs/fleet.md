# Fleet: file claims, CPU lanes, merge events, and the merge token across Claude Code sessions

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
  must rebase over. The [merge token](#merge-token) lets only one session at a
  time rebase, attest, and merge in a repository.

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
| `mode`                   | on      | `"off"` turns the hooks off for the repository      |
| `shared`                 | `[]`    | Extra globs that are never claimed                  |
| `escalate_after_minutes` | `15`    | Minutes of blocks before `ask`; `0` means never ask |
| `token_idle_minutes`     | `60`    | Minutes before an unused merge token is free        |
| `heavy`                  | `[]`    | More commands that run in a CPU lane (see below)    |

Environment variables take precedence:

| Variable                            | Effect                                                    |
| ----------------------------------- | --------------------------------------------------------- |
| `DOTBABEL_FLEET_MODE=off`           | Turns the hooks off for every repository                  |
| `DOTBABEL_FLEET_ESCALATE_MINUTES`   | Overrides `escalate_after_minutes`                        |
| `DOTBABEL_FLEET_TOKEN_IDLE_MINUTES` | Overrides `token_idle_minutes`                            |
| `DOTBABEL_FLEET_STATE_DIR`          | Ledger root (default `$XDG_STATE_HOME/dotbabel/fleet`)    |
| `CLAUDE_CONFIG_DIR`                 | Where Claude Code keeps `sessions/` (default `~/.claude`) |

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
7, and the last CPU stays free for shells, editors, and the sessions
themselves. A machine with 16 CPUs gets 2 lanes: CPUs 0-7 and 8-14. A machine
with 8 or more usable CPUs always gets at least 2 lanes, and a machine with
fewer than 6 CPUs keeps no CPU free. The
[lane size benchmark](./experiments/2026-09-27-cpu-lane-size.md) measured 2
lanes of 7-8 against 3 lanes of 5 on a 16-CPU machine.

A heavy test command waits in a queue until a lane is free, then runs pinned
to that lane with `taskset`. The first command to wait is the first to get a
lane. Tools that count the CPUs they may use then start one worker per lane
CPU: Node's `os.availableParallelism()` (vitest, jest), Go's `GOMAXPROCS`, and
`nproc`. pytest-xdist counts CPUs with psutil, which ignores the pinning, so
the lane also sets `PYTEST_XDIST_AUTO_NUM_WORKERS`. The lane is free the
moment the command exits. If the lane process dies, the kernel releases its
lock.

**Lending.** A test run of a session that works alone is not limited to one
lane. With `DOTBABEL_FLEET_LEND=auto`, the default, a command takes every free
lane, so all CPUs but the free one, when no other Claude Code session is busy
and no command waits. Otherwise it takes one lane. Only sessions with the
status `busy` count; `idle`, `waiting`, and `shell` sessions do not. A command
whose own session is not in `~/.claude/sessions/` counts every busy session,
so it does not lend. The cost: a session that becomes busy during a lent run
waits until that run ends.

With a number, `DOTBABEL_FLEET_LEND=2` for example, a command takes up to that
many free lanes. It never takes the last free lane, so the next command still
starts at once, and it takes only one lane while another command waits. On 4
lanes, 3 commands in a row get 2, 1, and 1 lanes. `DOTBABEL_FLEET_LEND=1` turns
lending off.

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
- the commands that the repository lists in `fleet.heavy`

A repository names its own heavy commands in its `.dotbabel.json`:

```json
{ "fleet": { "heavy": ["./scripts/run-tests.sh", "npm run ci"] } }
```

An entry matches a command whose first words are the entry's words. An entry
whose first word has no `/` matches that word in any directory, so
`run-tests.sh` matches `./run-tests.sh` and `scripts/run-tests.sh`. The lane
holder shows the entry as its label. The wrapper reads the nearest
`.dotbabel.json` from the command's directory up to the git top level, without
starting a process. This adds about 0.4 ms to each Bash call in a directory
with a `.dotbabel.json`. It starts Node only when the command contains the
first word of an entry.

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
| `DOTBABEL_FLEET_LANE_WIDTH` | CPUs per lane in the automatic layout (default `7`, see below)    |
| `DOTBABEL_FLEET_LEND`       | `auto` (default), a lane count, or `1` to turn lending off        |
| `DOTBABEL_FLEET_NCPU`       | The CPU count for the automatic layout (default: the online CPUs) |

The automatic layout makes `round(usable CPUs / width)` lanes, at least 2 from
8 usable CPUs, and gives the CPUs left over one each to the first lanes. On 16
CPUs, width 7 (the default) gives `0-7;8-14`, width 5 gives `0-4;5-9;10-14`,
and width 4 gives `0-3;4-7;8-11;12-14`.

### Limits of the lanes

- **A lent lane is not taken back.** A command that took 2 lanes keeps both
  until it ends, even when other commands start to wait.
- **Linux only.** A lane needs `flock` and `taskset` (util-linux). Without
  them, or with bash older than 4, the command runs at once, with no lane.
- **Only the command text is read.** A script that starts a test runner, such
  as `./run-tests.sh`, is not seen unless the repository lists it in
  `fleet.heavy`. Otherwise run it with `dotbabel fleet lane --`. A heredoc
  stops the reading, so a test command after a heredoc in the same Bash call
  runs with no lane.
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

A session does not get merges from before it started. On its first hook call,
the events recorded before its start time (`startedAt` in its Claude Code
session registry entry) count as seen, and the later ones are delivered. So a
merge that a running session lives through reaches it, also when that merge is
the first event ever recorded. Without a start time, the first hook call counts
every earlier event as seen. Events are kept for 7 days.

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

## Fair CPU share

Lanes cover test runs. Builds, scripts, and servers run outside the lanes, and
without CPU weights the kernel shares the CPUs thread by thread. A session with
48 busy threads then gets 12 times the CPU of a session with 4. The fair CPU
share gives each Claude Code session's systemd scope the same `CPUWeight`, so
the scopes share the CPUs as groups. A session that works alone still uses all
CPUs; a light session keeps its CPUs next to a heavy one. On a 16-CPU machine,
4 busy threads next to 48 got 1.05 CPUs without the weights and 3.37 with
them.

The `session-start` hook gives its own session scope `CPUWeight=100` with
`systemctl --user set-property --runtime`, in every repository. It acts only on
a `*.scope` in the user manager's `app.slice` (tmux, for example, makes one per
pane), and it does nothing when systemd is missing, as on macOS. For sessions
that started before the hook, run once:

```bash
dotbabel fleet cpu-share            # set the weight on every live session's scope
dotbabel fleet cpu-share --status   # only show each session and its scope
```

| Variable                    | Effect                                                     |
| --------------------------- | ---------------------------------------------------------- |
| `DOTBABEL_FLEET_CPU_WEIGHT` | The weight of each session scope (default `100`), or `off` |

The weights last until the scope ends or the next boot. To undo them sooner,
run `systemctl --user set-property --runtime <scope> CPUWeight=` for each
scope, or set `DOTBABEL_FLEET_CPU_WEIGHT=off` and start new sessions. systemd
turns the `cpu` controller of `app.slice` off by itself when no scope with a
weight is left. Docker containers run in `system.slice`, outside the sessions;
at the top level, `system.slice` and `user.slice` already share the CPUs 50/50
under load. The lane size benchmarks ran without the fair share.

## Merge token

Two pull requests can each pass their checks against the same old base, and
then conflict or break the base once both merge. The merge token prevents
this: in each repository, only one session at a time rebases onto the base,
attests, and merges.

A session takes the token of a governed repository when it runs one of these
commands in a Bash call:

- a rebase onto a base branch: `git rebase origin/main`, `git rebase --onto
origin/main ...`, or `git pull --rebase origin main`. The base branches are
  `main`, `master`, and the branch that `origin/HEAD` names.
- `dotbabel local-attest`, also through `npx` or `node .../dotbabel.mjs`
- `gh pr merge`. With `--repo`, the token of that repository counts, also
  from a directory outside its checkout.

While another live session holds the token, such a command gets a
`PreToolUse` `deny`. The reason names the holder to `SendMessage`, and says
when the token frees itself. A shared file (a lockfile, `CHANGELOG.md`, or a
`shared` glob) is never claimed, and an edit of one is denied while another
session holds the token.

The token is free again when:

- the holder's `gh pr merge` is recorded (see the [event feed](#event-feed)),
- the holder's process exits,
- the holder runs no token command for 60 minutes (`token_idle_minutes`); the
  end of a holder's `local-attest` counts as use, or
- the holder runs `dotbabel fleet token release`.

### Set up the merge token

Add this block to the `PreToolUse` list in `~/.claude/settings.json`, then
restart each Claude Code session:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "$HOME/.claude/hooks/fleet-guard.sh pre-bash",
      "timeout": 10
    }
  ]
}
```

`fleet-guard.sh` starts Node only for a command that contains `rebase`,
`local-attest`, or `gh pr merge`. The event feed hooks must also be set up,
so that a recorded merge frees the token.

### Token commands

| Command                         | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `dotbabel fleet token [--json]` | Show who holds the token of this repository              |
| `dotbabel fleet token take`     | Take the token before a manual rebase, attest, and merge |
| `dotbabel fleet token release`  | Give the token back                                      |

`take` exits 1 and names the holder when a live peer holds the token.
`release` exits 1 when this session holds no token. `board` also shows the
holder.

### Limits of the merge token

- **Only the command text is read.** A script that rebases or merges, a merge
  in the GitHub web interface, and a rebase that names no base branch take no
  token.
- **The token does not wait.** A blocked session tries again later; nothing
  queues it.
- **An idle hour frees the token** even when its holder still means to merge.
  The next token command takes it again if it is free.
