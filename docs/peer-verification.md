# Peer collaboration verification — 2026-10-16

## Current result

The implementation, skill distribution, architecture guide, and automated tests
are present. Peer tests pass: 49 tests across 10 files. Peer-only coverage is
89.98% lines, 81.71% branches, 93.49% functions, and 87.69% statements. The broader
Fleet/Handoff/bootstrap/sync selection passes 961 tests. The shared lock/hook
integration selection passes 136 tests, and the Bats selection passes 23 tests.

The resolved fast quality command exits 0 with warnings. Its configured test
command runs the repository suite; correctness and lint checks pass. Complexity,
function size, types, and several other measurements have no authoritative tool
configured. They are unavailable, not passing measurements. File-size advisories
remain warnings. No shipped threshold or project policy is lowered.

## Completion audit

| Requirement group                                                                                         | Current evidence                                                        | Result                                                |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| Four role/harness pairings, ambiguity, code expiry, stale sessions, unpair/reconnect                      | `tests/peer/state.test.mjs`, `identity.test.mjs`, `cli.test.mjs`        | automated pass                                        |
| Durable envelopes, both directions, correlated replies, ACK stages, deduplication and bounded retries     | `state.test.mjs`, `transport.test.mjs`, `relay.test.mjs`                | automated pass                                        |
| Persistent FIFO, concurrent submission, enqueue while busy, priority/cancel, wait/reply, restart recovery | `store.test.mjs`, `state.test.mjs`, `relay.test.mjs`, `e2e.test.mjs`    | automated pass                                        |
| Existing session actor and automatic next investigation                                                   | detached relay E2E with persistent isolated harness actors              | automated pass; live models pending                   |
| Natural-language investigation/question/send/discussion/queue intent                                      | authored shared peer skill; deterministic command/state tests           | live semantic validation pending                      |
| Shared and separate worktrees, current uncommitted/untracked files                                        | actual Git-worktree fixture and explicit Main worktree inspection path  | automated pass; no atomic multi-file snapshot claimed |
| Read-only Advisor, permissions and prompt-injection boundaries                                            | hook denial tests, skill instructions, isolated native adapter payloads | automated pass within documented hook coverage        |
| Fleet and Handoff preservation                                                                            | regression selections and Bats round-trip                               | pass                                                  |
| Claude and Codex skill/CLI distribution                                                                   | generated index/templates, bootstrap regression, npm package dry run    | pass                                                  |
| Two live harnesses, both configurations, busy/idle model receipt and follow-up                            | live transport probes below; exact smoke procedure in user guide        | pending available Claude model quota                  |

## Native observations

- Installed versions: Claude Code 2.1.302; Codex CLI 0.163.0.
- A dedicated Claude stream-json session publishes `peerProtocol: 1` and an inbox
  socket. A plain UTF-8 notification line starts a peer-origin command/turn.
  The model returns `429`, `usage_limit_reached`, with a weekly-limit reset notice.
  This proves native ingress, not model processing or a reasoning reply.
- `codex queue --thread "$CODEX_THREAD_ID" --message '<scoped probe>'` exits 0
  and prints `Queued message ... for thread ...` for this active Codex thread.
  Queue acceptance is not counted as delivered or processed.
- The real CLI `peer main`, `peer status --json`, and `peer unpair` run in an
  isolated state directory inside the current Codex tool environment. Main resolves
  automatically as Codex, with the actual thread ID, PID incarnation, repository,
  worktree, and `main_alive: true`. The pair then closes successfully.
- The detached-relay E2E uses real private Unix sockets and independent CLI
  processes. Its persistent isolated actors execute three investigations, accept
  two submissions during the first, and acknowledge six bidirectional messages.
  It does not make model calls or count as the requested live Claude/Codex smoke.

## Verification commands

The excerpts below retain each command's last ten output lines, or all lines when
shorter. Commands run from the implementation worktree. Initial failing TDD runs
and intermediate integration failures are superseded by these successful runs.

### Peer behavior and coverage

```bash
npm test -- plugins/dotbabel/tests/peer --coverage --coverage.include='plugins/dotbabel/src/peer/**'
```

```text
 store.mjs     |   83.52 |    78.26 |     100 |   84.61 | ...65,101-103,112,118
 transport.mjs |   83.87 |    65.38 |   81.25 |   90.74 | 21,41,48,63,119
---------------|---------|----------|---------|---------|-----------------------

=============================== Coverage summary ===============================
Statements   : 87.69% ( 720/821 )
Branches     : 81.71% ( 648/793 )
Functions    : 93.49% ( 115/123 )
Lines        : 89.98% ( 629/699 )
================================================================================
```

### Fleet, Handoff, bootstrap, and project sync

```bash
npm test -- plugins/dotbabel/tests/peer plugins/dotbabel/tests/fleet-*.test.mjs plugins/dotbabel/tests/handoff-*.test.mjs plugins/dotbabel/tests/bootstrap-global.test.mjs plugins/dotbabel/tests/project-sync.test.mjs
```

```text
dotbabel-handoff: extract error
dotbabel-handoff: meta returned non-JSON: Unexpected token 'o', "not-json" is not valid JSON
dotbabel-handoff: meta extraction failed for claude
dotbabel-handoff: description encode failed: encode failed

 Test Files  41 passed (41)
      Tests  961 passed (961)
   Start at  19:49:06
   Duration  5.03s (tests 84%, transform 10%, import 4%, setup 1%)

```

### Shared lock and hook integration regressions

```bash
npm test -- plugins/dotbabel/tests/peer plugins/dotbabel/tests/model-intelligence-catalog.test.mjs plugins/dotbabel/tests/dotbabel-doctor.test.mjs plugins/dotbabel/tests/hook-registration.test.mjs
```

```text


 RUN  v5.0.0 /home/kaiocunha/projects/kaiohenricunha/dotbabel/.claude/worktrees/peer-collaboration


 Test Files  13 passed (13)
      Tests  136 passed (136)
   Start at  19:47:46
   Duration  6.95s (tests 86%, transform 10%, setup 2%, import 1%)

```

### Bootstrap and Handoff shell integration

```bash
npm exec -- bats plugins/dotbabel/tests/bats/bootstrap.bats plugins/dotbabel/tests/bats/handoff-integration.bats
```

```text
ok 14 CODEX_HOME override populates custom path
ok 15 resolve (short UUID) → extract meta → valid JSON with expected session_id
ok 16 customTitle → pull via CLI → <handoff> block names the session
ok 17 resolve (codex thread_name alias) → extract prompts → user prompt present
ok 18 push → pull <short-uuid> round-trip returns equivalent <handoff> content
ok 19 push --tag → transport description carries the tag segment
ok 20 list --local → pull --summary on each candidate → 0 exit for both CLIs
ok 21 pull -o <path> writes a markdown file containing the <handoff> block
ok 22 list after multiple pushes shows all sessions (remote column populated)
ok 23 pull --summary --json → pipe to jq → origin.session_id equals seeded UUID
```

### Repository governance

```bash
npm run dogfood
```

```text

  ✓ manifest valid (50 skills)
  ✓ agents valid (no errors)
  ⚠ agents/iac-engineer.md: trigger "pulumi" also claimed by: pulumi-engineer — but ## Collaboration does not reference them
  ✓ 9 spec(s) valid
  ✓ instruction files match repo facts
  ✓ generated instruction files are fresh
  ✓ generated instruction headings have parity
  ✓ spec coverage ok (0 protected file(s) changed)
  ✓ schemas/dotbabel.compute.schema.json fresh
```

### Generated inventory

```bash
node plugins/dotbabel/bin/dotbabel-index.mjs --check
```

```text
  ✓ index fresh (74 artifacts)
```

### Generated plugin

```bash
node scripts/build-plugin.mjs --check
```

```text
  ✓ plugin templates fresh (210 files + manifest)
```

### Resolved fast quality profile

```bash
node plugins/dotbabel/bin/dotbabel.mjs quality check --profile fast
```

```text
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.lint [checked] — check passed
  pass correctness.tests [checked] — check passed
```

### Relay cleanup after the end-to-end run

```bash
npm test -- plugins/dotbabel/tests/peer/e2e.test.mjs
```

```text


 RUN  v5.0.0 /home/kaiocunha/projects/kaiohenricunha/dotbabel/.claude/worktrees/peer-collaboration


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  19:51:29
   Duration  3.82s (tests 98%, transform 1%)

```

### Final Markdown/JSON/YAML and exported JSDoc lint

```bash
npm run lint
```

```text
> @dotbabel/dotbabel@4.0.1 lint
> prettier --check "**/*.{json,yml,yaml,md}" --ignore-path .gitignore --ignore-path .prettierignore --ignore-unknown && markdownlint-cli2 "**/*.md" "#node_modules" "#.claude/worktrees" && node scripts/check-jsdoc-coverage.mjs plugins/dotbabel/src

Checking formatting...
All matched files use Prettier code style!
markdownlint-cli2 v0.23.2 (markdownlint v0.41.1)
Finding: **/*.md !node_modules !.claude/worktrees !node_modules/** !.claude/worktrees/** !plugins/dotbabel/tests/fixtures/** !commands/** !skills/** !.claude/commands/** !.claude/skills/** !**/security-audit/references/upstream/**
Linting: 1356 files
Summary: 0 issues in 0 files
check-jsdoc-coverage: ok — 132 file(s) scanned, every export documented.
```

## Remaining validation

Run the [two-terminal smoke procedure](peer-collaboration.md#real-two-terminal-smoke-test)
after Claude model access is available. Record processing and acknowledgment in
both configurations, including busy and idle recipients and natural-language
forwarding suppression. Do not mark the primary live acceptance scenario complete
from mocked tests, native transport acceptance, or this document alone.
