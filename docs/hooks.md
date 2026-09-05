# Hooks

_Last updated: v3.2.0_

dotbabel ships three Claude Code hooks in `plugins/dotbabel/hooks/`. `bootstrap.sh`
symlinks all of them into `~/.claude/hooks/`.

| Hook                       | Event         | Fires                 | Purpose                                              |
| -------------------------- | ------------- | --------------------- | ---------------------------------------------------- |
| `guard-destructive-git.sh` | `PreToolUse`  | before each Bash call | Blocks destructive git commands                      |
| `check-on-write.sh`        | `PostToolUse` | after each file edit  | Per-file syntax check of the edited file             |
| `check-on-stop.sh`         | `Stop`        | once per turn         | Project-wide checks when the build graph is coherent |

> **Installed is not enabled.** `bootstrap.sh` puts the files in `~/.claude/hooks/`,
> but it never edits `settings.json`. Nothing runs until you register it yourself.
> See [Registering a hook](#registering-a-hook).

---

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
covers every worktree. When it reports the worktree path instead, that path
needs its own entry.

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

| Variable                     | Applies to     | Effect                            |
| ---------------------------- | -------------- | --------------------------------- |
| `BYPASS_CHECK_ON_WRITE=1`    | check-on-write | Disables the hook                 |
| `BYPASS_CHECK_ON_STOP=1`     | check-on-stop  | Disables the hook                 |
| `BYPASS_DESTRUCTIVE_GIT=1`   | guard          | Allows one destructive git call   |
| `CHECK_ON_WRITE_TIMEOUT`     | check-on-write | Seconds per checker (default 5)   |
| `CHECK_ON_STOP_TIMEOUT`      | check-on-stop  | Seconds per checker (default 120) |
| `CHECK_ON_STOP_TRUST_ALL`    | check-on-stop  | Bypasses the allowlist            |
| `CHECK_ON_STOP_TRUSTED_FILE` | check-on-stop  | Overrides the allowlist path      |

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
