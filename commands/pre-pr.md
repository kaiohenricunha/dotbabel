---
id: pre-pr
name: pre-pr
type: command
version: 1.1.0
domain: [devex]
platform: [none]
task: [review, testing]
maturity: draft
owner: "@kaiohenricunha"
created: 2026-04-18
updated: 2026-08-12
description: >
  Pre-PR quality gate: simplify changed code, security-review the diff, run the PR quality
  profile, and surface a go/no-go summary before opening a pull request.
argument-hint: "[base-branch] [--conductor] — default: origin/main"
model: sonnet
headless_safe: false
---

Quality gate to run before `/git pr`. Simplifies changed code, security-reviews the diff, runs the PR quality profile, and surfaces a go/no-go summary. Does not open the PR — that is `/git pr`.

Trigger: when the user is done with a feature and is about to open a PR, or says "prepare PR", "pre-PR", or "clean up before PR". Also triggered directly via `/pre-pr [base-branch]`.

Arguments: `$ARGUMENTS` — optional base branch, defaulting to `origin/main`, plus an optional `--conductor` flag.

`--conductor` is passed only by `/pr-conductor` phase 1. It replaces step 3's full security review with a secrets-only grep, because the conductor runs the authoritative security pass once in phase 3 via the `security-auditor` agent. Everything else is unchanged. Strip `--conductor` out of `$ARGUMENTS` before binding the base branch.

**Lifecycle:**

```
/git (commit) → /pre-pr → /git pr (open PR) → /post-pr-review → /review-pr → /local-attest → /merge-pr
```

`/pr-conductor` runs that whole sequence for one PR and stops before the merge; this command is
phase 1 of it. Invoke `/pre-pr` directly when you only want the quality gate.

## Steps

### 1. Detect scope

Bind the mode and the base branch in one visible step — binding `$ARGUMENTS` directly would make `BASE` the literal string `--conductor`:

```bash
CONDUCTOR=0
REST="$ARGUMENTS"
case " $REST " in *" --conductor "*) CONDUCTOR=1 ;; esac
REST="$(printf '%s' "$REST" | sed 's/--conductor//g' | xargs)"
BASE="${REST:-origin/main}"
```

`--conductor` may appear in any position here. `skills/review-pr/SKILL.md` uses the same strip-anywhere rule, so one flag behaves identically in both artifacts.

Guard — verify not on main/master:

```bash
BRANCH=$(git branch --show-current)
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "ERROR: currently on $BRANCH. Create a feature branch before opening a PR."
  exit 1
fi
```

Identify changed files vs base:

```bash
git fetch origin
MERGE_BASE=$(git merge-base HEAD "$BASE")
git diff "$MERGE_BASE" --name-only
git diff "$MERGE_BASE" --stat
```

Report: "N files changed vs $BASE on branch $BRANCH."

If zero files changed vs base, stop: "No changes detected vs $BASE — nothing to gate."

### 2. Simplify changed code

`/code-simplifier` is a dotbabel skill — available in all agents after bootstrap.

```
/code-simplifier $BASE
```

Pass `$BASE` explicitly so the skill uses the same base branch already resolved in step 1, rather than re-detecting it from scratch.

After it completes, check for unstaged changes:

```bash
git diff --stat
```

If simplify introduced changes, stage and commit them atomically:

```bash
git add -p   # stage only simplify's changes, not unrelated WIP
git commit -m "style: pre-pr simplification pass"
```

Record in summary: "Simplified N files, M changes staged." If no changes: "simplify: clean."

### 3. Security review

**Conductor mode (`--conductor`):** skip the full `/security-review` pass below — the conductor's phase 3 dispatches the `security-auditor` agent over the same diff, and running both reviews the identical code twice. Run a secrets-only check instead, by piping the added lines through the repo's own scrubber rather than hand-rolling patterns:

```bash
git diff "$MERGE_BASE" | grep '^+' | grep -v '^+++' \
  | bash plugins/dotbabel/scripts/handoff-scrub.sh >/dev/null
# stderr reports `scrubbed:N`
```

The scrubber carries the curated, unit-tested pattern set (GitHub tokens, `sk-`, AWS keys, Google keys, Slack tokens, bearer headers, `*_TOKEN|KEY|SECRET|PASSWORD=…`, PEM blocks), so this check stays in sync automatically as patterns are added. Warning: `N > 0` is **CRITICAL → STOP**, exactly as below — secrets must never reach a pushed branch, and phase 3 happens after the push. Inspect each hit before acting: prose that merely documents a secret pattern will match, so confirm a real credential before stopping the run. `N == 0` records `security: secrets-scan clean (full review deferred to phase 3)`. Then continue at step 4.

Everything below applies to a standalone `/pre-pr` run.

In pre-PR context all branch changes are committed and the working tree is clean, so `git diff --cached` (the security-review default) would see nothing. Stage the diff vs base explicitly before invoking:

```bash
git diff "$MERGE_BASE" | git apply --cached --allow-empty
```

Then run:

```
/security-review staged
```

Then unstage:

```bash
git restore --staged .
```

If the skill is not available in this session (not bootstrapped, non-dotbabel environment):

```
⚠ security-review skill not available — skipping. Run /security-review manually before opening the PR.
```

Continue. Unavailability is a warning, not a gate failure.

Classify findings:

- **CRITICAL** → **STOP immediately.** Surface every finding and tell the user to fix before opening the PR. Do not proceed to steps 4–6.
- **WARNING** → record; surface in the go/no-go summary. Do not stop.
- **INFO** → record in summary only.
- No findings → record "security: clean."

### 4. Run the PR quality profile

Run the resolved repository commands and normalized policy checks through one entry point:

```bash
dotbabel quality check --profile pr --base "$BASE"
```

Do not pass `--allow-project-commands` during a local run. Use the external trust allowlist.

Exit code `1` means a checked rule failed. Exit code `2` means required evidence, trust, or tooling is unavailable.
**STOP** for either exit code. Surface each unavailable and not-configured capability in the summary.

### 5. PR body checklist reminder

Do not generate the PR body — that is `/git pr`'s responsibility. Just surface a reminder of required sections so the user can write them before opening:

```
PR body checklist (dotbabel conventions):
  [ ] ## Summary — 1–3 bullets describing the change
  [ ] ## Test plan — bulleted markdown checklist
  [ ] ## Spec ID — required if this repo uses specs (check for docs/specs/)
  [ ] ## No-spec rationale — required if touching a protected path without a spec
```

Check for protected paths: if any changed file matches an entry under **Protected paths (dogfood)** in CLAUDE.md, remind the user that a Spec ID or No-spec rationale section is required in the PR body. (The authoritative list lives in `docs/repo-facts.json` — do not hard-code it here.)

### 6. Go/no-go summary

```
Pre-PR gate: branch → $BRANCH (base: $BASE)

  Step 1 — Scope:     N files changed
  Step 2 — Simplify:  N files, M changes committed as style: pre-pr simplification pass
                   |  simplify: clean (no changes)
  Step 3 — Security:  clean (diff vs $MERGE_BASE)
                   |  N warnings (see above)
                   |  secrets-grep clean (conductor — full review in phase 3)
                   |  ⚠ skill unavailable — skipped
  Step 4 — Quality:   ✓ PR profile passed
                   |  ✗ checked rule failed (BLOCKED)
                   |  ✗ required evidence unavailable (BLOCKED)
  Step 5 — PR body:   checklist above

Status: READY — run `/git pr` to open the pull request.
     |  BLOCKED — <reason>. Fix the issue above before opening the PR.
```

## Rules

- **Never open the PR.** That is `/git pr`. This command only gates.
- **STOP on CRITICAL security findings.** Do not advance to steps 4–6; surface findings immediately.
- **STOP if the PR quality profile returns exit code 1 or 2.** Surface the normalized results.
- **Security-review unavailable is a warning, not a failure.** Warn, skip, continue.
- **`--conductor` narrows step 3 only.** A secrets hit still stops the run, and every other step behaves exactly as it does standalone.
- **Simplify commits are style commits.** Message: `style: pre-pr simplification pass`. Atomic — do not bundle with feature changes.
- **Do not modify files outside the changed set.** Simplify is focused on recently modified code; do not widen the scope.
- **Do not generate or submit the PR body.** Checklist in step 5 is a reminder, not authoring.
