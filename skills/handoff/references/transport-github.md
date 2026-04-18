# Handoff transport: GitHub (gists + fallbacks)

This reference covers three `--via` values, all backed by GitHub:

| `--via`        | Tooling | Auth                             | Storage                  |
| -------------- | ------- | -------------------------------- | ------------------------ |
| `github`       | `gh`    | ambient `gh auth login`          | private gist             |
| `gist-token`   | `curl`  | `DOTCLAUDE_GH_TOKEN` PAT, `gist` | private gist (same API)  |
| `git-fallback` | `git`   | SSH / credential helper          | branches in private repo |

Prerequisites and remediation for each live in
`../prerequisites.md`. Redaction semantics live in `../redaction.md`.

---

## Payload layout

A single handoff uploads three files (two when
`--include-transcript` is off, which is the default):

| Filename           | Content                                          | Required |
| ------------------ | ------------------------------------------------ | -------- |
| `handoff.yaml`     | The normalized digest from `../digest-schema.md` | yes      |
| `metadata.json`    | Origin facts (see below)                         | yes      |
| `transcript.jsonl` | Last 50 turns of the raw session, scrubbed       | opt-in   |

### `metadata.json` shape

```json
{
  "cli": "claude",
  "session_id": "3564b8c0-1b8a-4711-ada0-28f2c0285a39",
  "short_id": "3564b8c0",
  "cwd": "/home/kaioh/projects/kaiohenricunha/dotclaude",
  "hostname": "thinkpad-pop",
  "git_remote": "git@github.com:kaiohenricunha/dotclaude.git",
  "created_at": "2026-04-18T14:05:11Z",
  "scrubbed_count": 3,
  "schema_version": "1",
  "tag": "windows-morning"
}
```

`git_remote` is `null` when the push is run outside a git repo.
`tag` is `null` unless `--tag` was passed. All other fields are
always present.

### Description schema

The gist description (and the git-fallback branch name's suffix) is
a `:`-delimited string so `gh gist list` is fast to filter and the
unit-testable encoder stays dumb:

```text
handoff:v1:<cli>:<short-uuid>:<project-slug>:<hostname>[:<tag>]
```

Examples:

- `handoff:v1:claude:3564b8c0:dotclaude:thinkpad-pop`
- `handoff:v1:codex:1be89762:squadranks:win-desktop:evening`

Rules:

- `v1` is the schema version; bump if field positions change.
- `<cli>` is one of `claude`, `copilot`, `codex`.
- `<short-uuid>` is the first 8 chars of the session id.
- `<project-slug>` is the last segment of `cwd` when inside a repo,
  else `adhoc`. Must be `[a-z0-9-]{1,40}` (lower-cased, non-matching
  chars replaced with `-`, trimmed).
- `<hostname>` is `hostname -s`, lower-cased, `[a-z0-9-]{1,40}`.
- `<tag>` is optional; same character class as `<project-slug>`.

Encoder / decoder: `plugins/dotclaude/scripts/handoff-description.sh`.

---

## `--via github` (default)

### Push

```bash
gh gist create \
  --desc "handoff:v1:claude:3564b8c0:dotclaude:thinkpad-pop" \
  handoff.yaml metadata.json
# With --include-transcript:
gh gist create \
  --desc "..." \
  handoff.yaml metadata.json transcript.jsonl
```

`gh gist create` prints the gist URL on stdout. Extract the ID
with a trailing-segment regex. There is no public flag; private is
the default.

### Pull

```bash
gh gist view "$GIST_ID" --filename handoff.yaml --raw
```

Returns the raw file content, nothing else. The `<handoff>` block is
inside `handoff.yaml` verbatim. Note: `--files` (plural) LISTS file
names; `--filename X --raw` fetches one file's body.

### List

```bash
# gh gist list has no --json flag; go through the REST API to get
# structured output. `/gists` returns the authenticated user's gists.
gh api '/gists?per_page=100' \
  | jq 'map(select(.description | startswith("handoff:v1:")))'
```

Filter by `--cli` is a second `jq` step comparing the fourth
colon-segment. The `public` flag is available as `.public` in the
API response; filter to `false` to match the `--private` push path.

### Errors

| `gh` exit | Meaning              | Handling                                                |
| --------- | -------------------- | ------------------------------------------------------- |
| 0         | success              | parse output                                            |
| 1         | auth or API error    | re-run `doctor`, surface remediation                    |
| 2         | usage error          | bug in the skill — log the invocation verbatim          |
| 4         | HTTP 4xx from GitHub | usually 404 on missing gist or 422 on too-large payload |

Rate limit: `gh api /rate_limit` to inspect. The core limit
(5000/hour for authenticated users) is never close to saturation
for normal handoff use.

### Size guardrails

GitHub caps gists at 100 MB total, ~1 MB per file for the web UI.
The digest is always < 10 KB. A 50-turn transcript rarely exceeds
200 KB. If `handoff.yaml` or `transcript.jsonl` exceeds 1 MB, the
push aborts with a clear message rather than truncating.

---

## `--via gist-token`

Identical gist API, different auth. Use in CI, devcontainers, or
hosts where installing `gh` is awkward.

### Push

```bash
curl -fsS \
  -H "Authorization: token $DOTCLAUDE_GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -X POST https://api.github.com/gists \
  -d "$(jq -n --arg desc "$DESC" \
            --arg handoff "$(cat handoff.yaml)" \
            --arg meta "$(cat metadata.json)" \
            '{description:$desc, public:false,
              files:{ "handoff.yaml":{content:$handoff},
                      "metadata.json":{content:$meta} }}')" \
  | jq -r '.id, .html_url'
```

### Pull

```bash
curl -fsS \
  -H "Authorization: token $DOTCLAUDE_GH_TOKEN" \
  "https://api.github.com/gists/$GIST_ID" \
  | jq -r '.files["handoff.yaml"].content'
```

### List

```bash
curl -fsS \
  -H "Authorization: token $DOTCLAUDE_GH_TOKEN" \
  "https://api.github.com/gists?per_page=100" \
  | jq 'map(select(.description | startswith("handoff:v1:")))'
```

---

## `--via git-fallback`

Uses raw `git` against a user-owned private repo. Useful when
`gh` is blocked, or when the user prefers git history over gist
URLs.

### One-time setup

1. Create the repo: `gh repo create handoff-store --private` (or
   web UI). The repo must exist before `push` is called.
2. Export the URL: `export
DOTCLAUDE_HANDOFF_REPO=git@github.com:<user>/handoff-store.git`.
3. Verify: `/handoff doctor --via git-fallback`.

### Push

```bash
cd "$(mktemp -d)"
git init -q
git remote add origin "$DOTCLAUDE_HANDOFF_REPO"
git checkout -q -b "handoff/$CLI/$SHORT_ID"
cp "$WORK/handoff.yaml" .
cp "$WORK/metadata.json" .
[[ -f "$WORK/transcript.jsonl" ]] && cp "$WORK/transcript.jsonl" .
git add .
git commit -q -m "$DESCRIPTION"
git push -q -u origin "handoff/$CLI/$SHORT_ID"
```

The commit message is the full `handoff:v1:...` description string
so `git log --format=%s` acts as the list index.

### Pull

```bash
cd "$(mktemp -d)"
git clone --depth 1 --branch "handoff/$CLI/$SHORT_ID" \
  "$DOTCLAUDE_HANDOFF_REPO" . -q
cat handoff.yaml
```

### List

```bash
git ls-remote "$DOTCLAUDE_HANDOFF_REPO" 'refs/heads/handoff/*'
```

Use `git log` on a local cached clone for descriptions and dates;
`ls-remote` alone doesn't surface committer-date.

---

## Choosing between the three

| Situation                              | Pick           |
| -------------------------------------- | -------------- |
| Default, `gh` is on my laptop          | `github`       |
| Headless CI, only have a PAT           | `gist-token`   |
| Corp firewall blocks the gist endpoint | `git-fallback` |
| Want git history / branch diffing      | `git-fallback` |
| Temporary token with short TTL         | `gist-token`   |

All three share the same payload format, same description schema,
same redaction pass. Future transports land as peers, never as
replacements.
