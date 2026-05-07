# GitHub API gotchas — PR review comments

## Two endpoints, very different ergonomics

### A. Per-comment: `POST /repos/{o}/{r}/pulls/{n}/comments`

```bash
gh api repos/{o}/{r}/pulls/{n}/comments \
  -f body='Comment text' \
  -f commit_id='<HEAD_SHA>' \
  -f path='src/file.ts' \
  -f line=42 \
  -f side='RIGHT'
```

- One inline comment per call.
- Each call counts independently against the secondary rate limit.
- Use this for `--mode inline` (per-comment loop) or when there's only one
  finding to post.

### B. Atomic batch: `POST /repos/{o}/{r}/pulls/{n}/reviews`

```bash
gh api repos/{o}/{r}/pulls/{n}/reviews \
  -f body='Top-level review summary' \
  -f event='REQUEST_CHANGES' \
  -f 'comments[0][path]=file.ts' \
  -f 'comments[0][line]=42' \
  -f 'comments[0][body]=Inline comment 1' \
  -f 'comments[1][path]=other.ts' \
  -f 'comments[1][line]=88' \
  -f 'comments[1][body]=Inline comment 2'
```

- All comments + review event in ONE atomic request.
- Counts as ONE call against the rate limit, regardless of comment count.
- All comments appear under one "review" thread on the PR.
- **Default for `post-pr-review` whenever count > 1.**

## NEW vs OLD line coordinates

`line` (and `start_line`) are in NEW-version coordinates by default. This is
the line number you'd see if you opened the file at the PR's head SHA.

- `side: RIGHT` → NEW version (additions and context lines).
- `side: LEFT` → OLD version (deletions). Rarely useful for review comments.

For a comment on a line you ADDED in the PR, use `side: RIGHT` and the
NEW-side line number. The orchestrator pre-validates this against the
"postable line set" built from parsing the unified diff — any finding outside
that set is dropped before posting to prevent 422 responses from GitHub.

## Multi-line comments

```bash
gh api repos/{o}/{r}/pulls/{n}/comments \
  -f body='Span comment' \
  -f commit_id='<SHA>' \
  -f path='file.ts' \
  -f start_line=40 -f start_side='RIGHT' \
  -f line=45 -f side='RIGHT'
```

Both `start_side` and `side` must be set for multi-line.

## `gh pr review` does NOT support inlines

The high-level `gh pr review` command:

```bash
gh pr review 123 --request-changes -b 'Needs refactor'
```

Only sets the top-level review body + event. Use `gh api` for inline comments.

## Resolving the head SHA

```bash
gh pr view <n> --json headRefOid -q .headRefOid
```

Edge case: PRs from forks. The head SHA is still resolvable, but POSTing
comments may 403 if the actor lacks `pull_request_review` permission on the
base repo. The orchestrator warns when `isCrossRepository == true` so the user
isn't surprised.

## Listing existing comments (for dedup)

```bash
gh api 'repos/{o}/{r}/pulls/{n}/comments' --paginate \
  --jq '.[] | {id, path, line, body}'
```

Use the `--paginate` flag — review-heavy PRs can have hundreds of comments.

## 422 prevention

GitHub returns 422 if `line` is not part of the diff that the PR introduces
(e.g., if you try to comment on an unchanged line). The orchestrator builds a
"postable line set" from the diff in step 4 and rejects any finding outside
it BEFORE posting. The 422 path is a safety net.
