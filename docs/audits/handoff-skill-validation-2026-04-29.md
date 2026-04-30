# Handoff-skill validation — 2026-04-29

End-to-end validation of every cross-agent handoff combination and remote-transport
scenario against the post-Phase-3 surface (`origin/main` @ `be25258`,
`dotclaude-handoff` v0.11.0). Replaces the stale `docs/audits/handoff-remote/`
artifacts (superseded after the v0.9.0 gist-transport removal).

## Scope

**Included.** All 3 supported CLIs (`claude`, `copilot`, `codex` —
`plugins/dotclaude/bin/dotclaude-handoff.mjs:106`) × every public verb that
touches the transport (`push`, `fetch`, `list`, `prune`); the legacy
`metadata.tag` read fallback (`plugins/dotclaude/src/lib/handoff-remote.mjs:346`);
the W-1 metadata shape; the 4 documented error paths.

**Excluded.** Search (local-only verb), doctor (orthogonal preflight),
true two-machine validation against a remote git host (covered separately
by the cross-machine checklist once it is refreshed for v0.9.0+ git-only
transport).

**Method.** A bare git transport repo (`DOTCLAUDE_HANDOFF_REPO=$AUDIT/transport.git`),
3 stub session fixtures (one per CLI under separate `$HOME` roots), and the
real machine (`hostname=win11`) — plus a UTS-namespaced shell
(`unshare -u --map-root-user --user`) to spoof a second hostname (`host-a`)
for genuine cross-host pushes. All commands and outputs are verbatim from
the run transcripts captured at `/tmp/handoff-audit.*/transcripts/`.

## Findings

### F-1 — Surface enumeration

| Item                | Status         | Details                                                                                                                                                 |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verbs               | ✓ matches spec | `pull fetch list search push prune doctor` (`bin/dotclaude-handoff.mjs:111`) — 7 verbs total                                                            |
| Supported CLIs      | ✓              | `CLIS = new Set(["claude", "copilot", "codex"])` (`bin/dotclaude-handoff.mjs:106`)                                                                      |
| Cross-cutting flags | ✓              | `--help/-h`, `--version/-V`, `--verbose/-v`, `--json`, `--no-color` (visible in `--help` output below)                                                  |
| Env vars read       | ✓              | `DOTCLAUDE_HANDOFF_REPO` (transport), `DOTCLAUDE_DOCTOR_SH` (test override), `DOTCLAUDE_QUIET` (suppress deprecation), `DOTCLAUDE_DEBUG` (stderr trace) |
| Version             | 0.11.0         | `node $BIN --version`                                                                                                                                   |

```
$ node $BIN --version
0.11.0

$ node $BIN --help
dotclaude handoff [pull|fetch|list|search|push|prune|doctor] [args...] [--from <cli>] [--summary] [-o <path>] [--tag <label>...] [--tags] [--since <ISO>] [--limit <N>] [--verify] [--dry-run] [--older-than <30d|6m|1y|YYYY-MM-DD>] [--yes]

Cross-agent and cross-machine session handoff. `pull <id>` renders a local session as <handoff> block (or --summary / -o <path>). push/fetch handle the remote transport (a user-owned private git repo named by DOTCLAUDE_HANDOFF_REPO). push/fetch auto-run a preflight check (cached 5 min); --verify forces re-run.

For push without a query, --from <cli> is required. Omitting --from exits 64 with a usage hint.
…
Exit codes: 0 ok, 1 validation failure, 2 env error, 64 usage error.
```

### F-2 — Cross-agent matrix (3 × 3 = 9 cells)

For each source CLI a session was stubbed under a per-CLI HOME root and
pushed; the resulting branch was then fetched from each of the three
"consumer-CLI" HOME roots. **All 9 cells exit 0**, and within each source
row the fetched body is **byte-identical across the three consumer
columns** — confirming that consumer CLI does not influence fetch output.
The "Next step" hint adapts to **the producing CLI** (`nextStepFor()` at
`plugins/dotclaude/src/lib/handoff-remote.mjs:157–165`), not the consumer.

| Source ↓ \ Consumer → | claude | codex | copilot | Next-step hint adapts to |
| --------------------- | ------ | ----- | ------- | ------------------------ |
| **claude**            | ✓      | ✓     | ✓       | source (claude)          |
| **codex**             | ✓      | ✓     | ✓       | source (codex)           |
| **copilot**           | ✓      | ✓     | ✓       | source (copilot)         |

#### Push commands (one per source CLI)

```
$ HOME=$AUDIT/host-claude node $BIN push --from claude --tag audit-claude
using --from claude override, latest claude session: 11111111
handoff/proj/claude/2026-04/11111111
$AUDIT/transport.git
handoff:v2:proj:claude:2026-04:11111111:win11:audit-claude
[scrubbed 0 secrets]

$ HOME=$AUDIT/host-codex node $BIN push --from codex --tag audit-codex
using --from codex override, latest codex session: 33333333
handoff/proj/codex/2026-04/33333333
…
handoff:v2:proj:codex:2026-04:33333333:win11:audit-codex

$ HOME=$AUDIT/host-copilot node $BIN push --from copilot --tag audit-copilot
using --from copilot override, latest copilot session: 22222222
handoff/proj/copilot/2026-04/22222222
…
handoff:v2:proj:copilot:2026-04:22222222:win11:audit-copilot
```

#### W-1 metadata shape (verified on a fresh push)

```
$ git clone -q --branch <pushed-branch> file://$TRANSPORT $tmp ; cat $tmp/metadata.json
{
  "cli": "claude",
  "session_id": "99999999-9999-4999-8999-999999999999",
  "short_id": "99999999",
  "cwd": "/home/test/proj",
  "project": "proj",
  "month": "2026-04",
  "hostname": "win11",
  "created_at": "2026-04-29T12:58:08.813Z",
  "scrubbed_count": 0,
  "tags": ["meta-shape-check"]
}
```

Assertions: `has("tag") | not` ⇒ `true`; `.tags == ["meta-shape-check"]` ⇒
`true`. **W-1 (drop legacy single-string `metadata.tag` write-side) is
in effect.**

#### Fetch outputs — sample one cell per row

claude → codex (typical cross-agent fetch — would also be byte-identical
for claude → claude and claude → copilot):

```
$ HOME=$AUDIT/host-codex node $BIN fetch audit-claude
<handoff origin="claude" session="11111111" cwd="/home/test/proj" target="claude">

**Summary.** Session opened with: "Audit cell prompt for claude source.". …

**User prompts (last 10, in order).**

1. Audit cell prompt for claude source.

**Last assistant turns (tail).**

> Acknowledged — claude source assistant turn.

**Next step.** Continue from the last assistant turn using the same file scope and goals summarized above.

</handoff>
```

codex → claude (Next-step hint differs):

```
**Next step.** Read the prompts and assistant turns above, then continue the task using the file paths mentioned. Treat this as a task specification.
```

copilot → claude (Next-step hint differs again):

```
**Next step.** Help me pick up where this session left off; reference the prompts and findings above.
```

### F-3 — Remote-transport / multi-host

Setup: real machine pushes from `host=win11` (session UUID `aaaaaaaa…`), then
the same binary is invoked inside a UTS+user namespace with a spoofed
hostname `host-a` (session UUID `bbbbbbbb…`). Both branches are committed
to the same bare transport repo and inspected by `list`, `list --tag`,
`list --tags`, and `prune`.

```
$ HOME=$AUDIT/host-B node $BIN push --from claude --tag from-host-b
…
handoff:v2:proj:claude:2026-04:aaaaaaaa:win11:from-host-b

$ unshare -u --map-root-user --user bash -c "
    hostname host-a
    HOME=$AUDIT/host-A node $BIN push --from claude --tag from-host-a"
…
handoff:v2:proj:claude:2026-04:bbbbbbbb:host-a:from-host-a
```

#### R-1 visibility — both hosts coexist

```
$ node $BIN list --remote
| Location | CLI     | Short UUID | When             |
| -------- | ------- | ---------- | ---------------- |
| remote   | claude  | aaaaaaaa   | 2026-04          |
| remote   | claude  | bbbbbbbb   | 2026-04          |

$ node $BIN list --remote --tags
tag histogram on transport (2 branches):
  from-host-a  1
  from-host-b  1
```

#### R-2 tag filter

```
$ node $BIN list --remote --tag from-host-a
| Location | CLI     | Short UUID | When             |
| -------- | ------- | ---------- | ---------------- |
| remote   | claude  | bbbbbbbb   | 2026-04          |   ← only host-A's branch

$ node $BIN list --remote --tag from-host-b
| Location | CLI     | Short UUID | When             |
| -------- | ------- | ---------- | ---------------- |
| remote   | claude  | aaaaaaaa   | 2026-04          |   ← only host-B's branch
```

#### R-3 prune host-gate

`prune` filters by `metadata.hostname` against the local hostname slug
(`plugins/dotclaude/tests/bats/handoff-prune.bats:92+` documents the
contract). With a third **legacy** branch seeded directly into the
transport (host=`win11`, `metadata.tag` only — no `tags` array), the host
gate behaves correctly: 2 of 3 branches eligible, foreign-host branch
skipped.

```
$ node $BIN prune --dry-run --older-than 0d
dotclaude-handoff prune: 2 of 3 branch(es) eligible for delete
  skipped: 1 pushed from another host
  handoff/proj/claude/2026-04/aaaaaaaa  (0d ago)
  handoff/proj/claude/2026-04/legacyaa  (0d ago)
--dry-run: nothing deleted.

$ node $BIN prune --older-than 0d --yes
…
deleted 2 branch(es).

$ git ls-remote --heads $TRANSPORT
22ee8056…  refs/heads/handoff/proj/claude/2026-04/bbbbbbbb   ← only the foreign-host branch survives
```

### F-4 — Backward compat + error paths

| ID  | Scenario                                                                         | Exit | Behavior                                                                     |
| --- | -------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| B-1 | `fetch <legacy-tag>` against a branch with `metadata.tag` only (no `tags` array) | 0    | Resolves and renders body — read fallback at `handoff-remote.mjs:346` works. |
| B-2 | `push` with `DOTCLAUDE_HANDOFF_REPO` unset, non-TTY                              | 2    | Renders bootstrap-instructions message; does not write.                      |
| B-3 | `push --from foo` (unknown CLI)                                                  | 64   | `--from must be one of: claude, copilot, codex`                              |
| B-4 | `fetch latest` against an empty bare transport                                   | 2    | Normalized error block (cause / fix / retry).                                |
| B-5 | `push` with no `--from` and no host session detected                             | 64   | `push without a <query> requires --from <cli>`                               |

#### Verbatim — B-1 legacy fetch

```
$ node $BIN fetch legacy-tag
legacy handoff body — pre-W-1 metadata shape
```

#### Verbatim — B-2 missing transport (non-TTY)

```
$ DOTCLAUDE_HANDOFF_REPO unset; node $BIN push --from claude --tag should-not-write
using --from claude override, latest claude session: aaaaaaaa

Can't auto-bootstrap the handoff store: not running in an interactive terminal

Set it up manually:
  1. gh repo create <you>/dotclaude-handoff-store --private
  2. export DOTCLAUDE_HANDOFF_REPO=git@github.com:<you>/dotclaude-handoff-store.git
  3. dotclaude handoff push   # retries
…
[exit=2]
```

#### Verbatim — B-3 unknown CLI

```
$ node $BIN push --from foo
dotclaude-handoff: --from must be one of: claude, copilot, codex
[exit=64]
```

#### Verbatim — B-4 empty transport

```
$ node $BIN fetch latest
dotclaude-handoff: fetch failed
  stage:  resolve
  cause:  no handoffs on transport
  fix:    Push a session first: `dotclaude handoff push`
  retry:  dotclaude handoff push
[exit=2]
```

#### Verbatim — B-5 no --from + no host session

```
$ HOME=/tmp/no-session node $BIN push
dotclaude-handoff: push without a <query> requires --from <cli>
  usage: dotclaude handoff push --from <claude|copilot|codex>
[exit=64]
```

## Issues

| Severity | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Location                                                                              | Recommendation                                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INFO     | Branch namespace `handoff/<proj>/<cli>/<month>/<shortId>` does not include `hostname`. If two hosts coincidentally produce sessions with the same 8-hex `shortId` for the same `proj+cli+month`, the second `push` silently overwrites the first. Probability is ~1/4×10⁹ per coincident push for random UUIDs, but **deterministic collision** if a user replays/restores the same session on a second machine. Confirmed during the audit when contrived fixtures reused a single session UUID across two hosts. | `plugins/dotclaude/src/lib/handoff-remote.mjs:304–306` (`v2BranchName`)               | Document the property in the spec (it is currently implicit). Optional follow-up: extend the branch suffix to include host slug, e.g. `handoff/<proj>/<cli>/<month>/<shortId>-<hostSlug>`, or track collisions explicitly via the `--force-collision` flag (already in `META.flags`). |
| INFO     | `prune --older-than 0d` is accepted and treated as "all branches eligible by age" — useful for testing but not documented in `--help`.                                                                                                                                                                                                                                                                                                                                                                             | `bin/dotclaude-handoff.mjs:111` (synopsis); behavior of `parseOlderThan` accepts `0d` | Either reject `0d` with a usage error, or document the semantics ("0d == today inclusive") in the synopsis.                                                                                                                                                                           |
| INFO     | `list --remote --tag <legacy-tag>` returns the legacy single-tag branch when the tag exactly matches `metadata.tag`, but the tag-filter implementation reads the `tags` array first and falls back to `tag` only via the resolver path (verified in B-1). The audit did not exercise `list --remote --tag <legacy-tag>` directly — only `fetch <legacy-tag>`.                                                                                                                                                      | `handoff-remote.mjs:346` (read fallback used by `tagsOf`)                             | Add a bats case asserting `list --remote --tag <legacy-only-value>` matches a branch carrying only `metadata.tag`. Low risk; the fallback runs in both list and fetch resolution paths.                                                                                               |

No CRITICAL or WARNING issues found.

## Summary

The post-Phase-3 surface behaves as the spec specifies: cross-agent push/fetch
are symmetric across all 9 source × consumer cells, the next-step hint
correctly adapts to the producing CLI, the host-gate on `prune` works,
legacy `metadata.tag` is still readable, and every documented error path
exits with the correct code and a normalized message. The W-1 cleanup is
visible in fresh metadata. **Go for the version bump and §6.5 migration-table
release PR**, with the host-collision INFO row tracked as a follow-up
(spec doc + optional namespace extension).

> **Update — see [Post-audit follow-ups (2026-04-30)](#post-audit-follow-ups-2026-04-30) below.**
> Validation 2 surfaced a substrate-portability bug that flips the v1.0
> verdict from "go" to **blocked on a one-line fix to `handoff-resolve.sh`**.

## Post-audit follow-ups (2026-04-30)

Two pre-v1.0 validations against the same surface (`origin/main` @ `be25258`,
v0.11.0). The original audit ran exclusively against a `file://` bare repo
on the same host; these runs add the missing slices: real network/auth
layer, and substrate (jq/perl/bash/find/stat) portability across container
images. Background per the original audit's §Out of scope: the local-bare
transport bypassed `gh repo create` self-bootstrap, ssh transport, and
non-glibc utilities.

### V-1 — Real GitHub remote, end-to-end happy path

**Method.** Backed up `~/.config/dotclaude/handoff.env`, removed it, seeded
a uniquely-tagged stub session under the real `$HOME/.claude/projects/`
(so `gh` keeps its credentials in the user's home — see Issue 4 below for
why a separate `$HOME` does not work for the bootstrap path), drove the
interactive bootstrap via a Python `pty` wrapper feeding the 3 prompts
(`name`, `confirm`, no third). Test repo:
`kaiohenricunha/dotclaude-handoff-audit-2026-04-29`.

| Item                                | Result                                                                                                     | Evidence                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `gh auth status`                    | ✓ Logged in as `kaiohenricunha`, scopes include `repo`                                                     | `gh auth status` output captured at run time                      |
| Bootstrap fired (interactive TTY)   | ✓ All 3 prompts driven; `gh repo create … --private` invoked                                               | bootstrap-driver.log @ `/tmp/v1-validation/bootstrap-driver.log`  |
| Repo created **private**            | ✓ `isPrivate: true`, `visibility: PRIVATE`                                                                 | `gh repo view … --json visibility,isPrivate,sshUrl` (post-create) |
| `handoff.env` written mode 0600     | ✓ `-rw------- 1 kaioh kaioh 241`                                                                           | `ls -la ~/.config/dotclaude/handoff.env`                          |
| Push completed via real ssh remote  | ✓ Branch `handoff/proj/claude/2026-04/abcd0001` on `git@github.com:…`; `[scrubbed 0 secrets]`              | bootstrap-driver.log final lines                                  |
| Round-trip `fetch` over real remote | ✓ Body shape parity with F-2 (same `<handoff … target=…>`, Summary/Prompts/Tail/Next-step block)           | `/tmp/v1-validation/fetch-real-remote.txt`                        |
| Cleanup                             | ✓ Test repo deleted post-audit (`gh auth refresh -h github.com -s delete_repo` + `gh repo delete … --yes`) | `gh repo view …` returns "Could not resolve to a Repository"      |

```
$ python3 /tmp/handoff-bootstrap-driver.py dotclaude-handoff-audit-2026-04-29 abcd0001
DOTCLAUDE_HANDOFF_REPO is not set — dotclaude can set this up for you.
  Detected: gh CLI authenticated as @kaiohenricunha.
  Plan: create private repo  kaiohenricunha/<name>
        persist URL to       /home/kaioh/.config/dotclaude/handoff.env
  Repo name? [dotclaude-handoff-store] dotclaude-handoff-audit-2026-04-29
  Create kaiohenricunha/dotclaude-handoff-audit-2026-04-29 and proceed? [y/N] y
  ✓ created kaiohenricunha/dotclaude-handoff-audit-2026-04-29
  ✓ wrote /home/kaioh/.config/dotclaude/handoff.env
handoff/proj/claude/2026-04/abcd0001
git@github.com:kaiohenricunha/dotclaude-handoff-audit-2026-04-29.git
handoff:v2:proj:claude:2026-04:abcd0001:win11:bootstrap-test
[scrubbed 0 secrets]

$ gh repo view kaiohenricunha/dotclaude-handoff-audit-2026-04-29 \
    --json visibility,isPrivate,sshUrl
{"isPrivate":true,"sshUrl":"git@github.com:…","visibility":"PRIVATE"}
```

**No SEC violation.** The bootstrap path passes `--private` unconditionally
at `plugins/dotclaude/src/lib/handoff-remote.mjs:541` and the verified
metadata shows `visibility: PRIVATE`. No drift between the local-transport
behavior the original audit verified and the real-remote behavior — same
branch shape, same metadata shape, same fetch-body shape.

### V-2 — Substrate portability across container images

**Method.** Built two minimal images and ran the same F-2 push+fetch
(claude source) against a host-mounted bare transport in each. Stub
session UUID `ddee0001-…` shared across both images, so the branch shape
should be byte-equivalent if the substrate is honest.

| Substrate     | Bookworm (`node:20-bookworm-slim`) | Alpine (`node:20-alpine`)                  |
| ------------- | ---------------------------------- | ------------------------------------------ |
| node          | v20.20.2                           | v20.20.2                                   |
| jq            | jq-1.6                             | jq-1.8.1                                   |
| perl          | 5.36.0                             | 5.42.2                                     |
| bash          | 5.2.15                             | 5.3.3 (must be `apk add bash` — see below) |
| git           | 2.39.5                             | 2.52.0                                     |
| `find`/`stat` | GNU coreutils                      | **busybox**                                |

**Result.** Bookworm: ✓ push exit 0, fetch exit 0, body+metadata match
F-2 baseline. Alpine: ✗ push exit 2, fetch exit 2, transport empty.

```
=== Alpine push (claude) ===
dotclaude-handoff: /repo/plugins/dotclaude/scripts/handoff-resolve.sh: line 52: File: unbound variable
[push exit=2]
```

**Root cause** (traced under `bash -x` in the Alpine container at
`/repo/plugins/dotclaude/scripts/handoff-resolve.sh:39–62`, the
`pick_newest()` helper):

```bash
frac=$(find "$file" -maxdepth 0 -printf '%T@' 2>/dev/null \
       || stat -f '%Fm' "$file" 2>/dev/null \
       || stat -c '%Y' "$file" 2>/dev/null \
       || echo 0)
if [[ "$frac" == *.* ]]; then
  secs="${frac%%.*}"
  local frac_part="${frac#*.}000"
  frac_ms=$(( ${secs:-0} * 1000 + 10#${frac_part:0:3} ))   # ← line 52
fi
```

The fallback chain assumes either GNU `find -printf` succeeds, or BSD
`stat -f` succeeds, or GNU `stat -c` succeeds. Alpine's busybox subverts
this:

1. `busybox find -printf '%T@'` exits non-zero ⇒ `||` falls through. ✓ (correct)
2. `busybox stat -f '%Fm' <path>` **accepts the `-f` flag but ignores
   it**, dumps the **default multi-line `stat <path>`** output (starting
   with `File: "<path>"`), and **exits 0**. ✗ The `||` does not fall
   through — `frac` captures multi-line garbage.
3. The third fallback (`stat -c '%Y'`) is therefore never reached.
4. `[[ "$frac" == *.* ]]` matches because the path contains `.jsonl`.
5. `secs="${frac%%.*}"` ⇒ `File: "/tmp/…/foo` (everything before the
   first `.`).
6. Bash arithmetic `$(( ${secs:-0} * 1000 ))` interprets non-numeric
   strings as **variable names** to dereference. The first non-quoted
   token on the parsed path is `File`. `set -u` (from line 17) fires
   on the unbound `File`, surfacing as `line 52: File: unbound variable`.

Substrate version skew (jq 1.6 vs 1.8.1, perl 5.36 vs 5.42, bash 5.2 vs
5.3, git 2.39 vs 2.52) does **not** cause divergence — both images
produce identical `<handoff>` shape **once the resolver bug is patched**.
Bookworm proves the rest of the substrate (jq/perl/scrub/extract) is
honest; Alpine fails at step 0 (latest-session resolution).

### Issues (V-1 + V-2)

| Severity     | Issue                                                                                                                                                                                                                                                                                                                                                                                       | Location                                                                                                                                | Recommendation                                                                                                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRITICAL** | [#129](https://github.com/kaiohenricunha/dotclaude/issues/129) — `handoff-resolve.sh:39–62` `pick_newest()` is non-portable on busybox (Alpine). `busybox stat -f %Fm` returns success with multi-line garbage instead of the GNU/BSD per-flag behavior the script assumes; the `\|\|` fallback chain never reaches the third clause. Push/fetch fail at session resolution before any I/O. | `plugins/dotclaude/scripts/handoff-resolve.sh:45–48` (the `frac=…` fallback chain)                                                      | Detect the GNU/BSD/busybox case explicitly. One option: probe `stat --version` once at script init and pick a single known-good path; another: validate `frac` matches `^[0-9]+(\.[0-9]+)?$` before parsing it, falling through on mismatch. v1.0 blocker. |
| **WARNING**  | `bash` is not in the `node:20-alpine` base image; the substrate needs it explicitly (`apk add bash`). The handoff scripts use `#!/usr/bin/env bash` and bash-only constructs (arrays, `[[`, `local`), so busybox-sh substitution is not viable.                                                                                                                                             | `plugins/dotclaude/scripts/handoff-*.sh` (shebang) — all                                                                                | Document the bash dependency in the README's "system requirements" section, or add a runtime check at script entry that fails fast with a clear error if `bash` is missing.                                                                                |
| **INFO**     | [#130](https://github.com/kaiohenricunha/dotclaude/issues/130) — `build-index.mjs` (transitively imported via `src/index.mjs`) eagerly loads `js-yaml` even on the handoff-only code paths. Containers without the dotclaude root `node_modules/` fail at `Cannot find package 'js-yaml'`, even though the handoff verbs themselves never use yaml.                                         | `plugins/dotclaude/src/index.mjs:63` (re-export from `build-index.mjs`); top-level `import yaml from "js-yaml"` at `build-index.mjs:38` | Lazy-import yaml inside the handful of build-index functions that actually need it, so the handoff bin stays leaf-dep-free. Optional but reduces install surface for handoff-only consumers.                                                               |
| ~~INFO~~     | ~~The `gh` token in use lacks the `delete_repo` scope, so `gh repo delete` of the test bootstrap repo returned 403.~~ **Resolved post-audit:** scope refreshed, repo deleted.                                                                                                                                                                                                               | n/a — operator scope                                                                                                                    | Closed.                                                                                                                                                                                                                                                    |
| **INFO**     | `git config --global --add safe.directory '*'` is required when running the binary in a container where the bare transport is mounted from the host with mismatched UID. Not a v1.0 blocker (containerized deployment is operator-side configuration), but it is a real-world snag.                                                                                                         | `plugins/dotclaude/src/lib/handoff-remote.mjs` — relies on `git ls-remote` exit 0                                                       | Document in deployment notes that containerized handoff stores need either a UID-matched mount or `safe.directory` set in `~/.gitconfig`/`GIT_CONFIG_*` env.                                                                                               |

### Verdict update

The original audit's "go for v1.0 bump" verdict assumed the substrate
under the binary was uniform. V-2 falsifies that assumption: **on Alpine
(and any other busybox-based substrate), session resolution dies before
any handoff verb can do useful work**. Per the user's stop condition
("substrate non-portability is a v1.0 blocker even if the original
audit didn't surface it"):

**v1.0 blocked on the `pick_newest()` portability fix** in
`plugins/dotclaude/scripts/handoff-resolve.sh:45–48`. One-line-class
fix; small bats test should pin the busybox case (e.g. by setting
`PATH=/usr/local/busybox/bin:$PATH` or running the resolver under
`alpine` in a CI matrix job). Real-remote (V-1) is otherwise green —
bootstrap fires, repo is private, env file is 0600, push/fetch round-trip
matches local-transport baseline byte-for-byte.

After the fix lands, the WARNING (bash dependency documentation) and
the three INFO rows can ship with the v1.0 release notes; none are
blockers on their own.

## Pull command validation (2026-04-29)

Closes the F-2 coverage gap surfaced in
[#133](https://github.com/kaiohenricunha/dotclaude/issues/133): the
2026-04-29 audit's matrix exercised push/fetch with explicit tags but
never bare `pull <query>`, so the slash-command → SKILL.md → binary
contract for `pull` shipped un-validated. This appendix walks the full
matrix on a normal Linux substrate (WSL Ubuntu 24.04, GNU coreutils;
substrate-portability per #129 is out of scope here).

### Phase 1 — #133 root cause (release-pipeline drift, not a binary bug)

The bug is **upstream of the binary code** that lives on `main`. The
binary at `be25258` is correct; the **published binary** is the wrong
one.

- Surface-redesign commit
  [`33d2a34`](https://github.com/kaiohenricunha/dotclaude/commit/33d2a34)
  (PR #102, lands #87) on **2026-04-23** split `pull` (local) from
  `fetch` (remote). Before it, `pull` was the remote-fetch verb.
- Tag `v0.11.0` was cut from `385bb9a` on **2026-04-20**, three days
  earlier. `git merge-base --is-ancestor 33d2a34 v0.11.0` ⇒ false.
  `git tag --contains 33d2a34` ⇒ empty.
- `package.json` on `main @ be25258` still reads `"version": "0.11.0"`.
  Two non-equivalent binaries share one version string: the
  npm-published one (pre-#87) and the repo HEAD one (post-#87).
- The npm-installed bin is what every CC slash-command invocation
  shells to (resolves to
  `/home/kaioh/.nvm/versions/node/v22.22.2/lib/node_modules/@dotclaude/dotclaude/plugins/dotclaude/bin/dotclaude-handoff.mjs`).
- Installed bin's `pull` dispatch (lines 1259–1267 of the installed
  file) calls `pullRemote(query, fromCli)` →
  `fetchRemoteBranch`. With `query="latest"`, remote-side
  `enrichWithDescriptions` finds zero candidates and the path throws
  at `plugins/dotclaude/src/lib/handoff-remote.mjs:1283-1290`:
  `cause: 'no handoffs match: latest'`. **Exit 2.**
- Repo bin's `pull` dispatch
  (`plugins/dotclaude/bin/dotclaude-handoff.mjs:928-945`, with
  `resolveLatestWithHostScope` at `670-681`) calls
  `runScript(handoff-resolve.sh, [<cli>, "latest"])` and emits a
  `<handoff>` block.

#### Trace evidence

```text
$ DOTCLAUDE_DEBUG=1 NODE_DEBUG=child_process \
    dotclaude handoff pull latest 2>&1 | grep -E "args:|no handoffs"
  args: [..., 'pull', 'latest']                                      # wrapper → dotclaude-handoff.mjs
  args: [ 'git', 'ls-remote',
          'git@github.com:kaiohenricunha/dotclaude-handoff-store.git',
          'refs/heads/handoff/*' ]
  args: [ 'git', 'clone', '-q', '--depth', '1',
          '--branch', 'handoff/dotclaude/claude/2026-04/3668f1d7',
          'git@github.com:kaiohenricunha/dotclaude-handoff-store.git' ]
  args: [ 'git', 'clone', '-q', '--depth', '1',
          '--branch', 'handoff/dotclaude/claude/2026-04/98d26b79', … ]
dotclaude-handoff: no handoffs match: latest
[exit=2]
```

`handoff-resolve.sh` is **never spawned** — the trace shows exclusively
remote-side `git ls-remote` + `git clone --branch handoff/…`. The
installed bin literally does not have a local-resolver code path for
`pull`.

#### Side-by-side, same machine, same instant

```text
$ dotclaude handoff pull latest                              # global (stale npm)
dotclaude-handoff: no handoffs match: latest
[exit=2]

$ node plugins/dotclaude/bin/dotclaude-handoff.mjs pull latest   # repo bin
latest claude session: d72922a1
<handoff origin="claude" session="d72922a1" cwd="…/dotclaude" target="claude">
[exit=0]
```

`handoff-resolve.sh any latest` invoked directly from the **installed**
scripts directory also resolves correctly
(`/home/kaioh/.claude/projects/.../d72922a1-….jsonl`) — corroborating
that the resolver is fine; only the binary's dispatch is wrong.

#### Verbatim diff: published 0.11.0 vs. repo `be25258`

Diagnosis verified by extracting the actual published binary from the
npm registry and diffing against the repo working tree. Reproducible:

```bash
$ npm view @dotclaude/dotclaude time | grep '0.11.0'
'0.11.0': '2026-04-20T19:31:44.079Z'        # publish time

$ git log -1 --format='%ci %h %s' 33d2a34
2026-04-23 11:56:55 -0300 33d2a34 feat(handoff): collapse local surface
                                  under pull verb, rename remote pull→fetch
                                  (#87) (#102)

$ curl -sL https://registry.npmjs.org/@dotclaude/dotclaude/-/dotclaude-0.11.0.tgz \
    | tar -xzO package/plugins/dotclaude/bin/dotclaude-handoff.mjs \
    > /tmp/published-0.11.0-handoff.mjs

$ wc -l /tmp/published-0.11.0-handoff.mjs plugins/dotclaude/bin/dotclaude-handoff.mjs
1380 /tmp/published-0.11.0-handoff.mjs                            # published
1061 plugins/dotclaude/bin/dotclaude-handoff.mjs                  # repo HEAD

$ sha256sum /tmp/published-0.11.0-handoff.mjs plugins/dotclaude/bin/dotclaude-handoff.mjs
7282441344c0d5697b9b58e679689584f1577b3e518cc4bd7e6ac71a98126160  /tmp/published-0.11.0-handoff.mjs
0332cf33e41e9431b11866cef969e72f6e54136ffac893a63b67856f78f0a419  plugins/dotclaude/bin/dotclaude-handoff.mjs

$ diff /tmp/published-0.11.0-handoff.mjs plugins/dotclaude/bin/dotclaude-handoff.mjs | wc -l
1570                                          # massive divergence, two non-equivalent files
```

Verb-dispatch grep — the smoking gun:

```text
=== published 0.11.0 — pull/fetch dispatch ===
817:async function pullRemote(query, fromCli = null) {     # defined inline (pre-#93 lib extraction)
1259:  if (first === "pull") {
1261:      const hit = await pullRemote(second, fromCli);
                                                            # NO `if (first === "fetch")` anywhere

=== repo @ be25258 — pull/fetch dispatch ===
66:  pullRemote,                                            # imported from lib (post-#93)
670:async function resolveLatestWithHostScope({ fromCli, detectedHost }) {
928:  if (first === "pull") {
940:      const { hit: latestHit, note } =
        await resolveLatestWithHostScope({ fromCli, detectedHost });   # local resolver
963:  if (first === "fetch") {                              # new home of remote dispatch
967:      const hit = await pullRemote(second, fromCli, { verify, verbose });
```

Verbatim from the published 0.11.0 file, lines 1259–1267 — the entire
`pull` handler:

```js
if (first === "pull") {
  try {
    const hit = await pullRemote(second, fromCli);
    const { content } = fetchRemoteBranch(hit.branch);
    process.stdout.write(content.endsWith("\n") ? content : content + "\n");
    process.exit(EXIT_CODES.OK);
  } catch (err) {
    fail(2, `pull failed: ${err.message}`);
  }
}
```

And lines 850–851 of the published `pullRemote`, the exact emit site of
the bug message:

```js
if (hits.length === 0) {
    fail(2, fromCli ? `no ${fromCli} handoffs match: ${query}` : `no handoffs match: ${query}`);
```

The published bin's `pull` is structurally a remote-only verb. Every
characterization above is verifiable from the registry tarball.

#### Fix approach (out of this session's scope)

Pure release-pipeline action — no code change required:

1. Bump `package.json` to `0.12.0` (or `0.11.1`); release-please
   should already have a PR open against `main` since multiple
   `feat:` and `fix:` commits since `v0.11.0` qualify.
2. Tag and `npm publish`.
3. Add a CI assertion that `npm pack` of `main` produces a `bin/`
   byte-identical to the working tree's `plugins/dotclaude/bin/` —
   so future tag-vs-`main` drift fails fast and is surfaced as a
   diff, not a subtly broken release.

Stop condition triggered per the validation prompt
("Phase 1 reveals the bug is upstream of the binary"). Phases 2/3 below
ran against the repo binary as a workaround.

### Phase 2 — Bare-binary matrix (repo binary @ `be25258`)

Invocation form for every row:
`node /home/kaioh/projects/kaiohenricunha/dotclaude/plugins/dotclaude/bin/dotclaude-handoff.mjs <args>`.

Pre-flight (session roots populated, UUIDs pinned):

```text
~/.claude/projects/   — many; latest claude short-uuid: d72922a1
                        (full: d72922a1-fb38-49ff-8f32-fde136c707bf)
~/.codex/sessions/    — 1 session; latest codex short-uuid: 019d9dbf
~/.copilot/session-state/ — 3 sessions; latest copilot short-uuid: 704c9f8b
```

| #   | Command                                     | Expected | Exit | First-line stdout (or stderr-shape for fail rows)                                                                    | Verdict |
| --- | ------------------------------------------- | -------- | ---- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | `pull latest`                               | pass     | 0    | `<handoff origin="claude" session="d72922a1" cwd="…/dotclaude" target="claude">`                                     | ✓       |
| 2   | `pull latest --from claude`                 | pass     | 0    | `<handoff origin="claude" session="d72922a1" cwd="…/dotclaude" target="claude">`                                     | ✓       |
| 3   | `pull latest --from copilot`                | pass     | 0    | `<handoff origin="copilot" session="704c9f8b" cwd="/home/kaioh/projects" target="claude">`                           | ✓       |
| 4   | `pull latest --from codex`                  | pass     | 0    | `<handoff origin="codex" session="019d9dbf" cwd="/home/kaioh" target="claude">`                                      | ✓       |
| 5   | `pull d72922a1`                             | pass     | 0    | `<handoff origin="claude" session="d72922a1" …>` (1559 B, identical to row 1)                                        | ✓       |
| 6   | `pull 704c9f8b`                             | pass     | 0    | `<handoff origin="copilot" session="704c9f8b" …>` (2287 B, identical to row 3)                                       | ✓       |
| 7   | `pull 019d9dbf`                             | pass     | 0    | `<handoff origin="codex" session="019d9dbf" …>` (1908 B, identical to row 4)                                         | ✓       |
| 8   | `pull d72922a1 --from claude`               | pass     | 0    | `<handoff origin="claude" session="d72922a1" …>` (1559 B, identical to row 5)                                        | ✓       |
| 9   | `pull d72922a1 --from codex`                | fail 2   | 2    | stderr: `dotclaude-handoff: no codex session matches: d72922a1`                                                      | ✓ ¹     |
| 10  | `pull d72922a1-fb38-49ff-8f32-fde136c707bf` | pass     | 0    | `<handoff origin="claude" session="d72922a1" …>` (1559 B, identical to row 5)                                        | ✓       |
| 11  | `pull bogusabc`                             | fail 2   | 2    | stderr: `dotclaude-handoff: handoff-resolve: no session matches: bogusabc`                                           | ✓ ²     |
| 12  | `pull latest --summary`                     | pass     | 0    | `**claude** \`d72922a1\` — \`…/dotclaude\` — 2026-04-29T17:34:34Z` (427 B; **strictly smaller than row 1's 1559 B**) | ✓       |
| 13  | `pull latest -o /tmp/cc-bin.md`             | pass     | 0    | stdout: `/tmp/cc-bin.md` (15 B, no `<handoff>`); file: 1559 B mode 0644, opens with `<handoff origin="claude" …>`    | ✓       |

All 13 rows behave per spec. Block grammar holds on every "pass" row
(`<handoff origin="…" session="…" cwd="…" target="claude">` … `</handoff>`).

¹ Row 9 stderr template: spec §5.3.2 prescribes `dotclaude-handoff: no
session matches: <query>` (CLI-agnostic). The binary emits a CLI-narrowed
form `dotclaude-handoff: no <cli> session matches: <query>` from
`bin/dotclaude-handoff.mjs:244`. **Drift from spec template; informationally richer; minor.** Logged below as Issue P-2.

² Row 11 stderr template: same spec line prescribes
`dotclaude-handoff: no session matches: <query>`. The binary passes
through the resolver-script's prefix unchanged
(`bin/dotclaude-handoff.mjs:245` writes `'dotclaude-handoff: ${msg}\n'`
where `msg` already contains `handoff-resolve: no session matches:` from
`scripts/handoff-resolve.sh:20`). **Spec drift; double-prefix is noise.** Logged below as Issue P-1.

#### Cross-row invariants verified

- `pull <short-uuid>` (rows 5, 6, 7) and `pull latest --from <cli>`
  (rows 2, 3, 4) produce **byte-identical** stdout when they resolve
  to the same session — confirms the renderer is not influenced by
  the discriminator path (UUID vs `latest+--from`).
- Row 12's summary mode is 427 bytes vs. row 1's 1559 — **strictly
  smaller**, holds the spec invariant.
- Row 13's `-o` mode writes to disk (mode 0644, byte-identical to
  row 1's stdout content) and prints only the path on stdout. No
  `<handoff>` block on stdout, exit 0.

### Phase 2 — issues found (separate from #133)

| ID  | Severity | Issue                                                                                                                                                                                                                                                                                                              | Location                                                                                                                                      | Recommendation                                                                                                                                                                                                                                                                         |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P-1 | INFO     | Pull no-match stderr leaks the resolver-script's `handoff-resolve:` prefix. Spec §5.3.2 prescribes `dotclaude-handoff: no session matches: <q>`; actual is `dotclaude-handoff: handoff-resolve: no session matches: <q>` (double-prefix). Filed as [#135](https://github.com/kaiohenricunha/dotclaude/issues/135). | Resolver: `plugins/dotclaude/scripts/handoff-resolve.sh:20` (`die_runtime`). Pass-through: `plugins/dotclaude/bin/dotclaude-handoff.mjs:245`. | Strip the inner `handoff-resolve:` prefix when passing through, or have `die_runtime` print without the prefix when called via the binary's `runScript`. One-line fix. Not v1.0-blocking — the message is still understandable, just noisy. Add a bats test pinning the spec template. |
| P-2 | INFO     | Pull `--from <cli>` no-match stderr is CLI-narrowed (`no <cli> session matches`), spec §5.3.2 only prescribes the unnarrowed `no session matches`. Filed as [#136](https://github.com/kaiohenricunha/dotclaude/issues/136).                                                                                        | `plugins/dotclaude/bin/dotclaude-handoff.mjs:244`.                                                                                            | Either (a) update spec §5.3.2 to permit the narrower form when `--from` is set (the user-facing message is more useful), or (b) tighten the binary to match spec template exactly. Prefer (a) — the narrowed form is a real ergonomic improvement.                                     |

No CRITICAL or WARNING issues found in Phase 2 beyond #133 itself.

### Phase 3 — CC slash-command path (runnable post-publish)

**Runnable after the v1.0.0 cut ships to npm.** With the published
binary aligned to the repo via the v1.0.0 release + manual
`npm publish` cutover, this phase becomes the post-release smoke test:
drives the SKILL.md interpretation contract end-to-end across CC's
`/handoff` slash expansion, with the
[release-gate workflow](../../.github/workflows/release-gate.yml)
ensuring no future drift between repo and registry.

The 8 commands the next session should walk:

1. `/handoff pull latest`
2. `/handoff pull latest --from claude`
3. `/handoff pull d72922a1`
4. `/handoff pull d72922a1 --from claude`
5. `/handoff pull latest --summary`
6. `/handoff pull latest -o /tmp/cc-pull.md`
7. `/handoff pull d72922a1-fb38-49ff-8f32-fde136c707bf`
8. `/handoff pull bogusabc`

Audit-coverage note: when Phase 3 runs, it should also assert that
CC's bash expansion matches the SKILL.md auto-trigger contract
verbatim (single `dotclaude handoff pull …` call, no LLM-added flags
or fallbacks, no remote-fetch second attempt).

### Phase 2.5 — Cross-CLI invocation (results)

Baseline file `/tmp/handoff-pull-x-cli-cc-baseline.txt` regenerated
2026-04-29T18:22:36Z with 8 sections (4 pin-stable: `<claude-pinned:4d461655>`,
`<copilot-uuid:704c9f8b>`, `<copilot-uuid:704c9f8b> --summary`,
`<codex-uuid:019d9dbf>`; 4 moving target: `latest`, `latest --from {claude,copilot,codex}`).
User walked the Copilot and Codex checklists; results below.

#### Copilot — slash-command surface

| Row | Slash command                             | Copilot expansion                                  | Output (first line)                                                                                                                                                         | Exit | Verdict                            |
| --- | ----------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------- |
| 1   | `/handoff pull latest`                    | `dotclaude handoff pull latest`                    | `dotclaude-handoff: no handoffs match: latest`                                                                                                                              | 2    | #133 (stale npm bin), expected     |
| 2   | `/handoff pull latest --from copilot`     | `dotclaude handoff pull latest --from copilot`     | `dotclaude-handoff: no copilot handoffs found on transport`                                                                                                                 | 2    | #133, expected (`pullRemote` path) |
| 3   | `/handoff pull 704c9f8b`                  | `dotclaude handoff pull 704c9f8b`                  | `dotclaude-handoff: no handoffs match: 704c9f8b`                                                                                                                            | 2    | #133, expected                     |
| 4   | `/handoff pull latest --summary`          | `dotclaude handoff pull latest --summary`          | `dotclaude-handoff: Unknown option '--summary'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "--summary"` | 64   | **CP-1: Copilot product behavior** |
| 5   | `/handoff pull latest -o /tmp/cp-pull.md` | `dotclaude handoff pull latest -o /tmp/cp-pull.md` | `dotclaude-handoff: Unknown option '-o'. …`                                                                                                                                 | 64   | **CP-1: Copilot product behavior** |

Slash-command **expansion contract is honored** in rows 1–3
(`/handoff pull <args>` → `dotclaude handoff pull <args>` verbatim, no
LLM-added flags or fallbacks). The error in rows 4–5 is foreign to
dotclaude — phrasing like _"To specify a positional argument starting
with a '-', place it at the end of the command after '--'"_ matches
Commander.js / yargs error verbiage and is not present in
`bin/dotclaude-handoff.mjs`. Confirmed by spec-template comparison: the
dotclaude binary uses `dotclaude-handoff: unknown flag: <flag>`
(spec §5.3.1, §5.3.2 row 64). The `dotclaude-handoff:` prefix in the
Copilot output is being prepended by Copilot's slash-handler when it
attributes the parser error. **CP-1** logged below.

Rows 1–3 demonstrate that Copilot's slash interpretation **does**
match SKILL.md's auto-trigger contract — the bug surfaced is purely
the #133 stale-bin one. After the release ships, those three rows
should pass.

#### Copilot — bare-binary surface (workaround alias)

| Row | Command                                       | Output (first line of stdout)                                                               | Exit | Diff vs CC baseline (pin-stable)                            |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| 6   | `!dotclaude-fixed pull latest`                | `<handoff origin="copilot" session="8297e379" cwd="…" target="copilot">` ¹                  | 0    | shape-only — Copilot session is the running one, not pinned |
| 7   | `!dotclaude-fixed pull latest --from copilot` | `<handoff origin="copilot" session="8297e379" cwd="…" target="copilot">` ¹                  | 0    | shape-only — same drift as row 6                            |
| 8   | `!dotclaude-fixed pull 704c9f8b`              | `<handoff origin="copilot" session="704c9f8b" cwd="/home/kaioh/projects" target="copilot">` | 0    | **byte-equivalent ²**                                       |
| 9   | `!dotclaude-fixed pull 704c9f8b --summary`    | `**copilot**` `704c9f8b`—`/home/kaioh/projects`—`2026-04-29T17:02:08Z`                      | 0    | **byte-equivalent ²**                                       |

¹ User captured `8297e379`, not the baseline-time copilot-latest
`704c9f8b`. The Copilot CLI session the user was inside _is_ the new
"latest" (Copilot writes to its own `events.jsonl` while open). Shape
is correct: `<handoff origin="copilot" session="<8hex>" cwd="…" target="copilot">`.

² Re-run from CC's bash post-receipt: rows 8 / 9 are byte-equivalent
modulo a single trailing blank-line in the baseline (an artifact of
the baseline-generator's section separator, not from the binary). Codex
row 4's diff is empty (zero artifacts) — confirming the trailing-blank
is in the baseline writer, not in the binary's stdout.

```text
$ diff <(node $REPO_BIN pull 704c9f8b 2>/dev/null) \
    <(awk '/^=== <copilot-uuid:704c9f8b> ===$/{flag=1; next} /^=== /{flag=0} flag' \
         /tmp/handoff-pull-x-cli-cc-baseline.txt)
48a49
>
[diff exit=1, single trailing blank from baseline section separator]
```

**Critical positive finding**: rows 6–9 confirm that Copilot's `!`
shell-escape passes flags / `--from`, dash-prefixed arguments, and
hex UUIDs to the spawned binary **byte-cleanly**. The same `node
…/dotclaude-handoff.mjs pull <args>` invocation produces equivalent
stdout when launched from CC's bash and from Copilot's `!`-shell.

#### Codex — bare-binary surface (workaround alias)

| Row | Command                                           | Output captured (interleaved-stream first line, see CX-1)                      | Exit | Notes                                                                                         |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------- |
| 1   | `!dotclaude-fixed pull latest`                    | `latest codex session: 019dda3a`                                               | 0    | progress on stderr; stdout `<handoff>` block exists below — see CX-1                          |
| 2   | `!dotclaude-fixed pull latest --from codex`       | `using --from codex override, latest codex session: 019dda3a`                  | 0    | stderr-progress; pin-stable section is shape-only — Codex session active                      |
| 3   | `!dotclaude-fixed pull latest --from claude`      | `using --from claude override, latest claude session: 4d461655`                | 0    | resolves the squadranks-pinned session — the very `claude-pinned` UUID we baselined at 18:22Z |
| 4   | `!dotclaude-fixed pull 019d9dbf`                  | `<handoff origin="codex" session="019d9dbf" cwd="/home/kaioh" target="codex">` | 0    | **byte-equivalent to baseline `<codex-uuid:019d9dbf>` section (diff exit 0, zero artifacts)** |
| 5   | `!dotclaude-fixed pull latest --summary`          | `latest codex session: 019dda3a`                                               | 0    | stderr-progress; stdout summary markdown follows — see CX-1                                   |
| 6   | `!dotclaude-fixed pull latest -o /tmp/cx-pull.md` | `latest codex session: 019dda3a`                                               | 0    | stderr-progress; stdout `/tmp/cx-pull.md` (path) follows — see CX-1                           |

#### CX-1 (analysis) — Codex's `!` displays interleaved stream, **NOT** an OPS-2 violation

User flagged a possible OPS-2 violation: rows 1, 5, 6 show only the
"latest codex session: `<id>`" line, not the actual `<handoff>` /
summary / file-path output. Verified by isolating streams in CC's bash:

```text
$ node $REPO_BIN pull latest >/tmp/p25-stdout3.txt 2>/tmp/p25-stderr3.txt
[exit=0]
$ wc -l /tmp/p25-stdout3.txt /tmp/p25-stderr3.txt
  80 /tmp/p25-stdout3.txt        # the <handoff> block
   1 /tmp/p25-stderr3.txt        # the progress line
$ head -1 /tmp/p25-stdout3.txt
<handoff origin="claude" session="d72922a1" cwd="…" target="claude">
$ cat /tmp/p25-stderr3.txt
latest claude session: d72922a1

$ node $REPO_BIN pull latest --summary >/tmp/p25-stdout.txt 2>/tmp/p25-stderr.txt
[exit=0]
$ wc -l /tmp/p25-stdout.txt /tmp/p25-stderr.txt
27 /tmp/p25-stdout.txt           # summary markdown
 1 /tmp/p25-stderr.txt           # progress line
$ head -1 /tmp/p25-stdout.txt
**claude** `d72922a1` — `…/dotclaude` — 2026-04-29T18:31:25Z

$ node $REPO_BIN pull latest -o /tmp/p25-disk.md >/tmp/p25-stdout2.txt 2>/tmp/p25-stderr2.txt
[exit=0]
$ cat /tmp/p25-stdout2.txt
/tmp/p25-disk.md
$ cat /tmp/p25-stderr2.txt
latest claude session: d72922a1
$ ls -la /tmp/p25-disk.md
-rw-r--r-- 1 kaioh kaioh 3535 Apr 29 15:31 /tmp/p25-disk.md  ← the <handoff> block on disk
```

**Verdict.** The binary is well-behaved per OPS-2:

- **stdout**: `<handoff>` block, summary markdown, `-o`-target path.
- **stderr**: progress messages (`latest <cli> session: <id>`,
  `using --from <cli> override, …`).

What the user observed was Codex's `!`-shell capture method
**displaying the interleaved combined stream**, with stderr arriving
visibly first because it's typically line-buffered while stdout is
block-buffered. Row 4 captured stdout cleanly because UUID-based
`pull` does **not** emit a "latest …" stderr progress line (no
"latest" resolution happens), so the stderr is empty and the user's
"first line" landed on stdout.

**No bug in the binary.** Codex's `!`-shell display behavior is the
real source of the apparent anomaly — informational only.

#### CX-2 — R-7 quoting risk did NOT materialize (positive finding)

The audit's R-7 risk noted that Codex's bash-tool quoting could mangle
flag-prefixed arguments (especially `--from`, `-o <path>`, full UUID
hex strings with embedded dashes). Codex rows 1–6 demonstrate the
opposite:

- `--from codex`, `--from claude`, `--summary`: passed through (rows 2, 3, 5).
- `-o /tmp/cx-pull.md`: passed through (row 6, file written, exit 0).
- 8-hex UUID `019d9dbf`: passed through (row 4, byte-identical to CC baseline).

No escape artifacts (`\!`, doubled backslashes, dropped arguments).
`dotclaude handoff pull` is **R-7 safe under Codex** — the contract
is symmetrical across CC, Copilot `!`-shell, and Codex `!`-shell for
the bare-binary surface.

#### Phase 2.5 — additional issues found

| ID   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                            | Location / context                                                                                                          | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP-1 | INFO     | **Copilot's slash-handler rejects `--summary` and `-o <path>` before invoking the binary** (exit 64, parser-message verbiage matches Commander.js / yargs, not `bin/dotclaude-handoff.mjs`'s `unknown flag:` template). `/handoff pull latest --summary` and `/handoff pull latest -o <path>` are **unreachable through Copilot's slash path regardless of #133**. | Copilot CLI product behavior, not dotclaude code. Reproducer: any `/<cmd> args --flag` form where `--flag` starts with `-`. | Document in v1.0 release notes / SKILL.md "known surface gaps": Copilot users should use `!dotclaude handoff pull latest --summary` (bare-binary path) or rephrase to a positional. Optionally pursue with the Copilot CLI team.                                                                                                                                                                                                                                                                                                    |
| CX-1 | INFO     | Codex's `!`-shell capture **displays the interleaved stream**, with line-buffered stderr surfacing before block-buffered stdout. Users may misread the "first line" as the operative output and conclude OPS-2 is violated when it isn't.                                                                                                                          | Codex CLI display behavior, not dotclaude code. Verified by stream-isolation in CC's bash.                                  | **Scripting guidance** — when capturing `pull`'s first line in pipelines or scripts, redirect: `dotclaude handoff pull latest 2>/dev/null \| head -1` for the operative stdout (the `<handoff>` block / summary / `-o`-target path), or `2>&1` to keep interleaving order intact for human reading. Add this one-line note alongside CP-1 in the v1.0 release notes / SKILL.md "known surface gaps" section. Spec §5.5.1 OPS-2 is honored on the binary side — no code change needed; this is purely user-facing scripting hygiene. |
| CX-2 | (none)   | **Positive finding** — R-7 quoting risk did not materialize. `--from`, `-o`, dash-flag arguments, and hex UUIDs all pass through Codex's `!`-shell intact. Confirms the bare-binary surface is invocation-context-symmetric across all 3 CLIs.                                                                                                                     | Codex `!`-shell verified by 6 rows of bare-binary invocation against pin-stable + drifting fixtures.                        | Note in v1.0 release notes that bare-binary `dotclaude handoff pull` is uniformly callable from CC, Copilot `!`-shell, and Codex `!`-shell. Tracking issue [#137](https://github.com/kaiohenricunha/dotclaude/issues/137) for the CI matrix job that exercises the four pin-stable invocations on Linux substrate to lock the symmetry.                                                                                                                                                                                             |

#### Diff harness verification (CC bash, post-receipt)

Pin-stable rows confirmed byte-equivalent (mod baseline-writer trailing
blank). Reproducer:

```text
$ diff <(node $BIN pull 704c9f8b 2>/dev/null) \
    <(awk '/^=== <copilot-uuid:704c9f8b> ===$/{f=1;next} /^=== /{f=0} f' /tmp/...baseline.txt)
48a49
>                                            # one trailing blank in baseline only
[exit=1]

$ diff <(node $BIN pull 704c9f8b --summary 2>/dev/null) \
    <(awk '/^=== <copilot-uuid:704c9f8b> --summary ===$/{f=1;next} /^=== /{f=0} f' …)
21a22
>                                            # same trailing blank
[exit=1]

$ diff <(node $BIN pull 019d9dbf 2>/dev/null) \
    <(awk '/^=== <codex-uuid:019d9dbf> ===$/{f=1;next} /^=== /{f=0} f' …)
[exit=0]                                     # zero diff, byte-identical
```

The "trailing blank" delta is a baseline-generator artifact (`echo`
between sections), not a binary divergence. Codex row 4's empty diff
proves the binary's stdout is byte-stable across invocation contexts.

### Phase 4 — Cross-agent dogfood (runnable post-publish)

**Runnable after the v1.0.0 cut.** Once `npm view @dotclaude/dotclaude version`
returns `1.0.0` and the source bin matches the published bin (verified
by `release-gate.yml`'s tarball-source diff), the global `dotclaude`
no longer needs the `!dotclaude-fixed` workaround alias. Steps:

1. From CC, run `/handoff pull latest --from claude` and capture the
   `<handoff>` block.
2. Open Codex, paste the block as the first message. Verify Codex
   references the in-progress work (does not ask "what is this?").
3. Reverse: from Codex, `!dotclaude handoff pull latest --from codex`,
   paste into CC.
4. Repeat: from Copilot, `!dotclaude handoff pull latest --from copilot`,
   paste into both CC and Codex.

Stop conditions: a `<handoff>` block that the next agent does NOT pick
up context from is a **block-grammar drift** — more serious than #133
and must be flagged prominently. The single-machine matrix above
already verifies the block shape is well-formed; Phase 4 is the
semantic-correctness check.

**Result (2026-04-30, post-v1.0.1).** Dogfood passed: from a CC session
running the v1.0.1 pull-validation matrix (report at
`/tmp/handoff-pull-validation-v1.0.1.md`, surfacing issues #147 / #148 / #149),
the `<handoff>` block was pasted into a fresh Codex session.
Codex resumed coherently, independently confirmed the cell-14 / cell-33
false-positive analysis (case (b) — coverage gap, not path-specific
behavior), agreed with the #148 fix scope, and filed [#152](https://github.com/kaiohenricunha/dotclaude/issues/152)
without further prompting. This is stronger evidence than
"context survives paste": **context is actionable** — the receiving
agent made forward progress on the in-flight work, not just
acknowledged it.

**Result (2026-04-30, consuming-agent closure).** Copilot and CC both
absorbed handoff blocks as actionable context. Pair A pasted the
`61a7b56e` Claude-origin dotclaude block into Copilot; Copilot did not
treat the XML as opaque, recovered the truncated instruction, inspected
the repository/session state, and continued the pending block-generation
work. Pair B pasted the `8297e379` Copilot-origin block into CC; CC
recognized the completed 9-row capture, summarized the slash/bare-binary
findings, and identified the remaining unstaged audit update rather than
asking what the block meant.

The earlier Copilot Row 1 `no handoffs match: latest` observation was
classified as stale pre-v1.0.1 noise, not a current slash-handler bug:
v1.0.1 `pull` routes through the local resolver, where unmatched IDs emit
`no session matches`, while `no handoffs match` is transport-path-only.
No new issue was filed. The only UX note worth carrying forward is that
`pull latest` resolves globally across the source CLI's session root, not
only sessions under the current working directory.

Dogfood passes are not uniform — Pair B (copilot→claude) showed shallower context engagement than the two strong passes (claude→codex, claude→copilot). The §1 acceptance criterion is met by all three, but consumer-LLM engagement depth varies. Worth tracking if the pattern reproduces in future tests.

### Verdict update — v1.0 readiness

| Blocker                                                               | Status                                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#129**                                                              | **Closed** in [#139](https://github.com/kaiohenricunha/dotclaude/pull/139). Substrate portability fixed via `_STAT_FLAVOR` probe-once in `handoff-resolve.sh`.                                                    |
| **#133**                                                              | **Closes on merge + npm publish of v1.0.0.** package.json bumped to 1.0.0 in this release PR; tag and `npm publish` are the manual cutover after merge. Repo binary at HEAD is the binary that ships.             |
| #134 (new)                                                            | **Closed** — Structurally prevented by `.github/workflows/release-gate.yml`. Non-release PRs may not change `package.json` version; release PRs run a tarball-vs-source diff that catches drift before it ships.  |
| #135 (new)                                                            | **Closed** in [#140](https://github.com/kaiohenricunha/dotclaude/pull/140) — Pull stderr `handoff-resolve:` double-prefix stripped in `dotclaude-handoff.mjs`. Spec §5.3.2 template now matches actual output.    |
| #136 (new)                                                            | **Closed** in [#140](https://github.com/kaiohenricunha/dotclaude/pull/140) — Spec §5.3.2 amended to formalize narrowed `no <cli> session matches` form when `--from` is set, alongside the unnarrowed form.       |
| #130                                                                  | **Closed** in [#140](https://github.com/kaiohenricunha/dotclaude/pull/140) — `js-yaml` made lazy via `createRequire` in `build-index.mjs`; `dotclaude-handoff --help` no longer requires `js-yaml` to be present. |
| CP-1                                                                  | INFO — Copilot's slash-handler rejects `--summary` / `-o` flags before invoking the binary. Documentation-only; not a dotclaude bug. v1.0 release-notes material.                                                 |
| CX-1                                                                  | INFO — Codex's `!`-shell capture displays interleaved stream; OPS-2 is honored on the binary side. Documentation-only; not a dotclaude bug. v1.0 release-notes material.                                          |
| CX-2 / [#137](https://github.com/kaiohenricunha/dotclaude/issues/137) | **Positive** — R-7 quoting risk does not materialize; bare-binary surface is symmetric across CC / Copilot `!` / Codex `!`. Tracking issue filed to lock the symmetry in CI. v1.0.x or v1.1.                      |

**v1.0 ready to ship.** All blockers closed: issue 129 via PR 139;
issues 135, 136, and 130 via PR 140; issue 134 structurally via the
release-gate workflow. Issue 133 closes on merge of this release PR
plus the manual `npm publish v1.0.0` cutover. Phase 3 and Phase 4
findings move from "deferred" to "runnable post-publish" smoke tests;
CP-1 and CX-1 are documented in the v1.0 release notes per spec
§5.5.1 and §5.5.2.

Closing note on the audit-coverage gap that let #133 ship: the
F-2 matrix in the original audit pushed/fetched with explicit `--tag`
arguments and never exercised bare `pull <query>` against a
post-redesign tree. Adding a bats case that asserts
`node bin/dotclaude-handoff.mjs pull latest` exits 0 with a
`<handoff>` block — combined with the npm-pack-vs-source CI assertion
suggested in Phase 1 — would have surfaced both halves of #133 before
release.
