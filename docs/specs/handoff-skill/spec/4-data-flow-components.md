# §4 — Data Flow / Components

> Walk-throughs of the three primary commands plus the remote-taxonomy
> lifecycle. Supporting commands are one-line summaries pointing into §5
> for the I/O contract — they exist to feed the primaries, not to compete
> for surface real estate.

## Current State (brief)

Today's binary mixes the public surface (eleven sub-commands across two
verbs and a bare-positional form) with implementation flow. Most of the
substrate (per-CLI resolvers, jq filters, scrub patterns, description
schema) is solid and frozen per §2. The reshape is at the dispatch +
naming + flag layer; the data flow downstream of "we know which session
file to read" is largely preserved.

## Component Boundaries (brief)

Recap from §3: the binary owns argv parsing, dispatch into the three
primary verbs, and rendering / scrubbing through the shared library.
The shell substrate owns per-CLI session resolution and JSONL extraction.
The shared library owns the transport (git operations) and the
description-encoding round-trip. No data-flow responsibilities cross
those lines.

## Shared State

| State                                                                    | Lifetime              | Read by                                     | Written by                |
| ------------------------------------------------------------------------ | --------------------- | ------------------------------------------- | ------------------------- |
| `$DOTBABEL_HANDOFF_REPO` (env)                                           | shell process         | every `push` / `fetch` / `list -r`          | self-bootstrap            |
| `$XDG_CONFIG_HOME/dotbabel/handoff.env`                                  | persistent, mode 0600 | binary startup (sourced)                    | self-bootstrap (one-time) |
| `~/.claude/projects/`, `~/.copilot/session-state/`, `~/.codex/sessions/` | persistent            | `pull`, `push --query`, `search`, `list -l` | the host CLIs themselves  |
| `$DOTBABEL_HANDOFF_REPO`'s `handoff/...` branches                        | persistent            | `fetch`, `list -r`                          | `push`                    |

No in-process caches, no daemons, no inter-invocation state on the local
filesystem beyond the persisted env file.

---

## Target Architecture

### 4.1 `pull <query>` — cross-agent same-machine

The user is in agent T (target), wants to pull session `<query>` from
agent S (source) on the same machine. T is implicit; S is resolved.

```
INPUT:  dotbabel handoff pull <query> [--from <cli>]

 1. Argv parse. <query> is the only positional. --from is optional.
    No --to. Exit 64 if any unknown flag.

 2. Source resolution (ARCH-3):
    a. If --from given:
         handoff-resolve.sh <cli> <query>   → one path or exit 2.
    b. Else:
         handoff-resolve.sh any <query>     → 0/1/many.
         - 0    → exit 2 ("no session matches: <query>").
         - 1    → continue.
         - many → TTY prompt | non-TTY exit 2 + TSV candidates.

 3. The resolver returns an absolute JSONL path. The path's root
    determines the source CLI (KD-5: path-based source detection — the
    path can't lie about which root it came from).

 4. Extract:
       handoff-extract.sh meta    <cli> <path>   → {session_id, short_id,
                                                    cwd, model, started_at}
       handoff-extract.sh prompts <cli> <path>   → user prompts
       handoff-extract.sh turns   <cli> <path> 20 → assistant tail

 5. Render <handoff origin="<src-cli>"
                    session="<short-id>"
                    cwd="<cwd>">…</handoff>
    The block carries one Next-step line, generic across targets. No
    per-target branching (--to was removed; the target is whoever
    pastes the block).

 6. Stdout: the block, exit 0.

OUTPUT: <handoff>...</handoff> on stdout.
```

No transport, no scrubbing, no remote calls. `pull` is local-only by
definition.

#### 4.1.1 Session-validity rules

The resolver in step 2 only treats a session as discoverable when its
per-CLI **marker file** is present. Directories without the marker are
invisible to `pull`: `latest` skips them, and a UUID prefix that points
at one returns exit 2 ("no session matches"). This is by design — a
session without its event log has no replayable content.

| CLI     | Root                            | Required marker file                     |
| ------- | ------------------------------- | ---------------------------------------- |
| claude  | `~/.claude/projects/<slug>/`    | any `*.jsonl` (typically `<uuid>.jsonl`) |
| copilot | `~/.copilot/session-state/`     | `<uuid>/events.jsonl`                    |
| codex   | `~/.codex/sessions/YYYY/MM/DD/` | `rollout-<ts>-<uuid>.jsonl`              |

Implications:

- An incomplete copilot directory (`workspace.yaml`, `checkpoints/`,
  `files/`, `research/`, but no `events.jsonl`) is treated as if the
  directory did not exist. `pull <its-prefix>` returns exit 2.
- `pull latest` falls through to the next-newest session whose marker
  exists; the incomplete dir's mtime does not advance the candidate set.
- If every session in a root is incomplete, `pull latest --from <cli>`
  returns exit 2 with `no <cli> session matches: latest` per §5.3.2.
- If every session across every root is incomplete or absent,
  `pull latest` (no `--from`) returns exit 2 with
  `no session matches: latest`.

### 4.2 `push [<query>] [--tag <label>...] [--from <cli>]` — upload to remote

```
INPUT: dotbabel handoff push [<query>] [--tag a [--tag b ...]] [--from <cli>]

 1. Argv parse.
    - <query> optional positional.
    - --tag may repeat (multi-tag, PR #107).
    - --from optional UNLESS no <query> is given (ARCH-3 mandatory rule).
    - Exit 64 with usage hint if both <query> and --from are absent.

 2. Source resolution (ARCH-3):
    - <query> given:  same path as `pull` step 2 (search across roots,
                      --from narrows).
    - No <query>:     handoff-resolve.sh <from-cli> latest.

 3. Transport ready-check:
       requireTransportRepo()
         - If $DOTBABEL_HANDOFF_REPO set → validate URL, return.
         - Else if TTY + gh authenticated → bootstrap interactively
           (gh repo create --private, persist URL, set env).
         - Else → exit 2 with manual-setup block.

 4. Extract meta + prompts + turns (same as 4.1 step 4).

 5. Render <handoff>…</handoff> block.

 6. Scrub (FAIL-CLOSED):
       handoff-scrub.sh < block > scrubbed
         - Eight perl regex passes (frozen substrate).
         - Reports `scrubbed:N` on stderr.
         - Any non-zero exit, missing perl, or absent count line →
           push aborts with exit 2 and nothing reaches the remote.
       metadata.scrubbed_count = N.

 7. Compute taxonomy fields:
       project = projectSlugFromCwd(meta.cwd)
                 (git rev-parse --show-toplevel of cwd, slugified, or "adhoc")
       month   = monthBucket(now-utc)             → "YYYY-MM"
       host    = slugify(hostname())
       cli     = source CLI (from step 2)
       short   = meta.short_id (8 hex)

 8. Encode description:
       handoff-description.sh encode --cli <cli> --short-id <short>
                                     --project <project> --hostname <host>
                                     --month <month> [--tag <label>]
       → handoff:v2:<project>:<cli>:<YYYY-MM>:<short>:<host>[:<tag>]

 9. Branch: handoff/<project>/<cli>/<month>/<short>.

10. KD-1 (force-push policy): the branch may already exist (re-push of
    the same source UUID within the same month). Force-push and
    overwrite. The branch represents "the latest handoff for this
    UUID + month"; metadata.json.created_at reflects this push.
    Pre-push commit GC'd by GitHub eventually. History across pushes
    is not preserved by branch lineage; users who want a paper trail
    use distinct tags per push.

11. KD-2 (tag mutability): if --tag is passed:
    - Multi-tag (--tag a --tag b) → all attached to the same commit.
    - Re-push with --tag <existing> → tag MOVES to the new commit
      (mutable, addressable label, not an immutable release).
    - Tags live flat under refs/tags/<label>; no namespacing.

12. Operation:
       mkdtemp; git init -q
       git remote add origin $DOTBABEL_HANDOFF_REPO
       git checkout -q -b handoff/<project>/<cli>/<month>/<short>
       write handoff.md (scrubbed block)
       write metadata.json
       write description.txt (the handoff:v2:… string)
       git add . && git commit -q -m "<description>"
       git push -q -f origin <branch>
       for each --tag: git tag -f <label> && git push -q -f origin tag <label>

13. Stdout:
       <branch>
       <repo-url>
       <description>
       [scrubbed N secrets]
    Exit 0.

OUTPUT: branch + url + description + scrub count, one per line.
```

### 4.3 `fetch <query> [--from <cli>]` — download from remote

```
INPUT: dotbabel handoff fetch <query> [--from <cli>]

 1. Argv parse. <query> mandatory; matches against tag, branch suffix,
    commit prefix, or description substring. --from optional, narrows
    cli segment.

 2. Read-only transport check:
       requireTransportRepoStrict()
         - $DOTBABEL_HANDOFF_REPO must be set; no bootstrap. Exit 2 if
           unset (fetch on a fresh machine: user runs `push` first or
           sets the env var).

 3. List remote refs:
       git ls-remote $DOTBABEL_HANDOFF_REPO refs/heads/handoff/* refs/tags/*

 4. Match priority (KD-4: same prompt-or-exit-2 model as `pull`):
    a. Exact tag: refs/tags/<query>.
    b. Branch full match: refs/heads/handoff/<query>.
    c. Branch trailing-short match: any refs/heads/handoff/.../*/<query>.
    d. Commit prefix match: any commit hash whose first chars match.
    e. Description substring match: requires per-branch `description.txt`
       fetch; capped at 20 candidate fetches before bailing with
       "too many candidates, narrow the query".
    f. --from filter: drop candidates whose <cli> path-segment doesn't
       match.

 5. Disambiguation:
    - 0 hits  → exit 2 ("no remote handoffs match: <query>").
    - 1 hit   → continue with that branch.
    - 2+ hits → TTY prompt | non-TTY exit 2 + TSV candidates.

 6. Shallow clone:
       mkdtemp
       git clone -q --depth 1 --branch <branch> $DOTBABEL_HANDOFF_REPO .
       read tmp/handoff.md verbatim.

 7. Stdout: handoff.md content (already a complete <handoff>…</handoff>
    block, scrubbed at push time). Exit 0.

OUTPUT: <handoff>...</handoff> on stdout.
```

### 4.4 Remote taxonomy lifecycle

How the store evolves over time, end-to-end:

```
INITIAL STATE: empty private repo.
    First `push` → requireTransportRepo prompts gh repo create.
    Repo created with default `main` branch.
    Bootstrap optionally writes a README.md to `main` describing the
    store (small, idempotent, gives the GitHub UI a non-empty default).
    `main` is never written to again by push/fetch/list.

FIRST PUSH (project=dotbabel, cli=claude, month=2026-04, short=aaaa1111):
    refs/heads/handoff/dotbabel/claude/2026-04/aaaa1111
    └── handoff.md, metadata.json, description.txt
    Optional refs/tags/<label> if --tag was passed.

RE-PUSH OF SAME SESSION, SAME MONTH:
    Same branch path (deterministic from project+cli+month+short).
    Force-push overwrites the commit (KD-1).
    metadata.created_at reflects the latest push.

RE-PUSH OF SAME SESSION, NEXT MONTH:
    NEW branch under .../2026-05/aaaa1111. Month bucket roll-over
    creates a new branch; the old one stays under 2026-04 (until the
    user GCs it). This bounds any single ls-remote prefix.

MULTIPLE SESSIONS, SAME PROJECT/CLI/MONTH:
    refs/heads/handoff/dotbabel/claude/2026-04/aaaa1111
    refs/heads/handoff/dotbabel/claude/2026-04/bbbb2222
    refs/heads/handoff/dotbabel/claude/2026-04/cccc3333
    Each ls-remote returns all three; user filters via search/list/fetch.

TAG LIFECYCLE:
    Multi-tag at push: --tag auth-fix --tag eod attaches both to the
    same commit on the branch.
    Re-push with --tag auth-fix → auth-fix retargets to the new commit.
    Tags are flat under refs/tags/. No `handoff/<tag>` namespace
    prefix; the user knows their tags belong to handoff because they
    typed --tag.

STORE GROWTH OVER TIME:
    1 user × 5 projects × daily handoffs × 12 months ≈ 1800 branches
    spread across 60 month-buckets. ARCH-9 budget (≤ 1000 branches in
    < 2s for full ls-remote) covers a year of moderate use; project +
    month bucketing keeps any sub-tree fast indefinitely.

RETENTION:
    KD-3: out of scope. The store grows forever by default. The user
    manages retention with regular git operations (git push --delete,
    gh api DELETE refs/..., or a one-off shell loop). No `prune`
    sub-command ships with this spec — adding one is a future delta,
    not a now-feature.
```

### 4.5 Supporting commands (one-liners)

These exist to feed the primary jobs. Output contracts and exact flag
shapes are pinned in §5; here, just what they do:

- **`list [--local|--remote]`** — local sessions across the three roots
  and/or remote handoff branches, unified into one table; exists so the
  user can see what's available before running `pull` or `fetch`.
- **`search <text> [--cli <c>] [--since <ISO>] [--limit <N>]`** —
  substring/regex match across local session content; exists so
  "I forgot the UUID but remember the topic" turns into a `pull` target.
- **`describe <query> [--from <cli>]`** — preview a session without
  rendering the full block; exists so the user can confirm "yes, this
  is the session I want" before pasting.
- **`doctor`** — verify the remote transport is reachable; exists to
  diagnose `push` / `fetch` failures without exposing the user to raw
  git error output.

Any command not in §4.1 / 4.2 / 4.3 / 4.4 / 4.5 is gone (the v0.10
surface had `digest`, `file`, `resolve`, `remote-list` — see §6 for
the migration table that retires them).

---

## Key Decisions

Tagged decisions that bind the rest of the spec; later sections must not
contradict these without amending here.

### KD-1 — Re-push of same UUID + month: update branch (force), but with a collision probe

The branch `handoff/<project>/<cli>/<YYYY-MM>/<short>` represents "the
latest handoff snapshot for this session UUID in this month-bucket."
Re-pushes by the same UUID update (force-push) the branch.
`metadata.json.created_at` reflects the most recent push, not the
original session's start time. History across re-pushes is **not**
preserved by branch lineage; users who need a paper trail rely on
git's reflog or push with distinct `--tag` labels.

The 8-hex `short_id` is a prefix and can theoretically collide between
two distinct session UUIDs. Before pushing, the binary fetches the
existing branch's `metadata.json.session_id` and compares it to the
local session_id:

- Branch absent → **create** mode, non-force push (so a racing session
  produces a non-fast-forward error rather than a silent clobber).
- Branch present, same `session_id` → **update** mode, force-push.
- Branch present, different `session_id` → **exit 2** with the
  collision details. `--force-collision` overrides for the rare case
  the user actually wants to overwrite.

**Reasoning**: branch-per-push would explode `ls-remote` for hot
sessions and undermine ARCH-9's scalability budget. The single-branch
model means `fetch <short>` always resolves to "current state" without
disambiguation. The collision probe is the safety net against the
1-in-2^32 short-prefix collision between distinct UUIDs — the binary
refuses to silently overwrite a stranger's branch.

### KD-2 — Tags are mutable addressable labels, materialized as `refs/tags/<label>` and mirrored in the description and `metadata.tags`

`push --tag <label>` (repeatable, or comma-joined) creates or updates
a remote tag ref at `refs/tags/<label>` pointing at the pushed handoff
commit. The same tag list is also written into the branch's description
string and `metadata.tags` as mirrored metadata for post-fetch
inspection and UX. Re-pushing with a new tag list rewrites the metadata
and description on the same branch, and any reused labels retarget by
updating their corresponding `refs/tags/<label>` refs.

`fetch <label>` resolves via `refs/tags/<label>` first (via
`git ls-remote refs/tags/<label>`), then fetches the tagged commit and
reads the branch metadata/description as confirmation and context.
Multi-tag syntax: `--tag a --tag b` (repeated flag) or `--tag a,b`
(comma-joined).

**Reasoning**: tags are how the user addresses semantic snapshots
("end-of-day", "auth-fix"). Immutability would force the user to invent
a new label each push, which destroys their addressing scheme. Encoding
tags as real `refs/tags/<label>` refs keeps fetch/list behavior aligned
with standard Git primitives and with `git ls-remote refs/tags/*`, while
the mirrored description/`metadata.tags` preserves the richer handoff
metadata on the branch itself.

### KD-3 — Store retention is the user's job, not the skill's

The remote grows forever by default. No automatic GC, no `prune`
sub-command, no TTL on branches. Users with full stores run
`git push --delete origin <branch>` or batch-delete via `gh api`.
Surfacing a `prune` is a future delta if user demand justifies it.

**Reasoning**: prune is a destructive operation with no obvious
default policy (delete-by-age? by project? keep-tagged?). Shipping
defaults wrong is worse than not shipping defaults. The user has
explicitly de-scoped this.

### KD-4 — `fetch` ambiguity resolves with the same model as `pull`

When `fetch <query>` matches multiple refs (tags, branches, descriptions,
or commits), the disambiguation is:

- TTY → numbered prompt.
- Non-TTY → exit 2 with TSV candidate list on stderr.

No silent first-match, no "newest wins" heuristic, no special-casing.

**Reasoning**: symmetry with `pull`'s resolution means one mental model
for "I gave the binary an ambiguous identifier." Heuristic
tie-breakers introduce silent failure modes.

### KD-5 — Source CLI is determined by path, not by env

Once the resolver returns an absolute JSONL path, the path's root
prefix (`~/.claude/projects/`, `~/.copilot/session-state/`,
`~/.codex/sessions/`) is the authoritative source-CLI signal. The
binary never asks the environment "which agent are we in" except
through `--from`, and only on the `push --no-query` path.

**Reasoning**: paths can't lie. Env-vars admit `UNCONFIRMED` status
in their own probe code. Eliminating env-detection eliminates the
"silently picks wrong source" failure mode §1 was written to stop.

### KD-6 — SKILL.md auto-trigger contract pre-fills `--from`

The skill markdown explicitly instructs Claude / Copilot host LLMs to
include `--from <its-own-cli-name>` when invoking `dotbabel handoff
push` without a query. The host LLM trivially knows its own identity;
this turns the binary's mandatory `--from` into invisible-to-the-user
plumbing for the slash-command surface, while keeping the binary's
contract single-pathed.

**Reasoning**: closes the gap between "binary is honest about needing
the source pinned" and "user shouldn't have to type ceremony." The
host LLM is the right place to fill the flag because it's the only
component that always knows the answer with certainty.

### KD-7 — SKILL.md auto-trigger contract forbids fabrication when the binary cannot run

The skill markdown explicitly instructs host LLMs (Claude / Copilot /
Codex) that when the `dotbabel handoff` binary cannot be executed —
for any reason: permission denied, sandbox restriction, binary
missing, network failure — they MUST NOT reconstruct a `<handoff>`
block from raw session JSONL files. The required behavior is a
three-step protocol: report the tool-execution error verbatim,
instruct the user to run the command manually, and stop. ARCH-10's
drift test asserts the rule stays present in `skills/handoff/SKILL.md`
across edits, the same way the symbol-list intersection guards the
`--from` rule from KD-6.

**Reasoning**: the binary is the authoritative producer of `<handoff>`
blocks — it owns the scrub passes, the extraction shape, and the
metadata schema the transport depends on. Fabricated blocks may be
schema-valid but bypass scrubbing entirely, exposing secrets if
pushed; they also synthesize content from raw transcripts without
the per-CLI extraction normalization §4.1 step 4 specifies. The host
LLM is the only component that observes the failed invocation, so it
is the right place to enforce the rule.
