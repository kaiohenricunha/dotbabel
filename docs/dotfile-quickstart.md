# Dotfile quickstart — skills & commands in every Claude Code session

_Last updated: v2.0.1_

Bootstrap dotbabel into `~/.claude/` in under 30 seconds. No npm, no Node required.

**Who this is for:** anyone who wants `/pre-pr`, `/dependabot-sweep`, `/review-prs`,
cloud/IaC specialists, and the full commands library available in every project they
open in Claude Code. You manage it like any dotfile — pull to update, push to sync.

---

## 1. Clone

```bash
git clone https://github.com/kaiohenricunha/dotbabel.git ~/projects/dotbabel
cd ~/projects/dotbabel
```

> **Windows:** symlinks require elevated permissions. Use WSL (where the CLI works),
> or run `./bootstrap.sh` from Git Bash instead of using `dotbabel bootstrap`
> natively on Windows.

## 2. Bootstrap

```bash
./bootstrap.sh
```

This symlinks `commands/`, `skills/`, and `CLAUDE.md` into `~/.claude/`, and copies
agent templates into `~/.claude/agents/`. Idempotent — safe to re-run anytime.

Expected output:

```
✓ CLAUDE.md
✓ commands/git.md
✓ commands/pre-pr.md
...
✓ skills/aws-specialist/
...
bootstrap complete — 29 items linked, 0 skipped, 0 backed up
Run 'dotbabel-doctor' to verify the install.
```

Pre-existing real files (not symlinks) are backed up to `<name>.bak-<timestamp>` before
being replaced.

## 3. Verify

If `dotbabel` is on your PATH (it is if you installed via npm globally):

```bash
dotbabel-doctor
```

Otherwise, open any repo in Claude Code and type:

```
/git
```

If Claude Code loads the skill and starts the git workflow, the bootstrap worked.

## 4. Try your first command

Open any repo in Claude Code. The full library is now available:

```
# Read code before touching it — always grounded
/ground-first <subject>

# Fix a bug with a full evidence loop
/fix-with-evidence <issue>

# Gate your PR before opening it
/pre-pr

# Batch-triage all open Dependabot PRs
/dependabot-sweep

# Transfer your session to another machine or AI
/handoff push
```

Cloud/IaC specialists activate automatically — just mention the technology:

```
Review the IAM policies in this repo.
# → aws-specialist activates automatically

Help me debug this Kubernetes pod restart loop.
# → kubernetes-specialist activates automatically
```

## 5. Stay current

```bash
# Pull latest dotbabel and re-bootstrap ~/.claude/ in one command
./sync.sh pull
# or, if dotbabel is on PATH:
dotbabel sync pull
```

Check what version you're on:

```bash
./sync.sh status
# or:
dotbabel sync status
```

## 6. Push your customizations (optional)

If you've edited commands or skills locally and want to push them back:

```bash
./sync.sh push
# or:
dotbabel sync push
```

The push runs a secret scan before committing — it refuses files containing
`*_KEY`/`*_TOKEN`/`*_SECRET` patterns or AWS keys. Set
`HARNESS_SYNC_SKIP_SECRET_SCAN=1` to bypass if needed.

---

## Troubleshooting

**A skill or command isn't available in Claude Code.**

Check that the symlink exists:

```bash
ls -la ~/.claude/commands/pre-pr.md
ls -la ~/.claude/skills/aws-specialist/
```

If missing, re-run `./bootstrap.sh`. If the symlink exists but the skill isn't loading,
restart the Claude Code session (`/clear` or quit and reopen).

**`bootstrap.sh` says "backed up N files".**

That's expected on first run if you had existing files in `~/.claude/`. The originals
are preserved as `<name>.bak-<timestamp>`. Review them before deleting.

**You see `command not found: dotbabel-doctor`.**

`dotbabel-doctor` is part of the npm package, not the bootstrap path. It's optional.
To get it: `npm install -g @dotbabel/dotbabel`. Or just open Claude Code and verify
the commands load by trying `/git` or `/ground-first`.

**A skill was updated upstream but your session still runs the old version.**

Run `./sync.sh pull` then restart the Claude Code session. Skills are symlinked, so
after a pull the new version is live — but the running session cached the old one.

---

## What gets symlinked

| `~/.claude/` path      | Source                                      |
| ---------------------- | ------------------------------------------- |
| `CLAUDE.md`            | `CLAUDE.md` (global rules for all sessions) |
| `commands/*.md`        | `commands/*.md` (all slash commands)        |
| `skills/*/`            | `skills/*/` (all skill directories)         |
| `hooks/*.sh`           | `plugins/dotbabel/hooks/*.sh`               |
| `agents/*.md` (copied) | `plugins/dotbabel/templates/claude/agents/` |

> Agents are **copied**, not symlinked — Claude Code resolves agent paths at startup
> and needs real files, not symlinks, on some platforms.

---

## Next

- [docs/index.md](./index.md) — full docs nav
- [CLAUDE.md](../CLAUDE.md) — the global rules installed by bootstrap
- [cli-reference.md](./cli-reference.md) — `dotbabel bootstrap`, `sync`, and all CLI subcommands
