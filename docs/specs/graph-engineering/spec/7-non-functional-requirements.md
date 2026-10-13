# §7 — Non-Functional Requirements

> Performance, reliability, operational, security constraints.

<!-- A threshold constraint names its metric, its value, and what happens on breach.
     "Fast", "reliable", "a drift alarm" are adjectives, not constraints.
     An invariant needs no number — "all writes are atomic", "never overwrites a
     user file" are binary and testable exactly as written. Reach for a number
     only where you are promising a threshold.
     A measurement recorded in research/ is not a constraint until it lands here.
     `dotbabel-validate-specs` enforces this: a comparative with no value fails. -->

## Performance

- **PERF-1:** `dotbabel task graph` and `dotbabel task next`, offline, finish in at most 1 second for a clone with 20 worktrees and 200 tasks, measured in the test process after Node startup, as PERF-2 is. A fixture test measures it, and a breach fails the suite. Node startup is excluded because it alone took 0.6 to 0.8 seconds under load (`docs/fleet.md:175-176`). Amended on 2026-10-13.
- **PERF-2:** The queue check adds at most 50 ms to a token command's hook call, after Node startup. The whole call stays inside its 10-second timeout (`docs/fleet.md:82`). Node startup alone took 0.6 to 0.8 seconds at a load average of 42 (`docs/fleet.md:175-176`). A breach fails a test.

## Reliability

- **REL-1:** A model adapter call times out after 5 seconds. Any adapter failure gives the built-in answer, with `fallback: true`. `dotbabel decide` never exits non-zero because of an adapter.
- **REL-2:** A queue reservation expires 10 minutes after the head is reserved, if the head does not retry. The next entry then becomes the head (KD-6).
- **REL-3:** One unreadable task file never fails a graph read. The read names the file and goes on.
- **REL-4:** A version-1 task file and a version-1 run receipt read as version 2.

## Operational

- **OPS-1:** The runtime npm dependencies stay at four (ARCH-2). A test reads `package.json` and fails on a fifth.
- **OPS-2:** `dotbabel doctor` reports the capability states of each adapter, the decider's adapter, the consent, and whether a key is present. It never prints the key.
- **OPS-3:** Every decision is in the run receipt, with its shadow answer when one exists.

## Security

- **SEC-1:** The adapter key never appears in a repository file, the run receipt, an export file, or a log line. A test uses a canary key.
- **SEC-2:** The merge gate never reads a decider answer. A test fails if a gate module imports the decider module.
- **SEC-3:** A model adapter receives only the step's input (§5), and only with the repository's consent (KD-8).
