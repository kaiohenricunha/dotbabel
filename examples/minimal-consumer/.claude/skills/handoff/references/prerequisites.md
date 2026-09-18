# Handoff prerequisites — git transport checklist and remediation

Remote transport operations (`push`, `fetch`, `list --remote`, `prune`)
require a working git transport. `/handoff doctor` runs the checklist
below and prints a remediation block on failure. (`pull` is a local
render verb and does not need git transport.) The reusable implementation
lives at `plugins/dotbabel/scripts/handoff-doctor.sh`.

## Output contract

On success, the script prints one line to stdout and exits 0:

```text
ok
```

On failure, it prints this block to stderr and exits non-zero:

```text
Preflight failed: <one-line reason>

  What's wrong: <diagnosis>
  How to fix:
    1. <command>
    2. <command>

  Workaround: <concrete alternative>

Rerun /handoff doctor to verify.
```

`<reason>`, `<diagnosis>`, the numbered commands, and the workaround
come from the table below.

## Checks, in order

| #   | Check                       | Command                                                    | Failure reason             |
| --- | --------------------------- | ---------------------------------------------------------- | -------------------------- |
| 1   | `git` on PATH               | `command -v git`                                           | `git-missing`              |
| 2   | Handoff repo URL configured | `[[ -n "$DOTBABEL_HANDOFF_REPO" ]]`                        | `handoff-repo-unset`       |
| 3   | Repo reachable              | `git ls-remote "$DOTBABEL_HANDOFF_REPO" HEAD`              | `handoff-repo-unreachable` |
| 4   | Clock sanity (soft)         | `[[ $(date -u +%Y) -ge 2024 && $(date -u +%Y) -le 2100 ]]` | `clock-skew` (warn only)   |

## Remediation

**`git-missing`** — diagnose: `git` is not installed.
Install, by platform:

| Platform              | Command                       |
| --------------------- | ----------------------------- |
| macOS (Homebrew)      | `brew install git`            |
| Debian / Ubuntu / Pop | `sudo apt install git`        |
| Arch                  | `sudo pacman -S git`          |
| Fedora                | `sudo dnf install git`        |
| Windows (winget)      | `winget install --id Git.Git` |
| Windows (scoop)       | `scoop install git`           |

`git` is required — there is no alternative remote transport.

**`handoff-repo-unset`** — diagnose: `DOTBABEL_HANDOFF_REPO` is not
in the environment.
Fix:

1. Create a private repo once (any provider works):
   `gh repo create handoff-store --private`.
2. `export DOTBABEL_HANDOFF_REPO=git@github.com:<user>/handoff-store.git`
   (add to your shell rc for persistence).

The URL accepts `ssh://`, `git@`, `https://`, an absolute local path, or a
`file://` URL. Self-hosted GitLab/Gitea/Forgejo work the same way — the
only requirement is that your account can push to that repo.

**`handoff-repo-unreachable`** — diagnose: `git ls-remote` failed.
Fix:

1. Verify SSH auth: `ssh -T git@github.com` (or your provider's host).
2. Or switch to HTTPS + credential helper:
   `git config --global credential.helper cache`.
3. Confirm the repo exists and your account has push access.

**`clock-skew`** — warn only, never blocks. Message:

```text
warn: system clock reports year <YYYY>; git auth may fail with signature errors (timedatectl set-ntp true)
```

## Air-gapped / offline path

Run `dotbabel handoff pull <uuid> -o <path>` on the source machine to write
a local markdown file. Move it via any out-of-band channel (USB stick, secure
copy, encrypted email), then paste the file's markdown content into the target
session. No network or binary required on the destination.
