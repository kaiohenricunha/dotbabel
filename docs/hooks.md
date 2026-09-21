# Hooks

_Last updated: v3.4.0_

dotbabel ships four Claude Code hooks in `plugins/dotbabel/hooks/`. `bootstrap.sh`
symlinks all of them into `~/.claude/hooks/`.

| Hook                         | Event         | Fires                 | Purpose                                                               |
| ---------------------------- | ------------- | --------------------- | --------------------------------------------------------------------- |
| `guard-destructive-git.sh`   | `PreToolUse`  | before each Bash call | Blocks destructive git commands                                       |
| `guard-criteria-evidence.sh` | `PreToolUse`  | before each Bash call | Blocks a hand-written evidence marker (criteria, attestation, review) |
| `check-on-write.sh`          | `PostToolUse` | after each file edit  | Per-file syntax check of the edited file                              |
| `check-on-stop.sh`           | `Stop`        | once per turn         | Project-wide checks when the build graph is coherent                  |

> **Installed is not enabled.** `bootstrap.sh` puts the files in `~/.claude/hooks/`,
> but it never edits `settings.json`. Nothing runs until you register it yourself.
> See [Registering a hook](#registering-a-hook).

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

**Scope, stated plainly.** This stops the marker reaching a comment through the
command text or a `--body-file` the hook can read. It does **not** stop an agent
that assembles the marker out of band — splitting it across shell variables,
base64, a heredoc, or writing the body with the Write tool (which this
`PreToolUse` matcher does not cover) and posting it with `--body-file`. Those
are open by construction: no textual guard on a single Bash call can close
them. Treat this as a guardrail against the casual path, not a security
boundary. The durable fix is for the gate to stop trusting comment text — an
unforgeable value derived from the run, or a check-run artifact the agent
cannot author.

It guards three evidence families, each with its own sanctioned writer:

| Family      | Sanctioned writer                            | Read by                                    |
| ----------- | -------------------------------------------- | ------------------------------------------ |
| criteria    | `dotbabel criteria verify --pr <N> --post`   | the merge gate                             |
| attestation | `dotbabel local-attest --pr <N>`             | the merge gate and CI                      |
| review      | `dotbabel pr-stack review-complete --pr <N>` | `/pr-conductor`, to skip a finished review |

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
| `BYPASS_DESTRUCTIVE_GIT=1`   | guard          | Allows the one git call it prefixes                                 |
| `CHECK_ON_WRITE_TIMEOUT`     | check-on-write | Seconds per checker (default 5)                                     |
| `CHECK_ON_STOP_TIMEOUT`      | check-on-stop  | Seconds per checker (default 120)                                   |
| `CHECK_ON_STOP_TRUST_ALL`    | check-on-stop  | Bypasses the allowlist                                              |
| `CHECK_ON_STOP_TRUSTED_FILE` | check-on-stop  | Overrides the allowlist path                                        |
| `CHECK_ON_STOP_TESTS=1`      | check-on-stop  | Enables the related-tests stage                                     |
| `BYPASS_PRE_PUSH=1`          | pre-push       | Skips the pre-push quality check                                    |
| `DOTBABEL_PRE_PUSH_TIMEOUT`  | pre-push       | Seconds for the check (default 120), when `timeout(1)` is installed |

Write the guard bypass directly before the git call that the user confirmed, as in
`BYPASS_DESTRUCTIVE_GIT=1 git branch -D old-branch`. It covers only that call, so
another destructive git call in the same command is still blocked. Exporting the
variable into the Claude Code session environment disables the guard for every call.
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
