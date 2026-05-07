---
id: post-pr-review
name: post-pr-review
type: skill
version: 0.1.0
domain: [devex]
platform: [github-actions]
task: [review]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-05-07
updated: 2026-05-07
description: >
  Post AI-generated review findings on a GitHub PR as inline review comments
  via the gh CLI — the bot-style review-comment workflow GitHub Copilot used
  to provide before it got rate-limited. Idempotent (hidden marker dedup),
  rate-limit conscious (respects GitHub's 80/min secondary limit), and
  dry-run by default in interactive mode. Pairs with `review-pr`, which
  consumes the comments this skill produces and applies fixes.
  Triggers on: "post PR review", "leave inline comments on PR",
  "AI review and comment on PR", "Copilot-style PR review".
argument-hint: "[PR#] [--dry-run] [--auto --confirm-post] [--mode review|inline] [--max-comments N] [--summary-only] [--event COMMENT|REQUEST_CHANGES|APPROVE] [--agents <csv>]"
tools: Bash, Read, Grep, Glob, Task
model: sonnet
effort: medium
---

Post AI review findings on a GitHub PR as inline comments. The producer side
of a producer/consumer pair — `review-pr` is the consumer.

## Argument grammar

| Flag                | Default                                                      | Notes                                                  |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `<PR#>` positional  | autodetect from current branch                               | optional                                               |
| `--repo OWNER/REPO` | autodetect                                                   | needed for fork PRs                                    |
| `--agents <csv>`    | `default-set`                                                | dotbabel agents to dispatch (see step 5)               |
| `--max-comments N`  | `25`                                                         | hard cap; >25 requires explicit override               |
| `--event`           | `COMMENT`                                                    | `COMMENT` / `REQUEST_CHANGES` / `APPROVE`              |
| `--mode`            | `review`                                                     | `review` (atomic batch) or `inline` (per-comment loop) |
| `--summary-only`    | off                                                          | skip inline comments, post one top-level body          |
| `--auto`            | off                                                          | skip confirmation prompt                               |
| `--dry-run`         | **on** in interactive; off only with `--auto --confirm-post` | prints what would be posted                            |
| `--confirm-post`    | off                                                          | required alongside `--auto` to actually POST           |

## Workflow

Before any step, bind args:

```bash
NUMBER="$ARGUMENTS"           # may be empty if autodetecting from branch
SCRIPTS="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}/plugins/dotbabel/scripts"
SCRATCH="${TMPDIR:-/tmp}"     # honors sandboxes that block /tmp; private to orchestrator
```

### 1. Resolve PR

```bash
"$SCRIPTS/post-pr-review-resolve.sh" "$NUMBER"
```

Output: JSON `{number, headRefOid, state, isDraft, headRepository, baseRepository, isCrossRepository, url}`.

Bind from the resolve output and **thread `--repo` through every subsequent script** so they don't each pay the `gh repo view` lookup cost (~100ms per script):

```bash
PR=$(... | jq -r .number)
HEAD_SHA=$(... | jq -r .headRefOid)
REPO=$(... | jq -r '"\(.baseRepository.owner.login)/\(.baseRepository.name)"')
GH_REPO_ARGS=(--repo "$REPO")    # pass to every downstream script
```

If autodetection fails, abort with: `No PR found. Pass PR# explicitly: /post-pr-review 123`.

### 2. Preflight gates

- `gh auth status` — fail at preflight if missing.
- `state == OPEN` — refuse closed/merged. No `--force`.
- `isDraft` — warn + prompt; `--auto` proceeds.
- `isCrossRepository == true` — warn the user that posting may 403 if they
  lack write access to the base repo.

### 3. Fetch context

```bash
"$SCRIPTS/post-pr-review-fetch-context.sh" "$PR" "${GH_REPO_ARGS[@]}" \
  > "$SCRATCH/post-pr-review-${PR}.ctx.json"
```

Reads PR diff (`gh pr diff`) into `$SCRATCH/post-pr-review-${PR}.diff` (where
`$SCRATCH=${TMPDIR:-/tmp}`) and emits JSON with `headSHA`, `diffPath`,
`files`, `title`, `body`. The exact paths are private to the orchestrator;
downstream scripts read them by absolute path passed in as args.

### 4. Build postable line set

```bash
"$SCRIPTS/post-pr-review-build-postable-lines.sh" \
  "$SCRATCH/post-pr-review-${PR}.diff" \
  > "$SCRATCH/post-pr-review-${PR}.lines.json"
```

Output: `{path: [line, line, ...]}` — NEW-side line numbers per file that
appear in any hunk. This is the gate for step 6 — any agent finding outside
this set is rejected pre-POST to prevent 422s from GitHub.

### 5. Dispatch review agents in parallel

Resolve `--agents`. Default set (chosen for high signal-to-noise on dotbabel
PRs):

- `architect-reviewer` — design/coupling/scalability concerns
- `security-auditor` — secrets, injection vectors, OWASP top 10
- `compliance-auditor` — gate coverage, declared-vs-enforced invariants
- `documentation-writer` — comment accuracy, missing docstrings, drift

`--agents inline` skips agent dispatch and uses heuristics in this skill body
only (see Inline-review heuristics below).

In a SINGLE message, invoke `Task` once per requested agent. Each invocation
receives:

- The diff path.
- The list of changed files.
- The head SHA.
- The exact JSON contract from
  [`references/agent-contract.md`](references/agent-contract.md) — verbatim,
  no paraphrasing. Each agent MUST return ONE fenced JSON block per the
  documented schema.

### 6. Aggregate, validate, dedup, sort, truncate

1. Parse each agent's JSON. On parse failure, retry once with a stricter
   prompt; on second failure, log and skip that agent (don't abort the run).
2. Drop findings whose `(path, line)` is not in the postable line set.
3. Drop findings with `confidence < 80`.
4. Compute the marker for each finding (see Idempotency below).
5. Fetch existing markers via
   `"$SCRIPTS/post-pr-review-list-markers.sh" "$PR" "${GH_REPO_ARGS[@]}"` and
   drop any finding whose marker is already present.
6. Within this run, dedup by marker (different agents can converge on the
   same line).
7. Sort: severity DESC (critical → important → suggestion), path ASC, line ASC.
8. Apply `--max-comments`. **Severity-aware:** if truncating would drop one
   or more `critical` findings, refuse silently. In interactive mode offer
   `[r]aise cap / [s]ummary-only / [a]bort`; in `--auto` exit 1 with:
   `N critical findings exceed --max-comments=M.` Re-run with a higher cap
   or `--summary-only`.

### 7. Confirmation (skipped under `--auto`)

Render a table:

```
#  severity     agent                  path:line                  title
1  critical     security-auditor       src/api.ts:142             Hard-coded API key in commit
2  important    architect-reviewer     src/types/user.ts:18       Discriminated union would clarify intent
3  suggestion   documentation-writer   src/utils/format.ts:9      Public function lacks docstring
[y]es / [e]dit / [n]o
```

`edit` opens `$EDITOR` on a temp JSON the user can re-curate (the user's
editor does the write; the skill reads the result back).

### 8. Post

- `--summary-only`: one POST to `/reviews` with `body` (markdown checklist
  of findings) + `event`. No `comments[]`. The `--max-comments` cap applies
  to body lines; tail collapses to "…and N more (run without --summary-only
  to see all inline)".
- `--mode review` (default), count > 1: one atomic POST `/reviews` with
  `event`, optional `body` (general notes from agents), and `comments[]`.
  Counts as one rate-limit event regardless of comment count. Use:
  ```bash
  "$SCRIPTS/post-pr-review-post-batch.sh" "$PR" \
    --comments-json "$SCRATCH/post-pr-review-${PR}.comments.json" \
    --event "$EVENT" \
    --body-file "$SCRATCH/post-pr-review-${PR}.body.md" \
    "${GH_REPO_ARGS[@]}"
  ```
- `--mode inline` or count == 1: loop `POST /pulls/{n}/comments`, sleeping
  750ms between calls. Use `post-pr-review-post-single.sh` with
  `"${GH_REPO_ARGS[@]}"`.

After each POST, parse rate-limit headers:

```bash
REMAINING=$("$SCRIPTS/post-pr-review-ratelimit.sh" \
  "$SCRATCH/post-pr-review-batch-${PR}.headers" | jq -r .remaining)
```

If `REMAINING < 50` → bump sleep to 1s. If `REMAINING < 10` → stop, report
deferred count, exit 0 with hint at `x-ratelimit-reset`.

### 9. Final report

```
post-pr-review summary for PR #123 (owner/repo)
  posted              N
  skipped (dedup)     M
  skipped (out-diff)  K
  deferred (rate)     R
  errors              E
PR: https://github.com/owner/repo/pull/123
```

## Inline-review heuristics (when `--agents inline`)

Use these only when no agents are requested:

- **Silent failures**: scan added lines for `catch.*{}`, `catch.*{\s*//`,
  `except.*pass`, `panic\(\) //ignore`. Severity: `critical`.
- **Missing tests**: any new file under `src/` (or language equivalent) with
  no matching test file in the diff. Severity: `important`.
- **Comment drift**: existing comments above changed code. Severity:
  `suggestion`.
- **Hard-coded secrets**: `API_KEY = "..."`, `password.*=.*"..."`, regex
  matches against added lines. Severity: `critical`.

## Idempotency

Every comment body has a hidden HTML marker appended:

```
<!-- post-pr-review:v1:<sha256-hex-truncated-to-16> -->
```

The hash input (the "finding key") is the literal pipe-joined string:

```
{path}|{line}|{side}|{agent}|{first_120_chars_of_body_normalized}
```

`normalized` = lowercase + collapse whitespace runs to single space + strip
trailing punctuation.

On re-run, `post-pr-review-list-markers.sh` paginates all existing comments,
extracts every `post-pr-review:v1:[0-9a-f]{16}` marker, and drops any new
finding whose marker is in the set. The `v1` prefix lets us bump the schema
later without false-positive dedup against old markers.

## Rate-limit guard

GitHub's secondary limit on content-creating endpoints is **80 requests/min,
500/hour**. Source:
<https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits>.
See [`references/rate-limits.md`](references/rate-limits.md).

The atomic `POST /reviews` endpoint counts as ONE content-creation regardless
of how many inline comments it bundles — this is why `--mode review` is the
default. `--mode inline` should only be used when posting a single comment
or when the user wants per-comment posting for some reason.

## Concurrency

The dedup story (step 6.5: list existing markers → filter findings → POST)
is **not safe under concurrent invocations**. Between `list-markers.sh`
returning and `post-batch.sh` posting, another `/post-pr-review` run (or a
human reviewer adding bot-style markers) could insert markers we never saw,
producing duplicate posts on the next run.

Run the skill serially per PR. If you need automation, gate it behind a
GitHub Actions concurrency group or a repo-level lock — the skill itself
intentionally does not implement locking (out of scope for v0.1).

## Failure modes

| Mode                         | Detection                                                                   | Behavior                                                              |
| ---------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| No PR for branch             | `gh pr view` exits non-zero                                                 | Fail with: "No PR found. Pass PR# explicitly: `/post-pr-review 123`." |
| PR closed/merged             | `state != OPEN`                                                             | Refuse. No `--force` for merged.                                      |
| PR is draft                  | `isDraft == true`                                                           | Warn + prompt; `--auto` proceeds.                                     |
| Fork PR                      | `isCrossRepository == true`                                                 | Warn that posting may 403.                                            |
| Agent returns no findings    | empty `findings[]`                                                          | Note in report, continue.                                             |
| Agent returns malformed JSON | parse fails                                                                 | Retry once with stricter prompt; on second fail, skip that agent.     |
| `gh auth missing`            | `gh auth status` non-zero                                                   | Fail at preflight with remediation.                                   |
| Secondary rate limit hit     | 403 with `secondary rate limit` in body                                     | Stop batch, report deferred, hint at `x-ratelimit-reset`.             |
| Line not in diff             | pre-validated against postable line set; if it slips and GitHub returns 422 | Skip that comment, log, continue.                                     |
| Network/transient            | non-2xx, non-422, non-403                                                   | Retry up to 2x with backoff (1s, 3s).                                 |

## See also

- `.claude/skills/review-pr/SKILL.md` — the CONSUMER. Run after
  `/post-pr-review` to fetch and apply fixes from the comments this skill
  posted.
- [`references/agent-contract.md`](references/agent-contract.md) — JSON
  schema each dispatched agent returns.
- [`references/github-api-gotchas.md`](references/github-api-gotchas.md) —
  NEW vs OLD line coords, atomic vs loop trade-offs.
- [`references/rate-limits.md`](references/rate-limits.md) — GitHub's
  content-creation limits.
