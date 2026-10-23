# Peer collaboration verification — 2026-10-16

_Last updated: v4.3.0_

## Current result

The implementation, skill distribution, architecture guide, and automated tests
are present. Peer tests pass: 62 tests across 10 files. Peer-only coverage is 91.48% lines, 83.90% branches,
93.79% functions, and 89.20% statements. The broader
Fleet/Handoff/bootstrap/sync selection passes 974 tests. The shared lock/hook
integration selection passes 149 tests, and the Bats selection passes 23 tests.

The resolved fast quality command exits 0 with warnings. Its configured test
command runs the repository suite; correctness and lint checks pass. Complexity,
function size, types, and several other measurements have no authoritative tool
configured. They are unavailable, not passing measurements. File-size advisories
remain warnings. No shipped threshold or project policy is lowered.

## Completion audit

| Requirement group                                                                                         | Current evidence                                                        | Result                                                                        |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Four role/harness pairings, ambiguity, code expiry, stale sessions, unpair/reconnect                      | `tests/peer/state.test.mjs`, `identity.test.mjs`, `cli.test.mjs`        | automated pass                                                                |
| Durable envelopes, both directions, correlated replies, ACK stages, deduplication and bounded retries     | `state.test.mjs`, `transport.test.mjs`, `relay.test.mjs`                | automated pass                                                                |
| Persistent FIFO, concurrent submission, enqueue while busy, priority/cancel, wait/reply, restart recovery | `store.test.mjs`, `state.test.mjs`, `relay.test.mjs`, `e2e.test.mjs`    | automated pass                                                                |
| Existing session actor and automatic next investigation                                                   | detached relay E2E with persistent isolated harness actors              | automated pass; live Codex with isolated peer also passes                     |
| Natural-language investigation/question/send/discussion/queue intent                                      | authored shared peer skill; deterministic command/state tests           | live Codex investigation/private discussion/queue checks pass; Claude pending |
| Shared and separate worktrees, current uncommitted/untracked files                                        | actual Git-worktree fixture and explicit Main worktree inspection path  | automated pass; no atomic multi-file snapshot claimed                         |
| Read-only Advisor, permissions and prompt-injection boundaries                                            | hook denial tests, skill instructions, isolated native adapter payloads | automated pass within documented hook coverage                                |
| Fleet and Handoff preservation                                                                            | regression selections and Bats round-trip                               | pass                                                                          |
| Claude and Codex skill/CLI distribution                                                                   | generated index/templates, bootstrap regression, npm package dry run    | pass                                                                          |
| Two live harnesses, both configurations, busy/idle model receipt and follow-up                            | live transport probes below; exact smoke procedure in user guide        | pending available Claude model quota                                          |

## Native observations

- Installed versions: Claude Code 2.1.302; Codex CLI 0.163.0.
- A dedicated Claude stream-json session publishes `peerProtocol: 1` and an inbox
  socket. A plain UTF-8 notification line starts a peer-origin command/turn.
  The model returns `429`, `usage_limit_reached`, with a weekly-limit reset notice.
  This proves native ingress, not model processing or a reasoning reply.
- `codex queue --thread "$CODEX_THREAD_ID" --message '<scoped probe>'` exits 0
  and prints `Queued message ... for thread ...` for this active Codex thread.
  The queued probe `PEER-PROOF-20261016` subsequently arrives as a user message
  in this thread, after the sending turn ends. The receiving model replies:
  "Received `PEER-PROOF-20261016`. The active implementation goal remains unchanged."
  This confirms subsequent-turn model receipt and acknowledgment for this Codex
  thread. It does not prove mid-turn interruption or a two-harness round trip.
- The real CLI `peer main`, `peer status --json`, and `peer unpair` run in an
  isolated state directory inside the current Codex tool environment. Main resolves
  automatically as Codex, with the actual thread ID, PID incarnation, repository,
  worktree, and `main_alive: true`. The pair then closes successfully.
- The detached-relay E2E uses real private Unix sockets and independent CLI
  processes. Its persistent isolated actors execute three investigations, accept
  two submissions during the first, and acknowledge six bidirectional messages.
  It does not make model calls or count as the requested live Claude/Codex smoke.

## Native Codex actor acceptance

A real interactive Codex 0.163.0 thread (`01a146ee-1614-77b3-bf37-b7a7197c1ae4`)
pairs as Advisor through the trusted peer hook. The opposite endpoint is an
isolated Python/socket adapter, **not a Claude model**. The model reads the real
peer skill and an untracked `link-account.mjs` fixture. No implementation file
changes and no test execution occur inside Advisor.

| Request                       | Created (UTC) | Started (UTC) | Finished (UTC) | Result                                  |
| ----------------------------- | ------------- | ------------- | -------------- | --------------------------------------- |
| Race investigation            | 23:09:07.603  | 23:09:08.278  | 23:09:36.594   | completed; finding sent                 |
| Uniqueness discussion         | 23:09:24.465  | 23:09:36.630  | 23:09:49.220   | completed; forwarding suppressed        |
| Concurrent test design        | 23:09:24.691  | 23:09:50.144  | 23:10:03.612   | completed; forwarding suppressed        |
| Idle notification queue check | 23:11:03.833  | 23:11:04.094  | 23:11:16.518   | completed without a new terminal prompt |

Both additional questions enter the independent CLI while the first investigation
runs. The ledger proves sequential execution, explicit results, no overlap, and
automatic progression. Only the first request sends a finding. The adapter
acknowledges it, sends a correlated reply, and the real model records that reply
as processed. A conversational queue question creates no new investigation or
peer message. A fourth externally enqueued request wakes the idle native thread
and completes automatically.

The same native thread then unpairs and registers as Main. An isolated Advisor
adapter sends a question; native Codex reads the fixture, records processing, and
sends one correlated reply. The adapter acknowledges it. Both test pairs close,
the detached relays exit, and the adapter and terminal processes stop.

The fixture remains byte-for-byte unchanged, SHA-256
`fac558b163a318efd37839d1ccacacf717bfe64e17fc6f165b7a933b66daf0cb`.
Selected ledger evidence is retained locally in
`/tmp/dotbabel-peer-proof/codex-live/native-proof.json` and `reverse-proof.json`.
These are native Codex actor tests with isolated peers; they do not establish a
Claude/Codex model round trip or mid-turn steering.

## Native registration diagnosis and fix

The live tool-shell probe reports PID 2, parent PID 1, and the correct exported
thread UUID. Missing session metadata is therefore rejected as the root cause.
The confirmed cause is PID namespace isolation: `identity.mjs` requires a verified
Codex ancestor, which the namespaced shell cannot see. Relaxing that check would
trust an unverified UUID and is not used.

A separately reviewed native PreToolUse probe, after session resume, runs under
the host Codex daemon and receives the correct session ID. The installed peer
hook therefore handles only deterministic literal coordination operations on the
host. It returns a result-printing shell command, never host-executes proposed
shell text, preserves the Advisor guard, and rejects repository overrides and
execution wrappers. Large responses point to the exact pair/result in the durable
ledger instead of exceeding the shell argument limit. Regression tests cover
registration, shell quoting, command injection, oversized output, and untrusted
executable paths. Other implementation commands retain their permission checks.

## PR review and hardening

The delivery review reproduces two defects and fixes both before publication.

| Candidate cause                                                      | Evidence for/against                                                                                                                               | Decision                                                                                                                                |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Native notification loss prevents a waiting request from resuming    | A direct domain-only probe stores Main's reply, then records the wait. It returns `waiting_for_peer` and `next: null` without involving transport. | Rejected as the cause of this reproduction.                                                                                             |
| Wait recording overwrites an already available reply                 | Reply handling resumes requests only when they are already waiting; the later wait transaction previously did not inspect saved replies.           | Confirmed; inspect correlated durable replies before entering waiting state.                                                            |
| Domain operations persist unknown lifecycle values                   | Existing domain transition validation accepts only known states; normal snapshots in tests remain valid.                                           | Rejected for the corruption reproduction.                                                                                               |
| Snapshot validation checks string types without lifecycle membership | Replacing a saved request state with `corrupted-state` previously succeeds on read.                                                                | Confirmed; validate known request/delivery states, message kinds and text bounds, sequence type, active leases, and one active request. |

The red test run fails nine tests for these causes. The fixed peer suite passes
62 tests. A separate-process CLI regression sends Main's reply before `wait`,
then verifies immediate requeue, a fresh lease, and successful completion.
A negative case keeps waiting when a reply addresses another question. Seven
malformed-snapshot cases verify both rejection and byte-for-byte preservation.

The public-function run now prints:

```json
{ "state_after_wait": "queued", "resumed_same_request": true, "fresh_lease": true }
```

A fresh native CLI registration/status/unpair run inside the current Codex tool
environment resolves harness `codex`, `main_alive: true`, the actual Dotbabel
`peer-collaboration` worktree, and finally `closed: true`. This tests current
registration and snapshot validation; it does not replace the pending two-model
Claude/Codex scenario. The earlier interactive actor observations remain scoped
to the behaviors and versions recorded above.

The review finds no new dependency, public API removal, schema/spec change,
Handoff change, Fleet claim change, or automatic production operation. The shared
lock extraction preserves the original exports and is covered by catalog and
Fleet regressions. Unsupported static measurements remain unavailable.

## Verification commands

The excerpts below retain each command's last ten output lines, or all lines when
shorter. Commands run from the implementation worktree. Initial failing TDD runs
and intermediate failures are superseded by these successful runs. One concurrent
quality run observes the newly added large-output test before its fix and fails;
the final quality run occurs after all source and test changes. A regression
invocation with quoted filename globs selects only 153 tests; the recorded
unquoted command is rerun and verifies all 974 tests.

### Peer behavior and coverage

```bash
npm test -- plugins/dotbabel/tests/peer --coverage --coverage.include='plugins/dotbabel/src/peer/**'
```

```text
 store.mjs     |   88.17 |    84.61 |     100 |   89.53 | ...11,147-149,158,164
 transport.mjs |   83.87 |    65.38 |   81.25 |   90.74 | 21,41,48,63,119
---------------|---------|----------|---------|---------|-----------------------

=============================== Coverage summary ===============================
Statements   : 89.2% ( 785/880 )
Branches     : 83.9% ( 740/882 )
Functions    : 93.79% ( 121/129 )
Lines        : 91.48% ( 688/752 )
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
      Tests  974 passed (974)
   Start at  20:40:20
   Duration  8.32s (tests 83%, transform 10%, import 4%, setup 2%, worker 1%)

```

### Shared lock and hook integration regressions

```bash
npm test -- plugins/dotbabel/tests/peer plugins/dotbabel/tests/model-intelligence-catalog.test.mjs plugins/dotbabel/tests/dotbabel-doctor.test.mjs plugins/dotbabel/tests/hook-registration.test.mjs
```

```text


 RUN  v5.0.0 /home/kaiocunha/projects/kaiohenricunha/dotbabel/.claude/worktrees/peer-collaboration


 Test Files  13 passed (13)
      Tests  149 passed (149)
   Start at  20:40:28
   Duration  6.22s (tests 91%, transform 7%, import 1%, setup 1%)

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
  ✓ spec coverage ok (16 protected file(s) changed)
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
  ✓ plugin templates fresh (212 files + manifest)
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
Linting: 1363 files
Summary: 0 issues in 0 files
check-jsdoc-coverage: ok — 133 file(s) scanned, every export documented.
```

## PR quality profile

The final delivery run executes the PR profile against `origin/main` and exits 0
with warnings. Changed-line coverage, changed-branch coverage, and coverage
regression checks pass. No test script, quality threshold, or workflow is changed.

```bash
node plugins/dotbabel/bin/dotbabel-quality.mjs check --profile pr --base origin/main
```

```text
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.compile [checked] — check passed
  pass correctness.lint [checked] — check passed
  pass correctness.tests [checked] — check passed

.:javascript / regression
  pass coverage.no_regression [checked]
```

A separate availability probe using Claude's `haiku` alias also returns
`429 usage_limit_reached`, with the same October 19 reset notice. No account,
credential, billing, permission, or persistent hook setting is changed to obtain
model access. The cross-harness model smoke remains explicitly unavailable.

## CI distribution corrections

The first PR run rejects missing version stamps in both new documents and
missing peer exports in the example and project CLI fan-out. The local checks
reproduce both distribution failures. Regenerating with the shipped scaffolder
and project-sync command adds only the peer skill, manifest entry, and three
exports; no check is weakened.

```bash
node scripts/stamp-doc-versions.mjs --check
```

```text
✓ all 21 docs stamped with v4.0.1
```

```bash
npm exec -- bats plugins/dotbabel/tests/bats/example-parity.bats plugins/dotbabel/tests/bats/project-sync-parity.bats
```

```text
1..3
ok 1 example-parity: minimal-consumer matches fresh scaffolder output
ok 2 project-sync-parity: the committed fan-out matches what project-sync would write
ok 3 project-sync-parity: the checker reports a stale generated file, so the gate is not vacuous
```

## Remaining validation

Run the [two-terminal smoke procedure](peer-collaboration.md#real-two-terminal-smoke-test)
after Claude model access is available. Record processing and acknowledgment in
both configurations, including busy and idle recipients and natural-language
forwarding suppression. Do not mark the primary live acceptance scenario complete
from mocked tests, native transport acceptance, or this document alone.
