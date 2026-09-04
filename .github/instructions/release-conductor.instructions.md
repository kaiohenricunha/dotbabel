---
# dotbabel:generated — do not edit directly. Source: .claude/skills/release-conductor/SKILL.md. Regenerate with `dotbabel project-sync`.
name: release-conductor
description: >
  Gate the open release-please PR before merging: verify CI green, feature PRs
  landed, no release blockers, changelog reflects intent. One-word approval,
  then merge. Reports the resulting release.yml run URL. release-please owns the
  changelog/bump/tag; release.yml owns OIDC npm publish — this skill only gates
  the merge in between. Triggers on: "ship a release", "cut a release", "merge
  the release PR", "is the release ready", "verify the release".
applyTo: '**'
---

Gate the open release-please PR before merging. release-please drafts the changelog and version bump; `release.yml` handles OIDC npm publish on tag push. This skill is the human-in-the-loop step between them: verifies the PR is safe to merge, then merges it.

Trigger: when the user says "ship a release", "cut a release", "merge the release PR", "is the release ready", or invokes `/release-conductor`. Also `/release-conductor verify <tag>` for post-publish smoke test.

Arguments: `$ARGUMENTS` — optional subcommand:

- (empty) — full gate + merge flow on the currently open release-please PR.
- `verify <tag>` — post-publish smoke test for a published tag (e.g. `verify v2.8.0`).

**Lifecycle:**

```
feature PRs merged → release-please opens release PR → /release-conductor (gate + merge) → release.yml (OIDC publish) → /release-conductor verify <tag>
```

## Steps

### 0. Refresh local refs, then branch on subcommand

If `$ARGUMENTS` starts with `verify`, jump to the **`verify` subcommand** section below — it reads only from `gh` and needs no local git state.

Otherwise refresh before anything reads local git state:

```bash
git fetch origin main --tags --prune-tags
```

**This is load-bearing — do not skip it.** Steps 4 and 5 derive `LAST_TAG` from local tags and diff against `origin/main`. On a clone whose tags are stale, every downstream number is wrong _and still looks plausible_: the bump comparison, the "PRs merged since last tag" list, and the commit-type check all describe the wrong release window, and nothing blocks — the gate reports READY on a false picture.

Observed in practice: a clone three tags behind reported the bump as `2.10.0 → 2.13.0` with 23 landed PRs, when the truth was `2.12.0 → 2.13.0` with 3.

Then continue with the gate + merge flow.

### 1. Find the open release-please PR

```bash
gh pr list --state open --search "head:release-please--" \
  --json number,title,headRefName,mergeable,mergeStateStatus,labels,body
```

- **Zero matches.** Check what's accumulated since the last tag:

  ```bash
  # Requires the step 0 fetch — stale tags here mean the wrong commit window.
  LAST_TAG=$(git tag --list 'v*' --sort=-version:refname | head -1)
  [ -n "$LAST_TAG" ] || { echo "no v* tag found — run: git fetch origin --tags"; exit 1; }
  git log "$LAST_TAG"..origin/main --oneline --no-merges
  ```

  If the log contains `feat:` / `fix:` / `perf:` / `refactor:` commits but no PR is open, suggest:

  ```bash
  gh run list --workflow=release-please.yml --limit 3
  ```

  release-please may have failed or not run. STOP and surface the most recent run.

  If the log contains only `chore:` / `style:` / `test:` / `build:` / `ci:` / `docs:` commits, report:
  `no shippable changes — release-please correctly held off.` STOP.

- **One match.** Record `RELEASE_PR=$pr_number` and continue.

- **Multiple matches.** STOP and ask the user which to ship — this signals a release-please config issue (multi-package monorepo without `include-component-in-tag`, etc.).

### 2. Show what's being shipped

```bash
gh pr view $RELEASE_PR --json title,body | jq -r '.title, .body'
gh pr diff $RELEASE_PR -- CHANGELOG.md | head -120
gh pr view $RELEASE_PR --json files --jq '.files[].path'
```

Report:

- PR title (release-please format: `chore(main): release X.Y.Z`)
- The changelog section being added (first ~120 lines of the diff)
- Files changed by the PR (should be `CHANGELOG.md`, `package.json`, `.release-please-manifest.json`, and any post-bump regen — `index/`, `docs/` stamps)

### 3. Verify CI on the release PR

```bash
gh pr checks $RELEASE_PR
```

- Any check `failing` → STOP. Print the failing check names; tell the user to address them before re-running.
- Any check `pending` → STOP. Tell the user to wait for CI to finish.
- All checks pass → continue.

Sanity check on `main`:

```bash
gh run list --branch main --limit 5 --json conclusion,name,createdAt
```

If the most recent run on `main` is failing, surface as **WARNING** (not blocking) — release.yml will run against the tag, not `main`, so a stale main failure won't break publish, but it's worth knowing.

### 4. Verify no release blockers and feature PRs landed

```bash
# Requires the step 0 fetch. A stale tag here silently shifts the whole
# release window: wrong bump, wrong landed-PR list, wrong commit-type check.
LAST_TAG=$(git tag --list 'v*' --sort=-version:refname | head -1)
[ -n "$LAST_TAG" ] || { echo "no v* tag found — run: git fetch origin --tags"; exit 1; }
LAST_TAG_DATE=$(git log -1 --format=%cI "$LAST_TAG")

# Feature PRs merged since last tag
gh pr list --state merged --search "merged:>$LAST_TAG_DATE base:main" \
  --limit 50 --json number,title,headRefName,labels

# Open PRs flagged as blockers
gh pr list --state open --search "label:release-blocker,do-not-release,wip" \
  --json number,title,labels
```

- Report count of feature PRs merged since `$LAST_TAG`.
- Any open PR with `release-blocker` or `do-not-release` label → STOP. Surface the PR numbers.
- Any **merged** PR with those labels (mistakes happen) → surface as WARNING.

### 5. Sanity-check the bump

```bash
PREV_VERSION=${LAST_TAG#v}
NEW_VERSION=$(gh pr view $RELEASE_PR --json title --jq .title \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
echo "Bump: $PREV_VERSION → $NEW_VERSION"
```

Inspect conventional-commit types since last tag:

```bash
git log "$LAST_TAG"..origin/main --pretty=format:'%s%n%b' --no-merges \
  | grep -E '^(feat|fix|perf|refactor|docs)(\(.+\))?!?:|BREAKING CHANGE:' \
  | sort -u
```

Expected bump (post-1.0):

- `feat!:` or `BREAKING CHANGE:` anywhere → **major**
- `feat:` (no breaking) → **minor**
- `fix:` / `perf:` / `refactor:` only → **patch**

For pre-1.0 packages, read `release-please-config.json` — `bump-minor-pre-major` promotes major→minor; `bump-patch-for-minor-pre-major` promotes minor→patch.

If release-please's bump diverges from expectation, surface as **WARNING** with the divergence (likely config). Do not block — release-please's config is the source of truth.

### 6. Go/no-go summary

```
Release-conductor: PR #$RELEASE_PR — $PREV_VERSION → $NEW_VERSION

  Step 2 — Files:           CHANGELOG.md, package.json, .release-please-manifest.json, …
  Step 3 — CI release PR:   ✓ green
                         |  ✗ failing: <names> (BLOCKED)
                         |  ⏳ pending (BLOCKED — wait)
  Step 3 — CI main:         ✓ green
                         |  ⚠ recent failures (not blocking publish)
  Step 4 — Blockers:        none
                         |  ✗ open: PR #N (label) (BLOCKED)
  Step 4 — Landed PRs:      N feature PRs since $LAST_TAG
  Step 5 — Bump:            ✓ matches commit types
                         |  ⚠ release-please chose $NEW_VERSION, expected $EXPECTED (<reason>)

Status: READY — say "ship" to merge PR #$RELEASE_PR (squash) and trigger release.yml.
     |  BLOCKED — <reason>. Fix and re-run /release-conductor.
```

### 7. Merge on explicit approval

Wait for the user to say `ship`, `merge`, `go`, or `lgtm`. CI green alone is not authorization.

On approval:

```bash
gh pr merge $RELEASE_PR --squash --delete-branch
```

If the repo overrides merge method (check `.github/settings.yml` or repo settings UI), follow the override and note it in the report.

### 8. Report the publish pipeline run

release-please's GitHub Action creates the `v$NEW_VERSION` tag immediately after merge; the tag push fires `release.yml`. Report the most recent runs so the user can track:

```bash
TAG="v$NEW_VERSION"
gh run list --workflow=release.yml --limit 3 \
  --json url,headBranch,status,conclusion,createdAt
```

Do not poll. Print:

```
Merged PR #$RELEASE_PR ($PREV_VERSION → $NEW_VERSION)
Tag should appear shortly: $TAG
Track release.yml above. Once it shows ✓ success:
  /release-conductor verify $TAG
```

## `verify <tag>` subcommand

Post-publish smoke test. No gating, no merge — just three checks.

```bash
TAG=$(echo "$ARGUMENTS" | awk '{print $2}')
VERSION=${TAG#v}
PKG=$(node -p "require('./package.json').name")

# 1. release.yml conclusion for this tag
gh run list --workflow=release.yml --branch "$TAG" --limit 1 \
  --json conclusion,url,databaseId

# 2. npm has the version
npm view "$PKG@$VERSION" version dist.tarball

# 3. GitHub release exists
gh release view "$TAG" --json url,publishedAt,name
```

Report PASS / FAIL per check. Specifics:

- **release.yml conclusion** — `success` = PASS. `in_progress` = "still running, retry in ~60s." `failure` = FAIL, print URL.
- **npm view** — exit 0 = PASS. 404 = "not yet propagated (npm CDN lag, up to ~60s)." Other error = FAIL.
- **gh release view** — exit 0 = PASS. `release not found` = FAIL.

## Rules

- **Never reimplement release-please.** This skill does not write CHANGELOG.md, bump versions, or create tags. release-please owns that; this skill only gates the merge of release-please's PR.
- **Never publish to npm directly.** OIDC publish happens in `release.yml` on tag push. The skill stops at `gh pr merge`.
- **Require explicit verbal approval.** `ship` / `merge` / `go` / `lgtm`. CI green alone is not authorization.
- **One release PR at a time.** Multiple open `release-please--*` PRs → stop and ask. Likely a config issue.
- **Squash merge by default.** Matches `/merge-pr` convention. Repo override (if any) wins, but record it.
- **No polling.** Print the run URL and exit. Use `verify <tag>` later.
- **Pre-1.0 bump checks read config.** Don't assume semver — `release-please-config.json` may have `bump-minor-pre-major` flags that alter the expected bump.
- **Always fetch tags before reading them.** `LAST_TAG` comes from the local tag list; a stale clone yields a wrong release window that still reports READY. Step 0's fetch is not optional.
