# Handoff remote — audit artifacts

> **UX note.** The invocation examples in this folder predate the
> five-form public surface landed on the `feat/handoff-shell-refactor`
> branch (PR #58). Current invocations are `/handoff push [<query>]`
> and `/handoff pull [<query>]`; the older
> `/handoff push claude latest --to codex` form shown below is superseded.
> Transport mechanics, secret scrubbing, and the description schema are
> unchanged. See `skills/handoff/SKILL.md` for the current shape.

This folder holds evidence-of-correctness for the handoff remote
transport (GitHub-first). It is intentionally inspectable rather
than prose-claim: reviewers read the artifacts, not the PR body.

## Files

- `run-log.jsonl` — one JSON line per execution of the end-to-end
  validation harness
  (`plugins/dotclaude/tests/handoff-validate-github-transport.sh`).
  Format documented inline in the harness header.
- `cross-machine-checklist.md` — manual sign-off template for the
  Windows ↔ PopOS handshake. Executed once per OS pair.

## How to produce evidence

1. **Unit evidence (every PR).** `npx bats
plugins/dotclaude/tests/bats/handoff-scrub.bats
plugins/dotclaude/tests/bats/handoff-description.bats
plugins/dotclaude/tests/bats/handoff-doctor.bats` must exit 0.
2. **E2E evidence (opt-in, before merge).**
   `bash plugins/dotclaude/tests/handoff-validate-github-transport.sh`
   on a machine with `gh auth status` active. The script appends a
   receipt to `run-log.jsonl` on success.
3. **Cross-machine evidence (once per OS pair).** Fill in
   `cross-machine-checklist.md` with real gist URLs and the output
   of `/handoff pull latest` on the target machine.

## Review contract

A PR that modifies the handoff remote surface (SKILL.md, any of the
three helper scripts, any reference doc) must attach:

- The `run-log.jsonl` line-hash (or a timestamp range) produced
  during evidence generation.
- The GitHub account that authored the run (from the receipt).
- Cross-machine checklist touched with a dated sign-off, IF the
  change touches the transport contract (description schema,
  payload shape, new transport). Pure bug fixes may skip this tier.

Claim of "verified locally" without a run-log line is insufficient.
