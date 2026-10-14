# Hooks

_Last updated: v4.0.0_

dotbabel ships eight Claude Code hooks in `plugins/dotbabel/hooks/`. `bootstrap.sh`
symlinks all of them into `~/.claude/hooks/`.

| Hook                         | Event                                                                        | Fires                                                                                       | Purpose                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `guard-destructive-git.sh`   | `PreToolUse`                                                                 | before each Bash call                                                                       | Asks the user before a destructive git command runs                                                                                  |
| `guard-criteria-evidence.sh` | `PreToolUse`                                                                 | before each Bash call                                                                       | Blocks a hand-written evidence marker (criteria, attestation, review)                                                                |
| `check-on-write.sh`          | `PostToolUse`                                                                | after each file edit                                                                        | Per-file syntax check of the edited file                                                                                             |
| `check-on-stop.sh`           | `Stop`                                                                       | once per turn                                                                               | Project-wide checks when the build graph is coherent                                                                                 |
| `fleet-guard.sh`             | `PreToolUse`, `SessionStart`, `PostToolUse`, `UserPromptSubmit`              | before each file edit and Bash call, at session start, after each tool call, at each prompt | Blocks an edit to a file that another live session claims, holds the merge token, and reports merges                                 |
| `fleet-shell-prefix.sh`      | `CLAUDE_CODE_SHELL_PREFIX`                                                   | around every shell command                                                                  | Sends heavy test commands to a free CPU lane                                                                                         |
| `task-context.sh`            | `SessionStart`                                                               | at session start                                                                            | Prints the open tasks of the worktree: goal, done-when checks, phase, pending items, decisions, and whether each is ready or blocked |
| `yolo.sh`                    | `UserPromptExpansion`, `PermissionRequest`, `UserPromptSubmit`, `SessionEnd` | at `/yolo`, at each permission dialog, at each prompt, at session end                       | Approves the permission dialogs of one session while its `/yolo` grant lives, except a denylist                                      |

> **Installed is not enabled.** `bootstrap.sh` puts the files in `~/.claude/hooks/`,
> but it never edits `settings.json`. Nothing runs until you register it yourself.
> See [Registering a hook](#registering-a-hook). `dotbabel doctor` lists the
> registered hooks with their events, and warns for each shipped hook that no
> settings file registers. It reads the user, project, and local settings files.
> It never fails the run, because an unregistered hook is a valid choice.

---

## `guard-criteria-evidence.sh`

Blocks any Bash call that writes a `<!-- dotbabel-criteria verified-sha=… -->`
marker by hand, and allows `dotbabel criteria verify --pr <N> --post`, which is
the sanctioned writer.

The merge gate believes that marker when a trusted author posted it. An agent
driving `gh` **is** a trusted author, and the gate cannot tell a marker the tool
derived from a real criteria run from one an agent typed — the bytes are
identical. The distinction only exists at the moment the command is issued, so
that is where it has to be enforced. Without this hook, "post the evidence
comment" is something an agent can simply do, and the evidence chain collapses
to the agent's own assertion.

**Scope, stated plainly.** The hook looks for a guarded line in the command
text. It also reads each file that the command names in one of these forms:

- `--body-file <path>` or `--body-file=<path>`.
- `-F <path>`, when the value has no `=`. `gh pr comment` and `gh pr create`
  read this value as the body file.
- `--input <path>`, the request body of `gh api`. The value `-` reads stdin, so
  the hook cannot check it and skips it.
- `-F body=@<path>` or `--field body=@<path>`.

The value can be in single or double quotes and can contain spaces. The hook
expands a leading `~/`, `$HOME`, `${HOME}`, `$TMPDIR` or `${TMPDIR}` from its
own environment, and it evaluates nothing. It resolves a relative path against
the `cwd` field of the hook input. It skips a path that it cannot resolve or
read, because a legitimate command can name a file through any variable.

The hook does **not** stop an agent that assembles the marker out of band: a
path through another shell variable, text split across shell words, variables
or a heredoc, text encoded as base64 or a JSON escape, or a body written with
the Write tool (which this `PreToolUse` matcher does not cover). Those are open
by construction: no textual guard on a single Bash call can close them. Treat
this as a guardrail against the casual path, not a security boundary. The
durable fix is for the gate to stop trusting comment text — an unforgeable
value derived from the run, or a check-run artifact the agent cannot author.

It guards three evidence families, each with its own sanctioned writer:

| Family      | Sanctioned writer                            | Read by                                    |
| ----------- | -------------------------------------------- | ------------------------------------------ |
| criteria    | `dotbabel criteria verify --pr <N> --post`   | the merge gate                             |
| attestation | `dotbabel local-attest --pr <N>`             | the merge gate and CI                      |
| review      | `dotbabel pr-stack review-complete --pr <N>` | `/pr-conductor`, to skip a finished review |

The hook also blocks the payload line of each family, because the gate refuses a
marker without it as invalid. For criteria, this covers the plain form and the
compressed `z1:` form. Each payload entry starts with `<!--` and one space, as
each reader requires. So a read-only search for the bare token, such as `grep`
or `git log -S`, is not blocked.

The `post-pr-review` receipt is guarded too, because the review-complete writer
reads it to believe a review ran. The per-finding idempotency marker on ordinary
review comments is deliberately not guarded: no skip decision rests on it.

Bypass only after the user confirms, by exporting the variable in the
environment Claude Code itself was started with:

```bash
BYPASS_CRITERIA_EVIDENCE_GUARD=1 claude
```

A `VAR=1 <command>` **prefix does not work**. The prefix is applied by the shell
the Bash tool spawns _after_ hooks run, while the hook executes earlier with
Claude Code's own environment — so the variable the hook reads is still unset
and the call is blocked. That also means an agent cannot self-bypass per call,
which is the property worth keeping.

## Why two checkers instead of one

`check-on-write.sh` runs per file edit. It only does checks that need **no build
graph** — a parser, and nothing more.

`check-on-stop.sh` runs once per turn. It runs the checks that **do** need the
build graph: type checking, `go vet`, `cargo check`.

The split is about correctness, not speed. Mid-refactor, a single edit
legitimately leaves the build graph broken — you change a signature in `a.ts`
and `b.ts` is wrong until the next edit. A project-wide typecheck at that moment
reports true but useless errors about work the model is one step from doing.
`Stop` fires after the edits, when the graph is supposed to be coherent.

### What each one covers

`check-on-write.sh` — shell, go (`gofmt -e`), python (`ruff --select E9`),
js (`node --check`, `.mjs`/`.cjs` only), R.

`check-on-stop.sh` — typescript (`tsc --noEmit`), go (`go vet`),
rust (`cargo check`), java (`mvn compile`), c# (`dotnet build`).

Languages deliberately absent from the per-file hook, because no honest per-file
check exists for them: `.ts` (`node --check` reports a syntax error on the valid
`const x: number = 1`), `.rs`, `.java`, `.cs`, `.tsx`/`.jsx`/bare `.js` (Node's
parser cannot read JSX), and C/C++ (`gcc -fsyntax-only` still runs the
preprocessor, so an absolute `#include` reads arbitrary local files into the
model's context). Each is covered by `check-on-stop.sh` instead, where a real
build gives a correct answer.

Both hooks stay silent on style. Only a hard error is reported.

The hooks are low-cost feedback, not the full quality policy.
Run `dotbabel quality check --profile fast` for an explicit changed-code check.
Run the `pr` or `deep` profile for tests, coverage, and configured analyzers.
Unlike fail-open hooks, the quality command reports unavailable tools and uses documented exit codes.

---

## `fleet-guard.sh`

Stops two concurrent Claude Code sessions from changing the same file of one
repository. A session's first edit to a file in a governed repository claims
it. An edit by another live session to a claimed path gets a `PreToolUse`
`deny` whose reason names the owner to `SendMessage`. After 15 minutes of
blocks by the same owner, the next attempt is an `ask`, so the user decides.
At `SessionStart`, the hook prints the live claims of the session's
repository. After a `gh pr merge`, the `PostToolUse` entry records the merge,
and the `PostToolUse` and `UserPromptSubmit` entries tell every other session
that claims files in that repository. Before a Bash call that rebases onto
the base, runs `dotbabel local-attest`, or runs `gh pr merge`, the `pre-bash`
entry takes the repository's merge token, and denies the call while another
live session holds it.

The script only locates and runs `bin/dotbabel-fleet.mjs`, and it fails open:
without Node, or on any error, the edit goes ahead. Register it with five
entries: `pre-edit` on the edit tools, `pre-bash` on `Bash`, `session-start`,
`post-tool` on every tool, and `prompt`. At `session-start` it also gives the
session's systemd scope an equal CPU weight (the fair CPU share). See
[fleet.md](./fleet.md) for the settings block, the claim rules, and the
limits.

---

## `task-context.sh`

Prints the open [tasks](./cli-reference.md#dotbabel-task) of the session's
worktree into its context at session start. A task is the contract and the
state of work that has no spec: a goal and the `done_when` checks, fixed
before execution, plus the phase, the decisions, and the pending items that a
session records with `dotbabel task update`. With this hook, a new or resumed
session reads where the work stands instead of a retelling of it.

The hook prints nothing when the worktree has no open task. It prints at most
five tasks, the most recently updated first. Each task is marked `ready` when
every dependency it names is satisfied, or `blocked by:` the references it
waits on, with the state of each, as `dotbabel task next` reports them for
the whole clone. It bounds each list (five `done_when` checks, five pending
items, five blocking references, the last three decisions), clips each field,
and keeps the whole block under 6,000 characters; a task that does not fit is
shortened to its slug and phase. It fails open: without Node, without the bin,
or on any error, the session starts as usual; when only the other worktrees
cannot be read, it prints the tasks without their state.

Warning: the text in a task can come from an issue anyone can write, and this
hook replays it into every later session in the worktree. So the block is
framed as recorded data between delimiters, with a line that tells the session
not to follow directives inside it. Read it as a record of earlier work, never
as instructions.

Register it with one `SessionStart` entry:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/task-context.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

**Scope.** Tasks live in `<git-dir>/dotbabel/tasks/<slug>.json`, so they never
appear in `git status`. Each worktree has its own tasks. A task survives a
context reset, a crash, and a new session in that worktree. It does not travel
to another machine, and it goes away when the worktree is removed. Use
[`/handoff`](./handoff-guide.md) to move a session to another machine; a task
complements it and does not replace it.

---

## `yolo.sh`

The hook behind the [`/yolo`](../skills/yolo/SKILL.md) skill: a temporary,
per-session autonomy mode. The owner types `/yolo <scope>` once. Until the
scope is done, the session asks nothing for the work in the scope. The mode
reverts by itself at `/yolo off`, at the expiry, or at the end of the session.
It never edits a settings file, and with no live grant the behavior is the same
as without the hook.

```text
/yolo finish milestone 1.5 phase 7, merge each PR when green
/yolo --for 2h fix the flaky fleet test
/yolo off
```

It has four entries:

| Argument      | Event                 | Does                                                                                         |
| ------------- | --------------------- | -------------------------------------------------------------------------------------------- |
| `grant`       | `UserPromptExpansion` | Writes or removes the grant, and tells the skill the grant exists                            |
| `permission`  | `PermissionRequest`   | While the grant lives, approves the permission dialog, except for the denylist               |
| `prompt`      | `UserPromptSubmit`    | Shows the owner a live grant at each prompt, or warns of a grant that no typed `/yolo` backs |
| `session-end` | `SessionEnd`          | Removes the grant of the session                                                             |

**The grant.** `$XDG_STATE_HOME/dotbabel/yolo/<session_id>.json` (default
`~/.local/state/dotbabel/yolo/`, override with `DOTBABEL_YOLO_STATE_DIR`), mode
`0600` in a `0700` directory. It holds the scope, `merge` (true or false), and
the start and expiry in epoch seconds. The lifetime is 4 hours by default;
`--for 2h` or `--for 90m` changes it, up to 24 hours. Merges are in the scope
when the scope text says "merge" and does not say "do not merge", "don't
merge", "no merge", or "without merging". `--merge` and `--no-merge` set it
explicitly. A hook writes the grant because a skill cannot learn its own
session id, and the `UserPromptExpansion` input carries `session_id`,
`command_name`, and `command_args`.

**A grant must be typed.** The grant file alone does not make the gate
approve. The PermissionRequest input carries `transcript_path`, and the gate
reads the last `/yolo` line in the session's transcript. That line must be a
prompt the owner typed: a `user` line of this `sessionId` whose content is a
string that starts with the command markup, with `origin.kind` `human`, and
not from a subagent (`isSidechain`). A tool result is a `user` line too, but
its content is an array, so a file the agent reads or prints does not count.
That line, not the file, sets the scope, `merge`, and the expiry (its
timestamp plus its `--for`). A later `/yolo off` line, a replay of an old line
past its lifetime, or no line at all makes the gate decline.

**Seeing a grant.** At each prompt, the `prompt` entry shows the owner a
one-line `systemMessage`: `YOLO active until 14:30 · merge: yes · scope: …`.
If a grant file exists that no typed `/yolo` backs, it shows a warning
instead, so a grant the owner did not start is visible at once. With no grant
file it exits before it reads its input.

**Why a `PermissionRequest` hook.** A PreToolUse `"allow"` does not clear a
prompt from a `permissions.ask` rule. A `PermissionRequest` `"allow"` does:
on Claude Code 2.1.296, in an interactive session, a call that matched a
`permissions.ask` rule ran with "Allowed by PermissionRequest hook", and so
did a call that a PreToolUse hook had answered with `"ask"`. A
`PermissionRequest` hook that exits 0 with no output leaves the dialog in
place. So the three shipped ask rules (`gh pr merge`, `git push origin
--delete`, `Skill(pr-conductor)`) stay in `settings.json` unchanged, and the
grant clears them only while it lives.

Because the `"allow"` also clears a PreToolUse `"ask"`, the gate runs
`guard-destructive-git.sh` from its own directory on every Bash call, and
declines when the guard asks. The guard's per-call `BYPASS_DESTRUCTIVE_GIT=1`
prefix does not reach the gate.

**The denylist.** Under a live grant, these keep their dialog:

- Everything `guard-destructive-git.sh` asks for: force push, `reset --hard`,
  `clean -f`, `checkout .`, `branch -D`, `worktree remove --force`.
- A branch or repository deletion: `git branch -d`, `git push --delete`,
  `git push <remote> :<ref>`, `git push +<ref>`, `--mirror`, `--prune`,
  `gh repo delete`, and `gh api -X DELETE`.
- A recursive `rm` that can reach outside the worktree: an absolute path
  outside it, `..`, `~`, a variable, a glob, a quote, `.`, a relative path
  after a `cd`, or an `rm` that `xargs` feeds.
- `terraform`, `tofu`, or `terragrunt` `destroy` and `apply -destroy`.
- A production deploy or release: any `--prod` or `--production` flag,
  `vercel promote` and `vercel rollback`, `fly`, `flyctl`, `wrangler`, and
  `firebase` `deploy`, `npm`, `pnpm`, and `yarn` `publish`,
  `gh release create`, a skill whose name has `deploy`, `release`,
  `rollback`, or `flyctl`, and an MCP tool whose name has `deploy`,
  `promote`, `rollback`, `release`, `publish`, `delete`, or `destroy`.
- An `Edit`, `Write`, `MultiEdit`, or `NotebookEdit` of a file under
  `docs/specs/`, which holds owner-approved spec text.
- The session's own permission surface: an edit of, or a Bash command that
  names, a `.claude/settings*.json` file, `.claude/hooks/`, `~/.claude/`, or a
  grant file. A change there would outlive the grant. The one exception is
  `rm -f` of the session's own grant file, which is how the skill ends it.
- `gh pr merge` and `Skill(merge-pr)` when merges are not in the scope. When
  they are, `gh pr merge --delete-branch` passes: deleting the merged pull
  request's own head branch is part of the merge, `/merge-pr` always passes
  it, and GitHub can restore the branch from the pull request.

The skill tells the session to stop for the same items, and also for a check
it cannot fix and for any work outside the scope, which no hook can see.

**Limits, stated plainly.**

- **The hook and the agent run as the same user, so this is not a hard
  boundary.** A session that can write files with no dialog (an allow rule,
  or auto mode) can write a grant file, and it can also append a forged line
  to its own transcript. The gate keeps the dialog for an edit or a command
  that names the grants, the settings, the hooks, or `~/.claude/` (which holds
  the transcripts), and the `prompt` line shows a grant, but a command built
  out of band can get past a textual check. Only the Claude Code sandbox,
  which keeps Bash writes inside the worktree, stops a forged grant. Turn it
  on where that matters.

- The gate can only approve a dialog Claude Code was about to show. It never
  adds a prompt: a denylist command that your settings already allow, or
  that auto mode's classifier approves, runs as it does today. The skill text
  is the stop for those.
- The denylist is textual, like `guard-destructive-git.sh`. A command built
  out of band (a variable, `eval`, a script file) can hide from it. It errs
  toward a dialog: a doubtful command keeps its prompt.
- The gate reads the session `cwd` from the hook input. A relative `rm -r`
  after a `cd` in an earlier Bash call can resolve to another directory.
- A subagent's dialog passes only when its request carries the session's
  `session_id`. If it does not, the dialog shows, which is the safe direction.
- A headless `claude -p` session sends a PreToolUse `"ask"` straight to
  "deny", without a `PermissionRequest`. The grant still clears ask rules
  there.

**Expiry and cleanup.** The gate ignores and removes an expired grant. On each
call it also removes the expired grants of other sessions, a grant whose file
name and `session_id` disagree, and a grant whose session the Claude Code
session registry (`~/.claude/sessions/<pid>.json`) shows with no live
process. The `SessionEnd` entry removes the grant of the session that ends,
including at `/clear`.

**Fails closed.** Without `jq`, without a readable grant or transcript, without
`guard-destructive-git.sh` beside it (for a Bash call), or on any error, the
gate prints nothing, and the dialog shows.

Register it with four entries. With `bootstrap.sh`, the user settings are:

```json
{
  "hooks": {
    "UserPromptExpansion": [
      {
        "matcher": "yolo",
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/yolo.sh grant", "timeout": 10 }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/yolo.sh permission", "timeout": 10 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/yolo.sh prompt", "timeout": 10 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/yolo.sh session-end", "timeout": 10 }
        ]
      }
    ]
  }
}
```

The settings template (`dotbabel init`) registers the same four entries with
the repository's `.claude/hooks/yolo.sh`.

---

## `fleet-shell-prefix.sh`

Not an event hook: it is the `CLAUDE_CODE_SHELL_PREFIX` target, so Claude
Code runs every shell command it starts through it. It sends a Bash tool call
that runs a heavy test command (`npm test`, `vitest`, `go test`, `pytest`, and
the like) to `scripts/fleet-lane.sh`, which waits for a free CPU lane and
pins the command to it. Every other command runs at once, unchanged. It never
stores the command it receives, and `touch ~/.local/state/dotbabel/fleet/lanes.off`
turns it off in every session at once. See [fleet.md](./fleet.md#cpu-lanes).

---

## check-on-stop trust

`check-on-stop.sh` runs a project's own build tooling, and build tooling executes
repo-controlled code by design:

- `cargo check` runs `build.rs`
- `mvn` runs Maven plugins
- `dotnet build` runs MSBuild targets
- `go vet` compiles, so cgo directives reach a C compiler

A `Stop` hook fires in whatever repo the session is in. Without a gate, cloning a
hostile repo and asking a model to edit one file would run arbitrary code at turn
end, with your privileges.

So the hook does nothing in a repo you have not allowlisted.

### The allowlist

```text
~/.config/dotbabel/check-on-stop-trusted
```

One absolute path per line. Blank lines and `#` comments are ignored. Every entry
is resolved before an exact compare, so a symlink cannot dodge the list and a
trusted `/srv/app` does not confer trust on `/srv/app-untrusted`.

It is user-scope on purpose. An in-tree marker file was tried first and rejected:
a hostile repo simply commits the marker and arrives pre-trusted on clone.
Authorization read out of the artifact being authorized is not authorization.

### Granting trust

```bash
# during onboarding
dotbabel project-init --trust --repo .

# or by hand
echo "$(realpath .)" >> ~/.config/dotbabel/check-on-stop-trusted
```

`--trust` is opt-in. `skills/project-sync/SKILL.md` tells an agent to run
`project-init`, so a default-on grant would let a model hand a repo turn-end code
execution with no human deciding.

Both forms record the **resolved** path. That keeps the grant idempotent across
symlink aliases of one repo, and pins the capability to a physical directory so
repointing a symlink cannot move it to another checkout.

### Worktrees

The gate compares against the project root the harness reports, which is not
always the directory you are sitting in. When a session in
`.claude/worktrees/<slug>/` reports the **repo root**, one entry for that root
covers every worktree. When it reports the worktree path instead, the hook
resolves a validated linked worktree to its main repository trust anchor. This
also supports worktrees attached to a bare repository. Invalid or forged Git
metadata does not inherit trust.

Rather than guess, run `dotbabel doctor` inside the worktree. It names the exact
path it checked, so a mismatch is visible in one line.

### Revoking trust

Delete the line. There is no cache.

```bash
dotbabel doctor    # reports whether the current repo is trusted
```

### CHECK_ON_STOP_TRUST_ALL

`CHECK_ON_STOP_TRUST_ALL=1` bypasses the allowlist for every repo. `dotbabel
doctor` warns when it is set. Do not export it in a shell profile.

---

## Registering a hook

Add the blocks you want to `~/.claude/settings.json`. Hook config loads at
session start, so restart Claude Code afterwards.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "$HOME/.claude/hooks/guard-destructive-git.sh" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/check-on-write.sh", "timeout": 15 }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "$HOME/.claude/hooks/check-on-stop.sh", "timeout": 600 }
        ]
      }
    ]
  }
}
```

The `Stop` timeout is 600, not 120. The hook caps **each** check at 120 seconds
(`CHECK_ON_STOP_TIMEOUT`) and can run one per language, so a shorter harness
timeout would cut it off part way.

---

## Monorepos

`check-on-stop.sh` walks up from each changed file to the nearest project marker
(`go.mod`, `Cargo.toml`, `tsconfig.json`, `pom.xml`, `*.csproj`), bounded by the
repo root. A repo whose `go.mod` sits at `api/go.mod` runs `go vet` for `api/`,
and the report names it:

```text
[go api] project check failed
```

Two sub-projects of one language each get their own check. A marker discovered
outside the allowlisted root is refused, never checked.

---

## Tuning and escape hatches

| Variable                     | Applies to     | Effect                                                              |
| ---------------------------- | -------------- | ------------------------------------------------------------------- |
| `BYPASS_CHECK_ON_WRITE=1`    | check-on-write | Disables the hook                                                   |
| `BYPASS_CHECK_ON_STOP=1`     | check-on-stop  | Disables the hook                                                   |
| `BYPASS_DESTRUCTIVE_GIT=1`   | guard          | Skips the prompt for the one git call it prefixes                   |
| `CHECK_ON_WRITE_TIMEOUT`     | check-on-write | Seconds per checker (default 5)                                     |
| `CHECK_ON_STOP_TIMEOUT`      | check-on-stop  | Seconds per checker (default 120)                                   |
| `CHECK_ON_STOP_TRUST_ALL`    | check-on-stop  | Bypasses the allowlist                                              |
| `CHECK_ON_STOP_TRUSTED_FILE` | check-on-stop  | Overrides the allowlist path                                        |
| `CHECK_ON_STOP_TESTS=1`      | check-on-stop  | Enables the related-tests stage                                     |
| `BYPASS_PRE_PUSH=1`          | pre-push       | Skips the pre-push quality check                                    |
| `DOTBABEL_PRE_PUSH_TIMEOUT`  | pre-push       | Seconds for the check (default 120), when `timeout(1)` is installed |

The guard does not block. On a match it returns a PreToolUse `permissionDecision: "ask"`,
so Claude Code shows the user a permission prompt, and the call runs only if the user
approves it. An agent never needs the bypass for an approved call. A user can skip the
prompt for one call with `BYPASS_DESTRUCTIVE_GIT=1 git branch -D old-branch`. It covers
only that call, so another destructive git call in the same command still asks.
Exporting the variable into the Claude Code session environment disables the guard for
every call.
The guard also matches git global options such as `-C <dir>` and `-c <key=value>`,
and git called by a path such as `/usr/bin/git`.

Both checkers fail open. A missing `jq`, a missing toolchain, bash 3.2, an
unmatched extension, a vendored path or a generated file all produce silence
rather than an error.

### Toolchain noise

Some output means "the toolchain failed to run", not "the code is wrong" — a
version-manager shim that is on `PATH` but not installed, a cold Maven cache
under `mvn -o`, or `NETSDK1004` from `dotnet build --no-restore` on a fresh
clone. None is something the model can fix by editing source.

Those lines are dropped **individually**, and the rest of the output is still
reported. A check whose output is entirely noise stays silent. Matching is
case-insensitive, so a tool that capitalises its message is still recognised.

A checker that fails with no output at all is reported rather than swallowed —
silence from a failing checker is worth surfacing.

---

## Related tests at turn end (opt-in)

`check-on-stop.sh` can run the tests related to the files a turn changed. It is
**off by default** and needs two independent permissions, not one:

```bash
export CHECK_ON_STOP_TESTS=1          # the opt-in
echo "$(realpath .)" >> ~/.config/dotbabel/check-on-stop-trusted   # the trust
```

Both are required. The opt-in alone does nothing in an untrusted repository,
which matters because a repository can ship a file that sets an environment
variable but cannot add itself to a user-scope allowlist. Running a test suite
is executing code the repository's author chose, so it sits behind the same
allowlist as the build checkers, plus one more switch.

The stage uses each runner's own scoping rather than running everything:

| Language   | Detected from    | Runs                                                                 |
| ---------- | ---------------- | -------------------------------------------------------------------- |
| JavaScript | `package.json`   | `npx vitest related --run <files>`, or `npx jest --findRelatedTests` |
| Go         | `go.mod`         | `go test` on the touched packages                                    |
| Python     | `pyproject.toml` | `pytest` on the touched test files                                   |

A whole-suite run is deliberately not offered: at the end of every turn it is
slow enough to get switched off, and a switched-off check protects nothing.

`CHECK_ON_STOP_TIMEOUT` bounds the stage, and a timed-out run never blocks — a
bound being hit is not a code defect. Failures feed the same give-up counter as
the static checks, so the same failing test blocks at most twice and then stops
blocking; this hook emits `decision: "block"`, so an unbounded stage would trap
the model in a loop rather than protect anything.

## The pre-push hook

`githooks/pre-push` runs `dotbabel quality check --profile fast` against the
merge base with the upstream branch. Activation is manual, because the hook
runs repository code:

```bash
git config core.hooksPath githooks
```

This repository adopts its own copy at `githooks/pre-push`. It resolves the
checker from the working tree instead of `PATH`, and gates on the in-tree bin
rather than on `dotbabel` being installed. A bare command resolves to whatever
is on `PATH`, which for a dotbabel developer is a globally installed published
release — so the template's form would check this working tree with a different
version of the checker. A consumer has no in-tree bin, which is why the template
stays generic.

That swap costs one guarantee, so the adopted copy buys it back. The template's
checker was an installed package the pushed change could not break, which made
exit 1 unambiguous. An in-tree checker can be broken by the very change being
pushed — a syntax error or a missing dependency makes node exit 1 too — so the
adopted copy runs with `--json` and blocks only when the checker produced a
report. No report means it failed to run, not that the check failed, and the
push is allowed with a notice (KD-11).

Warning: trust is keyed on the resolved real path, so a fresh worktree is
untrusted until granted separately and the hook exits 2 there, prints a notice,
and allows the push. Grant the worktree before relying on the gate.

`core.hooksPath` is repository configuration, not per-worktree: it lives in the
common `.git` directory that every worktree shares, so activating it in one
worktree activates it in all of them. Keep the value relative. An absolute path
breaks for every worktree the moment the repository moves, and the failure is
silent — git finds no hook and pushes anyway.

**It never traps a push.** Exactly one outcome blocks — the check ran and
reported a policy failure (exit 1). A missing `dotbabel`, unavailable evidence
or tooling (exit 2), any other exit code, a run that outlives
`DOTBABEL_PRE_PUSH_TIMEOUT`, or **no resolvable upstream merge base** prints a
notice and lets the push through. That asymmetry is the design: a hook that can
wedge a push at a deadline gets deleted, and then it protects nothing.

The merge base comes from `refs/remotes/<remote>/<branch>`, falling back to
`refs/remotes/<remote>/HEAD`. A normal `git clone` records the latter, so a new
branch resolves its fork point and the gate works on a first push. Where
`origin/HEAD` was never recorded — `git init` plus `git remote add`, and some
CI and worktree setups — there is nothing to diff against and the hook allows
the push with a notice rather than guessing at a base.

The check is scoped with `--head HEAD`, so it judges the commits being pushed.
Uncommitted work in the tree is deliberately out of scope here; that is
`check-on-stop`'s job.

Bypass with `BYPASS_PRE_PUSH=1 git push`, or `git push --no-verify`.

## Troubleshooting

**The hook produces nothing.** Silence is the normal state — it means no finding.
To tell "no finding" from "never ran", check the gates in order:

1. Is it registered? Run `/hooks` in a session. Nothing there means it never runs.
2. Did you restart after editing `settings.json`? Config loads at session start.
3. For `check-on-stop`: is the repo allowlisted? Run `dotbabel doctor`.
4. Is there a project marker? `check-on-stop` needs `go.mod`, `Cargo.toml`,
   `tsconfig.json`, `pom.xml` or `*.csproj` at or above the changed file.
5. Is the toolchain installed? An absent checker is silence, by design.
6. Is the file type covered? See [What each one covers](#what-each-one-covers).

**check-on-stop blocks repeatedly.** It gives up after the same failure blocks
twice, so it cannot nag forever. If a failure it cannot fix keeps appearing, add
`BYPASS_CHECK_ON_STOP=1` to that session or take the repo off the allowlist.

---

## Next

- [index.md](./index.md) — full docs nav
- [dotfile-quickstart.md](./dotfile-quickstart.md) — what `bootstrap.sh` symlinks
- [cli-reference.md](./cli-reference.md) — `dotbabel doctor`, `project-init`
