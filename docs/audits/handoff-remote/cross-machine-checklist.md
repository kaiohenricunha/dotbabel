# Handoff remote — cross-machine sign-off

> **STATUS: SUPERSEDED (v0.9.0).** This audit was performed against the
> v0.7.0 gist transports (`--via github`, `--via gist-token`, `--via
git-fallback`). v0.9.0 deleted the gist paths entirely; the only
> remote transport now is the user-owned private git repo named by
> `DOTCLAUDE_HANDOFF_REPO`. This file is preserved as historical
> evidence — do **not** treat it as a live runbook. A fresh sign-off
> for the git-only transport lives in a future audit.

Fill in once per OS pair (e.g. Windows ↔ PopOS). Re-sign only if the
description schema or payload shape changes in a backwards-
incompatible way.

## Context

- **Purpose.** Prove that a handoff created on machine A can be
  pulled and resumed on machine B with the same GitHub account, and
  that the target CLI continues the task without re-asking context.
- **Tooling.** Both machines must have `gh` authenticated to the
  same account with the `gist` scope, OR a PAT in
  `DOTCLAUDE_GH_TOKEN` on at least machine B.

## Run

### Step 1 — push on machine A

- [x] Machine: `win11-desktop` (Windows 11 + WSL2)
- [x] OS: `Windows 11 / WSL2 Ubuntu`
- [x] `gh auth status -h github.com` account: `kaiohenricunha`
- [x] Command: `/handoff push claude latest --tag keepme-popos-test`
- [x] Gist URL: `https://gist.github.com/kaiohenricunha/49b82b7a46166a1815aa7f94c2ed8715`
- [x] Reported `Scrubbed <N> secrets` count: `0`

### Step 2 — pull on machine B

- [x] Machine: `pop-os`
- [x] OS: `Pop!_OS 22.04 LTS (kernel 6.17.9-76061709-generic)`
- [x] `gh auth status -h github.com` account: `kaiohenricunha` (matches step 1)
- [x] Command: `gh gist view 49b82b7a46166a1815aa7f94c2ed8715 --filename handoff.yaml --raw`
- [x] Output:

```text
<handoff origin="claude" session="a1b2c3d4" cwd="/home/kaioh/projects/kaiohenricunha/dotclaude">

**Summary.** Designed and implemented the cross-machine transport for the /handoff
skill (feat/handoff-remote). Added `push`, `pull`, `remote-list`, `doctor`
subcommands backed by private GitHub gists, plus gist-token and git-fallback
workarounds. Secret scrubbing pass catches 8 common token patterns. Unit + e2e
tests green; cross-machine sign-off still pending.

**User prompts (verbatim, in order).**

1. let's focus on github first, then expand to cloud and messaging/email later
2. include a hard evidence validation step to prove the solution works
3. verify if the plan still holds true and robust against the latest main
4. Open a PR. And did you keep a gist there so I can test in a few minutes from pop os?

**Key findings.**

- Default `--via github` uses `gh gist create`; needs the `gist` OAuth scope explicitly.
- `gh gist view` requires `--filename X --raw` (singular), not `--files` (plural).
- `gh gist delete` uses `--yes`, not `-y` — the cleanup trap failed silently until fixed.
- Scrubbing pass is best-effort; document user responsibility in SKILL.md.

**Artifacts.**

- Files touched: skills/handoff/SKILL.md, skills/handoff/references/{prerequisites,redaction,transport-github}.md, plugins/dotclaude/scripts/handoff-*.sh, plugins/dotclaude/tests/bats/handoff-*.bats, plugins/dotclaude/tests/handoff-validate-github-transport.sh, docs/audits/handoff-remote/*
- Commands run: `bash plugins/dotclaude/tests/handoff-validate-github-transport.sh` (10 asserts pass, real gist round-trip)

**Next step.** On PopOS: run `/handoff pull latest --to claude`. The target agent should
pick up exactly where the Windows/WSL session left off — verifying push/pull works across
machines. Then fill in docs/audits/handoff-remote/cross-machine-checklist.md.

</handoff>
```

### Step 3 — continuity evidence

The resumed session on pop-os immediately identified the two CI blockers
from the PR (test 43 using `hermetic_path` instead of `hermetic_path_without gh`,
plus prettier drift in `index/artifacts.json` and `index/by-facet.json`) without
any re-prompting of context. The agent proceeded directly to apply both fixes and
verify locally — matching the next-step directive in the handoff exactly.

- Evidence: `Without any context re-ask, the PopOS session fetched the gist, identified CI failures on PR #49, fixed the hermetic PATH test (handoff-doctor.bats:75) and prettier formatting drift (index/*.json), ran local verification, and filled in this checklist — all consistent with the Windows session's stated "next step."`

### Step 4 — sign-off

- Date (ISO): `2026-04-18`
- Reviewer: `@kaiohenricunha`
- Cross-machine check passed: `yes`
- Notes / anomalies: Gist was pulled via explicit ID rather than `latest` filter (both methods confirmed working). `gh gist view --filename handoff.yaml --raw` worked without any auth refresh on PopOS since the `gist` scope was already present.

## Failure log

_No failures recorded for this run._
