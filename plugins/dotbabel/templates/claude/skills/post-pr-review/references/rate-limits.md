# GitHub API rate limits relevant to `post-pr-review`

## Primary rate limit (per hour)

For authenticated requests using a personal access token:

- **5,000 requests/hour** (standard)
- **15,000 requests/hour** (Enterprise Cloud accounts)

Read via response headers:

- `x-ratelimit-limit` — maximum for the window
- `x-ratelimit-remaining` — requests left in the window
- `x-ratelimit-used` — requests consumed
- `x-ratelimit-reset` — UTC epoch seconds when the window resets

`post-pr-review-ratelimit.sh` parses these from `gh api --include` output and
emits JSON `{limit, remaining, used, reset}`.

## Secondary rate limit (per minute) — the real ceiling for this skill

GitHub enforces a **secondary** rate limit on content-creating endpoints:

> No more than **80 content-generating requests per minute** and no more than
> **500 content-generating requests per hour**.

— Source: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits>

`POST /pulls/{n}/comments` and `POST /pulls/{n}/reviews` both count as
content-generating. Exceeding the secondary limit returns:

```
HTTP 403 You have exceeded a secondary rate limit
```

There is no header that tracks remaining secondary capacity — the server-side
limiter is opaque. The skill's defensive posture:

1. **Prefer the atomic `POST /reviews`** endpoint when posting >1 comment. One
   atomic POST = one content-creation event, regardless of how many inline
   comments it contains.
2. **Hard cap of 25 comments per run** by default. Exceeding requires explicit
   `--max-comments N`.
3. **Sleep 750ms between per-comment POSTs** when in `--mode inline`. Bumps to
   1s when `x-ratelimit-remaining < 50`.
4. **Stop on `remaining < 10`** — defer the rest, exit 0, hint at
   `x-ratelimit-reset`.

## Threshold revisit

These thresholds are sourced from the GitHub docs URL above as of skill
creation (2026-05-07). If GitHub's published limits change, update the
threshold constants in `post-pr-review-ratelimit.sh` and the SKILL.md
"Rate-limit guard" section together.

## What counts as content-creating

Per the GitHub docs:

> Requests that create content count toward the secondary rate limit. This
> includes:
>
> - Creating issues
> - Creating issue comments
> - Creating pull request reviews
> - Creating commit comments
> - Creating gists

Reads (`GET`) do NOT count against the secondary limit, only the primary.
This is why `post-pr-review-list-markers.sh` (a paginated GET) is "free"
relative to the post step.
