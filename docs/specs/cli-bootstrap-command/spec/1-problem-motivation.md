# §1 — Problem / Motivation

> Why does this exist? What's broken? Why now?

## Why

The dotbabel distribution is currently split across two disconnected tools:
`bootstrap.sh` (a shell script that wires `~/.claude/`) and the `dotbabel`
CLI (an npm package that governs per-repo spec workflows). A developer who
installs `npm install -g @dotbabel/dotbabel` gets no way to set up their
global `~/.claude/` from the same tool — they must separately discover,
clone, and run `bootstrap.sh`. Likewise, keeping the global config current
requires knowing where the clone lives and running `./sync.sh pull` from it.

This creates two classes of friction:

1. **Onboarding gap.** New developers must learn two separate entry-points,
   two invocation styles (bash vs npm), and two update flows. Telling a new
   dev "install the CLI, then separately clone the repo and run bootstrap.sh"
   creates unnecessary cognitive load when the CLI could handle both.

2. **Update friction.** Pulling recent configuration changes requires
   navigating to the dotbabel clone and running a shell script. There is no
   `dotbabel sync pull` that a developer can run from any directory.

## What

Add two new subcommands to the `dotbabel` CLI:

- **`dotbabel bootstrap`** — sets up (or refreshes) `~/.claude/` by
  symlinking `commands/`, `skills/`, `CLAUDE.md`, and the agents template
  directory into place. Works in two modes:
  - **npm mode** (default): sources files from the npm package's own install
    directory; no git clone required.
  - **clone mode** (`--source <path>` / `DOTBABEL_DIR`): sources files from
    a local git clone, identical behavior to `bootstrap.sh`.

- **`dotbabel sync`** — manages keeping the global config current:
  - `pull`: in npm mode, runs `npm update -g @dotbabel/dotbabel` then
    re-bootstraps; in clone mode, `git fetch + rebase` then re-bootstraps.
  - `status`: in npm mode, reports current vs. latest npm version; in clone
    mode, delegates to `git status --short` on the clone.
  - `push`: clone-mode-only; mirrors `sync.sh push` (secret-scan + commit +
    push).

`bootstrap.sh` and `sync.sh` are not removed — they remain the zero-npm
fallback for users who prefer a shell-only path.

## Why Now

The new developer onboarding conversation exposed that the split creates a
confusing "two tools for one concept" story. As the project grows its user
base, the CLI is the natural single entry-point; `bootstrap.sh` should become
an implementation detail rather than a required step in the setup docs.
