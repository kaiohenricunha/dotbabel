# Native peer adapter verification — 2026-10-18

_Last updated: v4.4.0_

## Scope and result

OpenCode v2, Copilot CLI, and managed Antigravity CLI streams each run as both
Main and Advisor in real native conversations. The three pairings exchange five
correlated, explicitly processed roundtrips. Ten investigations complete. Six
private investigations produce no messages to Main. The controlled interrupted
and unresponsive probes retain cancelled and failed states, respectively.

This is not a claim that every live probe succeeds: the additional OpenCode
long-idle reply does not arrive. Its accepted notification remains unprocessed
and becomes unresponsive. The native Advisor records failure before unpairing.
The cause inside the native runtime is not established.

The implementation commit is `9da219b59617c3629a1db971b2784bcd1eeb1f43`.
Live validation spans implementation and its regression fixes; automated checks
cover that commit. The machine-readable [evidence](peer-native-evidence-2026-10-18.json)
contains native actor IDs, request states, message correlation, and receipt states.
It excludes transcripts, authentication material, and lease tokens.

## Native actor matrix

| Main              | Advisor           | Durable pair                                | Completed work                           | Processed roundtrips |
| ----------------- | ----------------- | ------------------------------------------- | ---------------------------------------- | -------------------- |
| OpenCode 2.0.5    | Copilot 1.0.98    | `pair-f12e31af-181d-4ce7-a945-b2bd961807c9` | 3 completed; extra idle probe failed     | 1                    |
| Antigravity 1.4.2 | OpenCode 2.0.5    | `pair-0dba6c7b-4954-4194-8373-21bab9a18c13` | 4 completed                              | 2                    |
| Copilot 1.0.98    | Antigravity 1.4.2 | `pair-b3c5a831-7242-47ed-8958-9e04d2265d9b` | 3 completed; interrupted probe cancelled | 2                    |

Each row includes two completed `forward: never` investigations. No message
references their request IDs. Additional independent-shell submissions persist
while Advisor work is running. Equal-priority work follows FIFO, including after
an explicit wait releases the active slot. The final Antigravity ownership
follow-up wakes an idle Advisor, completes, and receives a processed Main reply.

OpenCode supplies real `ses_...` IDs through its v2 plugin context. Copilot's
`joinSession` extension binds the foreground conversation; tool invocations use
its actual SDK session ID. Antigravity supplies its ID in the native init event.
Controllers enqueue and observe. Native actors read the fixture, send findings,
ACK processing, and record results. Queue admission does not create an ACK.

Native defaults remain in effect. OpenCode uses its configured Nemotron free
model; Copilot Auto selects `gpt-5.6-luna`; Antigravity uses its configured default.
No model or effort flag is supplied. Copilot uses per-process `--experimental`
and normal, one-time native approvals. No blanket tool approval is enabled.

## Permission and recovery boundaries

Antigravity stream mode refuses native permission requests it cannot display.
Git inspection and a package-source read remain denied. Native file tools and
literal peer coordination provide the supported inspection path. Requests that
need restricted Git evidence can ask Main and wait.

The live run exposes cumulative native denial summaries. Regression tests show
that a new denial pauses unfinished work, while an old denial repeated in a later
successful result does not pause an explicitly recovered investigation again.

The Antigravity Advisor resumes conversation
`41b962c3-948c-4ba5-81a9-dbaf9535e985` in the same durable pair with:

```bash
dotbabel peer launch advisor --pair pair-b3c5a831-7242-47ed-8958-9e04d2265d9b --conversation 41b962c3-948c-4ba5-81a9-dbaf9535e985 --harness antigravity
```

The real emitted init ID matches. The queue, prior findings, private results, and
conversation context survive the process change. Old leases remain invalid.
The interrupted investigation is explicitly cancelled after its bounded retry
history; a separately authorized ownership follow-up completes. It is never
relabelled as a completed interrupted attempt.

Copilot Main creates `main-authority.txt` through its native file tool with a
normal one-time approval. Its content is `PEER-MAIN-AUTHORITY`. Main retains
implementation authority. The inspected `link-account.mjs` retains SHA-256
`2303acde8de9710ef22b58de5ad4c2ce322e515033adcb18165eca9aeb0e7bb2`.

The extra OpenCode idle probe has one accepted delivery attempt and
`unresponsive: true`. No automatic replay or fabricated processing receipt occurs.
All three pairs close with history retained; their actors and relays are no longer
live. The owned native processes are stopped. Other sessions are untouched.

## Automated checks

```bash
npm test -- plugins/dotbabel/tests/peer --coverage --coverage.include='plugins/dotbabel/src/peer/**'
```

The run passes 117 tests across 16 files. Its final coverage output is:

```text
  copilot.mjs      |   90.74 |    84.84 |     100 |   90.38 | 21,41,118,132-133
  opencode.mjs     |   86.73 |    79.36 |   93.33 |    90.9 | ...31,138-140,154
-------------------|---------|----------|---------|---------|-------------------

=============================== Coverage summary ===============================
Statements   : 87.9% ( 1424/1620 )
Branches     : 83.35% ( 1167/1400 )
Functions    : 92.54% ( 236/255 )
Lines        : 90.38% ( 1279/1415 )
================================================================================
```

The PR policy runs with four CPUs to bound test-worker contention:

```bash
taskset -c 0,1,2,3 node plugins/dotbabel/bin/dotbabel.mjs quality check --profile pr --base 10cdb9d35b5a7e5d9a54521fd33fa7f21c9b293a
```

The final ten output lines are:

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

Exit code: `0`. Compilation, lint, tests, changed-line coverage, changed-branch
coverage, and coverage regression checks pass. Metrics marked `not_configured`
remain unmeasured, including complexity, duplication, types, and security scanning.
No policy threshold, native permission policy, or model default is lowered.

Artifact checks also pass:

```bash
node plugins/dotbabel/bin/dotbabel-index.mjs --check
node scripts/build-plugin.mjs --check
npm pack --pack-destination .dotbabel/peer-lab --json
```

The package contains all three native adapter modules and the shared peer skill.
Public project setup loads the generated OpenCode plugin and Antigravity hooks.
The unmodified generated Copilot extension reports `dotbabel-peer (running, project)` in the native `/env` diagnostics after one native hook approval. This final setup smoke uses no model turn.
No release or production deployment is performed.

The first CI runs expose stale skill inventory and generated peer copies. The
checksum, Copilot project instructions, and consumer example are refreshed from
the canonical skill. The focused shell checks then pass:

```bash
npx bats plugins/dotbabel/tests/bats/project-sync-parity.bats plugins/dotbabel/tests/bats/example-parity.bats
```

```text
1..3
ok 1 project-sync-parity: the committed fan-out matches what project-sync would write
ok 2 project-sync-parity: the checker reports a stale generated file, so the gate is not vacuous
ok 3 example-parity: minimal-consumer matches fresh scaffolder output
```

## Limits

Antigravity support uses the managed launcher; attachment to an ordinary existing
Antigravity terminal is not implemented. Copilot requires its native experimental
extension API. OpenCode requires v2. Native queue acceptance never guarantees that
a model processes the message; the stalled additional OpenCode probe demonstrates
why receipt and processing remain separate observations.
