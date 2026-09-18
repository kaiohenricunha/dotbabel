---
id: merge-pr
name: merge-pr
type: command
version: 2.0.0
domain: [devex]
platform: [github-actions]
task: [review, testing]
maturity: validated
description: >
  Merge a pull request only after verifying that trusted evidence covers its exact head SHA.
argument-hint: "[PR#]"
model: sonnet
---

Merge a pull request only after verifying that trusted evidence covers its exact head SHA.

Trigger: when the user asks to merge a PR. Also triggered directly via `/merge-pr <N>`.

Arguments: `$ARGUMENTS` — the PR number (e.g. `125`). If missing, ask the user which PR.

**Deterministic evidence is produced once per commit SHA and reused until that SHA
changes.** `/local-attest` runs the CI-equivalent matrix and posts a SHA-pinned
attestation; this command reads that evidence rather than re-running the same work on
the same tree. What it still checks fresh is everything that can change without the code
changing: the head SHA, mergeability, CI state, and the human's say-so.

## Steps

1. **Fetch PR metadata.**

   ```bash
   gh pr view <N> --json number,title,author,headRefName,baseRefName,headRefOid,body,labels,files,mergeable,mergeStateStatus,statusCheckRollup
   ```

   Record: branch name, **head SHA**, changed files, CI status, mergeable status.

2. **Verify PR body has required sections.**
   - Must contain `## Summary`
   - Must contain `## Test plan`
   - If the repo uses spec IDs (a `specs/` or `docs/specs/` dir), or the PR changes a protected path from `docs/repo-facts.json`, must contain a `## Spec ID` section or a `## No-spec rationale` section. `dotbabel pr-stack gate --gate merge` accepts either one. A Spec ID must name an approved, implementing, or done spec, and it does not cover a changed protected path that is missing from that spec's `linked_paths`. In both of those cases, use the rationale.
     If any are missing, STOP and ask the user whether to auto-append them via `gh pr edit <N> --body-file`.

3. **Run the merge gate and read every reason.**

   ```bash
   dotbabel pr-stack gate --gate merge --pr <N>
   ```

   This reads GitHub and the git object store, so it works from your own
   checkout. Any criteria reason other than `CRITERIA_EVIDENCE_STALE`
   (`CRITERIA_FAILED`, `CRITERIA_EVIDENCE_MISSING`, `CRITERIA_SCOPE_WEAKENED`,
   `CRITERIA_BASE_UNREADABLE`, …) is a real failure: **STOP** and report it.
   Never merge past a criteria reason, and never hand-write the evidence marker
   — `guard-criteria-evidence.sh` blocks that, because the gate cannot tell a
   hand-written marker from one the tool derived from a real run.

   `CRITERIA_EVIDENCE_STALE` alone is recoverable: trusted evidence exists but
   names an earlier commit, usually because something pushed after `/review-pr`
   ran. Carry it to step 5 — re-verifying needs the PR head checked out, which
   has not happened yet.

4. **Decide how this pull request gets verified.** Read the gate's attestation
   reasons, which are the whole basis for skipping steps 6's expensive half.

   **No `ATTESTATION_*` reason and the repo enforces attestation** — trusted,
   current, complete evidence covers this exact head. Skip the worktree, skip
   the local suite and the quality profile, and report the attested legs in
   step 6. This is the normal path.

   **Any `ATTESTATION_*` reason** — **STOP**. Do not re-run the matrix from
   here; producing evidence is `/local-attest`'s job and keeping that boundary
   explicit is the point. Report the reason and the recovery:

   ```text
   BLOCKED: local attestation is stale for current PR HEAD.

   Attested: <old-sha>
   Current:  <new-sha>

   Re-run:
     /pr-conductor <N> --from local-attest
     (or: dotbabel local-attest --pr <N>)
   ```

   The reasons and what each means:

   - `ATTESTATION_MISSING` — no attestation exists. A failed matrix posts no
     comment at all, so this also covers "the last run failed". Run the
     producer.
   - `ATTESTATION_STALE` — evidence names an earlier commit. Something pushed
     after the attestation. Run the producer against the new head.
   - `ATTESTATION_UNTRUSTED` — the comment's author is not in the configured
     trust list, or the comment was edited. Edited text is not what the tool
     wrote, so it is not evidence.
   - `ATTESTATION_INVALID` — the payload is absent, unreadable, or names a
     different commit than its own marker. Re-run the producer; if it repeats,
     the comment is not tool-written.
   - `ATTESTATION_CONFIG_CHANGED` — **re-running does not help.** This pull
     request edits a governed file (`.local-attest.config.mjs`,
     `.dotbabel.json`), so its own attestation cannot authorize it — otherwise
     a PR could weaken a check and then pass under the weakened check. Land the
     configuration change through explicit verification, and later pull
     requests attest against it once it is on the trunk.
   - `ATTESTATION_BASE_MOVED` — the evidence graded a different diff than the
     one merging. Rebase and re-attest.
   - `ATTESTATION_INCOMPLETE` / `ATTESTATION_FAILED` — a required check is
     missing from the evidence or did not pass. Read the named legs.

   **The repo does not enforce attestation** (no `attestation.enforce` in
   `.dotbabel.json` at the base ref, so the gate reports nothing either way) —
   take the explicit verification path in step 6. That is the state of any
   repository that has not adopted this, and of the pull request that adopts it.

5. **Re-verify criteria if step 3 reported `CRITERIA_EVIDENCE_STALE`.**

   This is the one path that still needs the PR head checked out:
   `dotbabel criteria verify` fails closed unless the worktree is clean and
   local `HEAD` equals the PR head (`plugins/dotbabel/src/criteria/preconditions.mjs`).

   ```bash
   git fetch origin
   git worktree add /tmp/merge-pr-<N> origin/<headRefName>
   cd /tmp/merge-pr-<N>
   dotbabel criteria verify --pr <N> --post
   dotbabel pr-stack gate --gate merge --pr <N>
   ```

   Never mutate the user's active working directory. Read the verify exit code
   before drawing any conclusion:

   - `0` — evidence re-posted against the current head. Continue.
   - `1` — a criterion actually fails. **STOP**; this is not a staleness problem.
   - `2` — an environment problem: missing trust, a dirty worktree, a `HEAD`
     that still differs from the PR head. Report _that_, and do not describe it
     as a moving head.

   Re-verify **once**. If the gate still reports `CRITERIA_EVIDENCE_STALE` after
   a clean `0`, the head really is moving under you — stop and say so rather
   than looping.

6. **Report the attested evidence — or verify explicitly.**

   **Attested path.** Read the attestation comment and report what it covers,
   naming the legs and the SHA. Never restate an attested leg as though this
   command ran it:

   ```bash
   gh api repos/{owner}/{repo}/issues/<N>/comments --paginate \
     --jq '.[] | select(.body | startswith("<!-- local-attest verified-sha=")) | .body' | tail -n +3
   ```

   Report it in this shape, naming the SHA and every leg:

   ```text
   verification: attested at 6115a98c
     legs: lint, test, validate-settings, bats, quality, dogfood, build-plugin
   ```

   The gate has already confirmed that SHA is the current head, that the
   evidence is trusted and unedited, that it was produced under the base
   branch's own configuration, and that every required leg passed. Go to
   step 8.

   **Explicit path** (step 4 sent you here). Create the worktree from step 5 if
   you have not already, then:

   - **Install dependencies first.** A fresh worktree has none, and a suite run
     without them reports a failure that is about the checkout, not the code.
     Detect from the lockfile: `package-lock.json` → `npm ci`;
     `pnpm-lock.yaml` → `pnpm i --frozen-lockfile`; `yarn.lock` →
     `yarn --immutable`; `go.sum` → `go mod download`; `uv.lock` → `uv sync`.
   - **Run the full project test suite.** Detect runner:
     - `Makefile` with `test` → `make test`
     - `package.json` → `npm test` (or `pnpm` / `yarn` based on lockfile)
     - `go.mod` → `go test ./...`
     - `pyproject.toml` → `pytest` or `uv run pytest`

     Paste the tail of output (last ~40 lines) regardless of pass/fail.

   - **Run the PR quality profile against the base branch:**

     ```bash
     dotbabel quality check --profile pr --base origin/<baseRefName>
     ```

     Exit code `1` means a checked rule failed. Exit code `2` means required evidence, trust, or tooling is unavailable. **STOP** for either exit code and surface the result — do not merge past it. Any other non-zero exit also means the gate did not run — `64` is invalid usage, and `127` is `dotbabel` not installed, which is the normal state on the bootstrap-only install path (see the top of `CLAUDE.md`). **STOP** there too, say which exit you got, and never report an unrun gate as a pass. Exit `0` means no error verdict; continue.

     Expect exit `2` on the first run: you are in a throwaway `/tmp/merge-pr-<N>` worktree, and project-command trust matches the repository path exactly, so a fresh worktree is never trusted. Resolve it deliberately, per PR — read the branch's own diff to `.dotbabel.json` and to any `package.json` scripts the tools invoke, then either trust that one path or run this step from your own checkout of the branch. Do not reach for a blanket `--allow-project-commands` here: in this flow it would execute commands defined by the pull request under review.

7. **Interpret failures honestly** (explicit path only). If the test suite fails:

   ```bash
   git stash push -u -m "merge-pr-<N>-baseline"
   <test-command>
   git stash apply <sha-from-git-stash-list>
   ```

   Report whether the failure already exists on `origin/<baseRefName>` or arrived with this PR. **Do not assert "already present on the base" without running this proof.** The stash stack is shared across worktrees, so tag your entry and apply it by SHA rather than popping blind.

8. **Verify CI is green.**

   ```bash
   gh pr checks <N>
   ```

   If any check is `failing` or `pending`, STOP and wait or ask the user. Note
   that an attested pull request legitimately shows a skipped `test` job — that
   is what the attestation bought — but every check that did run must be green.

9. **Re-run the merge gate, then request confirmation from the user.**

   Steps 5-8 can legitimately push — a criteria fix, a CI fix, a rebase for
   `BEHIND`. All the evidence this command trusts is pinned to a SHA, so the
   step 3 verdict only ever described the head it saw. Re-gate immediately
   before the irreversible action rather than trusting a verdict several steps
   old:

   ```bash
   dotbabel pr-stack gate --gate merge --pr <N>
   ```

   Then show:

- How this PR was verified: the attested SHA and legs, or the explicit run's results
- Quality gate result (attested, or this run's exit code)
- CI status
- The exact merge command you will run
  Wait for the user to say "merge" (or equivalent).

10. **Merge — with an explicit, marker-free squash subject AND body.**
    The default squash body concatenates the branch's commit messages, and —
    the sneakier half — on a **single-commit PR** the default squash _subject_
    is that commit's subject line, not the PR title. Every intermediate commit
    carries `[skip ci]` (the conductor requires it), GitHub honors the marker
    **anywhere** in the final message including line 1, and release-please is
    a push-triggered workflow — so a default merge silently suppresses the
    release for its own commits. Pass both halves explicitly, built from the
    PR title and description with any CI-suppression markers stripped:

    ```bash
    STRIP='s/\[skip ci\]//g; s/\[ci skip\]//g; s/\[no ci\]//g; s/\[skip actions\]//g; s/\[actions skip\]//g; s/skip-checks: *true//g'
    SUBJ="$(gh pr view <N> --json title -q .title | sed "$STRIP") (#<N>)"
    gh pr view <N> --json body -q .body | sed "$STRIP" > /tmp/merge-pr-<N>-body.md
    gh pr merge <N> --squash --delete-branch \
      --subject "$SUBJ" --body-file /tmp/merge-pr-<N>-body.md
    ```

    The strip list matches every form `dotbabel pr-stack gate --gate skip-ci`
    detects (`plugins/dotbabel/src/pr-gates.mjs`), not just the common three —
    a form the gate knows about but the strip misses is a marker that reaches
    `main`.

    Afterwards, verify the merge commit is marker-free — this exact flow has
    been beaten three ways (body, then subject) and the check is one line:

    ```bash
    git log --format=%B -1 <merge-sha> \
      | grep -nEi '\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks' \
      && echo "SUPPRESSED — run: gh workflow run release-please.yml --ref main" \
      || echo "clean"
    ```

    Then clean up the worktree, if step 5 or 6 created one:

    ```bash
    cd -
    git worktree remove /tmp/merge-pr-<N>
    ```

## Rules

- Never merge past an `ATTESTATION_*` reason, and never re-run the matrix from inside this command to clear one. Producing evidence is `/local-attest`'s job; this command only decides whether existing evidence is current and trustworthy.
- Never treat an attested leg as something this command verified. Report it as attested, name the SHA, and never report an unrun check as a pass.
- Never skip the full test suite on the explicit path, even if CI is green — CI config drift is real, and on a conductor-driven PR the remote suite did not run at all.
- Never let a squash merge carry a `[skip ci]` / `[ci skip]` / `skip-checks:` marker into main's history — it suppresses push-triggered workflows (release-please included) for the merge itself. Step 10's explicit `--subject`/`--body-file` flow exists for exactly this; the single-commit-PR default subject is the trap that bites after the body is fixed.
- Never claim a failure already exists on the base branch without the `git stash` proof.
- Never merge without explicit user confirmation. CI green alone is not authorization, and neither is a clean gate.
- Never force-push; never merge into `main`/`master` with failing local tests.
- Clean up temporary worktrees after merge, even on failure paths.
