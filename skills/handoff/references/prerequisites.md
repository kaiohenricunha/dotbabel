# Handoff prerequisites — per-transport checklist and remediation

The remote sub-commands (`push`, `pull`, `remote-list`) require
external tooling. `/handoff doctor --via <transport>` runs this
checklist and prints a remediation block on failure. The reusable
implementation lives at `plugins/dotclaude/scripts/handoff-doctor.sh`.

## Output contract

On success, the script prints one line to stdout and exits 0:

```text
ok: <transport>
```

On failure, it prints this block to stderr and exits non-zero:

```text
Preflight failed: <one-line reason>

  What's wrong: <diagnosis>
  How to fix:
    1. <command>
    2. <command>

  Workaround: <concrete alternative>

Rerun /handoff doctor --via <transport> to verify.
```

`<transport>`, `<reason>`, `<diagnosis>`, the numbered commands, and
the workaround come from the tables below.

## Transport: `github` (default)

### Checks, in order

| #   | Check               | Command                                                    | Failure reason           |
| --- | ------------------- | ---------------------------------------------------------- | ------------------------ |
| 1   | `gh` on PATH        | `command -v gh`                                            | `gh-missing`             |
| 2   | `gh` authenticated  | `gh auth status -h github.com`                             | `gh-unauthenticated`     |
| 3   | Network reach       | `gh api /` (expect HTTP 200)                               | `network-unreachable`    |
| 4   | `gist` OAuth scope  | `gh api user -i` and grep `X-Oauth-Scopes:` for `gist`     | `gist-scope-missing`     |
| 5   | Clock sanity (soft) | `[[ $(date -u +%Y) -ge 2024 && $(date -u +%Y) -le 2100 ]]` | `clock-skew` (warn only) |

### Remediation

**`gh-missing`** — diagnose: `gh` CLI not installed.
Install, by platform:

| Platform              | Command                          |
| --------------------- | -------------------------------- |
| macOS (Homebrew)      | `brew install gh`                |
| Debian / Ubuntu / Pop | `sudo apt install gh`            |
| Arch                  | `sudo pacman -S github-cli`      |
| Fedora                | `sudo dnf install gh`            |
| Windows (winget)      | `winget install --id GitHub.cli` |
| Windows (scoop)       | `scoop install gh`               |

If the distro ships an outdated `gh`, use the official apt repo per
<https://cli.github.com/>.

Workaround: `--via gist-token` (no `gh` required; uses a PAT) or
`--via git-fallback` (uses raw `git`).

**`gh-unauthenticated`** — diagnose: `gh auth status` reports no
account for `github.com`.
Fix:

1. `gh auth login -h github.com -s gist`
2. Pick HTTPS; paste PAT or use the device-flow browser prompt.

Workaround: `--via gist-token` with `DOTCLAUDE_GH_TOKEN=<PAT>`.

**`gist-scope-missing`** — diagnose: the stored token lacks the
`gist` scope. `push` and `remote-list` will fail later with a
misleading 404.
Fix:

1. `gh auth refresh -h github.com -s gist`

Workaround: same as above.

**`network-unreachable`** — diagnose: `gh api /` failed with
`ENETUNREACH`, TLS error, or 5xx.
Fix:

1. Verify connectivity: `curl -sS https://api.github.com/ -o /dev/null -w '%{http_code}\n'`.
2. If corporate proxy: set `HTTPS_PROXY` and retry.
3. If GitHub incident: check <https://www.githubstatus.com/>.

Workaround: `/handoff file <cli> <uuid>` writes a local markdown
artifact; transport it by any out-of-band means and pull with
`/handoff pull --from-file <path>`.

**`clock-skew`** — warn only, never blocks. Message:

```text
warn: system clock reports year <YYYY>; gist auth may fail with signature errors (timedatectl set-ntp true)
```

## Transport: `gist-token`

### Checks

| #   | Check                            | Command                          | Failure reason        |
| --- | -------------------------------- | -------------------------------- | --------------------- |
| 1   | `curl` on PATH                   | `command -v curl`                | `curl-missing`        |
| 2   | `DOTCLAUDE_GH_TOKEN` env var set | `[[ -n "$DOTCLAUDE_GH_TOKEN" ]]` | `token-missing`       |
| 3   | Network reachable                | `GET /user` HTTP ≠ 000           | `network-unreachable` |
| 4   | Token valid                      | `GET /user` HTTP 200             | `token-invalid`       |
| 5   | `gist` scope present             | inspect `X-Oauth-Scopes` header  | `token-scope-missing` |

Remediation follows the same shape. For `token-missing`:

1. Create a PAT at <https://github.com/settings/tokens/new> with only
   the `gist` scope.
2. `export DOTCLAUDE_GH_TOKEN=<pasted-pat>` (or add to your shell rc).

## Transport: `git-fallback`

### Checks

| #   | Check                       | Command                                        | Failure reason             |
| --- | --------------------------- | ---------------------------------------------- | -------------------------- |
| 1   | `git` on PATH               | `command -v git`                               | `git-missing`              |
| 2   | Handoff repo URL configured | `[[ -n "$DOTCLAUDE_HANDOFF_REPO" ]]`           | `handoff-repo-unset`       |
| 3   | Repo reachable              | `git ls-remote "$DOTCLAUDE_HANDOFF_REPO" HEAD` | `handoff-repo-unreachable` |

Remediation for `handoff-repo-unset`:

1. Create a private repo once:
   `gh repo create handoff-store --private --confirm` (or via the
   web UI).
2. `export DOTCLAUDE_HANDOFF_REPO=git@github.com:<user>/handoff-store.git`.

Remediation for `handoff-repo-unreachable`:

1. Verify SSH auth: `ssh -T git@github.com`.
2. Try HTTPS with credential helper:
   `git config --global credential.helper cache`.

## Transport selection rules of thumb

| Situation                              | Recommended `--via`              |
| -------------------------------------- | -------------------------------- |
| Typical dev laptop with `gh` logged in | `github` (default)               |
| CI / devcontainer / headless sandbox   | `gist-token`                     |
| Air-gapped or flaky network            | `--from-file` + out-of-band copy |
| Corporate env blocks gist API          | `git-fallback`                   |
| First time on a new machine            | run `doctor` first               |
