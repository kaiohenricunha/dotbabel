# §7 — Non-Functional Requirements

> Ordered by gravity. **REL** and **SEC** are load-bearing invariants
> that fail closed, are testable, and protect users from concrete harm.
> **PERF** and **OPS** are ceilings — they describe expected behavior
> and bound future drift. The order of subsections matches the weight
> each category carries.
>
> Every constraint in this section is testable: a number to assert
> against, a behavior to verify, a regression to catch.

## Reliability

### REL-1 — Scrub is fail-closed

`push` aborts with exit 2 and writes nothing to the remote if any of
the following holds:

- `perl` is not on PATH.
- `handoff-scrub.sh` exits non-zero for any reason.
- `handoff-scrub.sh` does not emit a `scrubbed:<N>` count line on stderr.
- The count line cannot be parsed as a non-negative integer.

The error prefix is `scrub not applied:` (per §5.3.3). No partial-scrub
mode, no "best-effort" fallback. An unscrubbed digest cannot reach the
remote.

**Test:** vitest unit + bats integration. Inject a missing-perl, a
non-zero-exit, and a missing-count-line scenario; assert exit 2 and
zero git operations performed.

### REL-2 — Collision probe is fail-closed

`push` aborts with exit 2 if the target branch already exists on the
remote and its `metadata.json.session_id` differs from the local
session_id. `--force-collision` is the explicit, documented override.

**Test:** bats integration against a `file://` bare repo seeded with a
foreign-session branch; assert exit 2 without `--force-collision`,
exit 0 with it.

### REL-3 — Bootstrap is idempotent

Running `dotbabel handoff push` repeatedly when bootstrap is needed:

- If `gh repo create` reports the repo already exists, the binary
  treats it as a re-use, not an error.
- If the persisted env file already contains a valid URL,
  `loadPersistedEnv()` does not overwrite a caller-set
  `DOTBABEL_HANDOFF_REPO`.
- Re-running with the same `--from <cli>` and same source session
  produces the same branch path; the second push hits the
  same-session-id update path of REL-2, not the collision path.

**Test:** bats integration that runs bootstrap → bootstrap → push
back-to-back against a fresh `gh` mock; assert single repo creation,
no duplicate config writes, idempotent push outcome.

## Security

### SEC-1 — Scrub patterns are spec-frozen

The eight perl regex passes in `handoff-scrub.sh` (GitHub tokens,
OpenAI/sk-_, AWS access keys, Google API keys, Slack tokens,
`Authorization: Bearer …`, `_\_TOKEN`/`KEY`/`SECRET`/`PASSWORD`=…,
PEM private keys) are the complete redaction set for v1.x. Adding,
removing, or modifying a pattern requires:

1. An amendment to this constraint.
2. An update to `skills/handoff/references/redaction.md`.
3. A corresponding test in `handoff-scrub.bats`.

Patterns ship as a single change set, not piecemeal.

**Test:** dedicated bats suite with one positive + one boundary case
per pattern; the suite is the authoritative pattern inventory.

### SEC-2 — Transport URL validator rejects exec-triggering schemes

`validateTransportUrl()` (in `plugins/dotbabel/src/lib/handoff-remote.mjs`)
must accept only:

- `https://`
- `http://`
- `git@`
- `ssh://`
- `file://`
- absolute filesystem paths (leading `/`)

Any URL matching `ext::`, `data:`, `javascript:`, or any other scheme
is rejected with exit 2. This is the CVE-2017-1000117 class of attack
(malicious git URLs that exec arbitrary commands when fed to git
operations).

**Test:** unit test on the validator with a fixture of known-bad
schemes; bats integration on `push` with `DOTBABEL_HANDOFF_REPO=ext::…`
asserting exit 2 before any git op fires.

### SEC-3 — Persisted env file is mode 0600

`$XDG_CONFIG_HOME/dotbabel/handoff.env` (default
`~/.config/dotbabel/handoff.env`) is written with mode `0600` and
its parent directory with `0700`. The file may contain a path that
embeds an SSH credential helper hint or a token in a `git@` URL with
embedded auth; world-readable mode is unacceptable.

**Test:** bats verification of `stat -c '%a' <file>` post-bootstrap.

### SEC-4 — Per-branch payload ceiling

`handoff.md` written by `push` is bounded:

- Typical: ≤ 50 KB.
- Hard ceiling: 1 MB. `push` aborts with exit 2 before commit if the
  rendered+scrubbed block exceeds 1 MB.

This pairs with PERF-2's input ceiling (5 MB raw input) and bounds the
worst-case `fetch` shallow-clone size. A handoff block that exceeds
1 MB is unfit for its purpose anyway — it's no longer paste-able into
a target agent's prompt window.

**Test:** unit test against a synthetic prompts/turns input that
renders a > 1 MB block; assert exit 2 with the ceiling-message error.

## Performance

### PERF-1 — Remote-list latency ceiling, baselined in Phase 1

`list --remote` against a store with **≤ 1000 handoff branches** on a
warm connection should complete in **< 2 s**. This is the §3 ARCH-9
target.

**Caveat:** the 1000-branch / 2-second pair is an unvalidated estimate
at spec time. Phase 1 (per §6.1) establishes the actual baseline by
running `list --remote` against a synthetic 1000-branch fixture. If
reality differs, the ceiling adjusts; the **behavior** does not. PERF-1
is a guardrail against regression, not a contract for users to plan
against.

**Test:** Phase 1 — generate fixture, measure, record baseline.
Subsequent PRs run the same fixture and fail CI on > 1.5x baseline
regression.

### PERF-2 — Scrub on bounded input

The scrubber must complete a single push within **< 1 s for inputs
≤ 1 MB**. For inputs **> 5 MB**, `push` aborts with exit 2 before the
scrubber runs (the input is unfit for purpose; see SEC-4 commentary).

**Reasoning.** Eight perl regex passes against the full handoff block
are microseconds for normal sessions, but a pathological 50 MB session
(someone pasted a giant log as part of their conversation) could stall
the scrubber for tens of seconds. The 5 MB pre-scrub ceiling acts as
a smell detector before the user notices.

**Test:** vitest microbenchmark against synthetic 100 KB / 1 MB / 5 MB /
6 MB inputs; assert latency budget for ≤ 1 MB and exit-2 for > 5 MB.

## Operational

### OPS-1 — Drift test runs as a CI gate on every PR

ARCH-10's drift test (`plugins/dotbabel/tests/handoff-drift.test.mjs`)
runs in CI on every PR that touches:

- `skills/handoff/**`
- `plugins/dotbabel/bin/dotbabel-handoff.mjs`
- `plugins/dotbabel/src/lib/handoff-remote.mjs`
- `docs/handoff-guide.md`

Failing drift = failing PR. No "drift will be cleaned up later" PRs;
the cleanup is part of the same PR that introduced the drift.

**Test:** the drift test itself, plus a CI smoke that intentionally
breaks the assertion via a fixture and expects red.

### OPS-2 — Stdout determinism across TTY / non-TTY

The `<handoff>` block on `pull` / `fetch`, and the four-line success
output on `push`, are emitted on stdout **identically** regardless of
whether stdout is a terminal or a pipe. Specifically:

- Spinners, progress indicators, and `✓` icons go to **stderr only**.
- ANSI color codes are not emitted on stdout under any condition.
- Interactive prompts (bootstrap, collision pick) go to stderr.
- A consumer wrapping the binary in a shell pipeline gets the same
  bytes as a human running it interactively.

**Test:** bats integration runs each command with `< /dev/null` and
captures stdout to a file; asserts byte-for-byte equality with the
TTY-emulated run via `script` or equivalent.

### OPS-3 — Exit codes are a public contract

The exit code set `{0, 1, 2, 64}` from §5.3 is frozen. Adding a new
exit code (e.g. exit 3 for "partial success", exit 5 for "rate
limited") requires a spec amendment. Reuse of an existing code is
fine.

**Test:** drift test asserts the exit-code matrix in §5.3 against
what the binary actually emits via fixture-driven bats coverage of
each named condition.

### OPS-4 — Cross-platform support: Linux + macOS first-class, Windows via WSL

Substrate requirement: POSIX shell + GNU `jq` + `perl 5` + `git`.
Versions are not pinned; the substrate scripts use POSIX-portable
constructs only (`pick_newest()` per `handoff-resolve.sh:39-62` is
already portable across GNU `find` and BSD `stat`).

Native Windows (cmd / PowerShell direct) is **out of scope**. WSL
counts as Linux; Git Bash on Windows is unsupported (best-effort).

**Test:** CI matrix runs the bats suite on Ubuntu LTS + macOS latest
on every PR. No Windows CI lane.

## Concurrent Push

Two machines pushing the same source short_id at the same time is
covered by KD-1 (force-push of own branch) + REL-2 (collision probe).
Last writer wins for same-session-id. Different-session-id collision
exits 2 unless `--force-collision`. **No separate constraint** — this
is a derived consequence of REL-2, not a feature to engineer.

## Explicit Non-Requirements

The following are explicitly **not** part of the spec's SLA. Future
PRs that try to add them must amend this section first.

| Non-requirement                                      | Why deliberately excluded                                                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub availability**                              | The skill depends on GitHub for the remote transport. When GitHub is down, `push` and `fetch` fail; the user re-runs when service returns. Building local queueing or alternate-region fallback is out of scope.                       |
| **Upstream CLI session-file format stability**       | Claude Code, Copilot CLI, and Codex CLI may change their on-disk JSONL formats without coordination. The substrate scripts adapt as needed; the skill does not promise to work against future format changes that haven't shipped yet. |
| **Transient network failure recovery**               | No retry, no exponential backoff, no transient-error classifier. `git`'s defaults stand. If the network fails, the user re-runs. Adding a retry layer adds a state machine to a CLI that exits in <5s — wrong tradeoff.                |
| **Custom scrub patterns / per-user redaction rules** | The eight patterns in SEC-1 are the redaction surface. Per-user customization adds drift between machines and risks unscrubbed leaks; out of scope.                                                                                    |
| **Encrypted-at-rest remote payloads**                | Already in §2 out-of-scope; restated here. The private-repo + git-auth model is the threat model.                                                                                                                                      |
| **Auto-prune of old branches / TTL on the store**    | KD-3 already de-scopes this. Restated as a non-NFR so future PRs don't slip it in via an "operational" framing.                                                                                                                        |
| **Real-time push notification on the remote**        | The user pulls when they sit down at the other machine; no webhook / push notification / server-sent event is part of this skill.                                                                                                      |

## Cross-references

- §3 ARCH-9 — scalability target that PERF-1 sharpens.
- §3 ARCH-10 — drift-test invariant that OPS-1 elevates to an operational gate.
- §4 KD-1 / KD-2 — policy decisions whose enforcement lives in REL-2 and the SEC-4 ceiling.
- §5.1 — frozen schemas; §7 doesn't change them, it bounds what they can grow to.
- §5.3 — exit-code matrix that OPS-3 freezes as a public contract.
- §6.4 — testing strategy that operationalizes every constraint here.
- §8 — risks specific to leaning on these invariants (e.g. SEC-1's eight-pattern set being insufficient for an unknown future secret format).
