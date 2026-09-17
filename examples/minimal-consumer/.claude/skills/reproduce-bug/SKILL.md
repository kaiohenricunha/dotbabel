---
id: reproduce-bug
name: reproduce-bug
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [debugging, testing]
maturity: validated
description: >
  Reproduce a bug in an isolated, production-mirroring sandbox and capture a
  failing regression test as the objective baseline to fix against. Saves a
  report to docs/reproductions/.
  Triggers on: "reproduce this bug", "can't reproduce", "make it fail reliably", "repro".
argument-hint: "[bug or symptom]"
tools: Read, Grep, Glob, Bash, Write, Edit
model: sonnet
---

Reproduce a bug under isolation and the exact conditions that trigger it, then capture a **failing regression test** as the objective baseline to fix against. The output is a dated report under `docs/reproductions/` plus a failing test left in the sandbox.

Trigger: when the user says "reproduce this bug", "I can't reproduce X", "make it fail reliably", "repro Y", or invokes `/reproduce-bug` directly. Use it **after** a bug is reported (or surfaced by `/create-audit`) and **before** `/fix-with-evidence` writes the patch.

Arguments: `$ARGUMENTS` — a bug or symptom (e.g. "checkout 500s when cart has >50 items", "intermittent panic in the scheduler", issue link/number). If empty, ask the user what to reproduce.

## Purpose

`/reproduce-bug` is **not** a fix (it ships no patch — that is `/fix-with-evidence`), **not** an audit (it doesn't enumerate issues — that is `/create-audit`), and **not** a flaky-test diagnosis of an existing suite (that is `/detect-flaky`). It is the **bridge** between a bug report and a fix: gather the evidence, isolate a prod-mirroring environment, and produce a deterministically failing test.

The deliverable is a reproduction other skills build on. `/fix-with-evidence` consumes the failing test directly — it **satisfies that skill's Phase-1 Reproduce gate**, so the fix loop can start at Phase 2.

## Steps

### Step 0 — Gather the failure evidence (interactive, blocking)

Collect the trigger conditions, echo them back, and **wait for sign-off** before touching anything. Skip what is already in `$ARGUMENTS` or recent context. If `$ARGUMENTS` is empty, ask what to reproduce.

1. **Stack trace / error** — the full message and the top frames. For a GitHub issue: `gh issue view <N>`.
2. **Inputs** — the exact user inputs, API payloads, CLI args, or dataset/user-state that triggered the failure.
3. **Environment** — OS, runtime/language version, framework, and DB/browser versions; the relevant env vars (redact secrets).
4. **Logs & traces** — for web or distributed systems, the application logs / telemetry that trace the execution path **before** the error was thrown.

Echo back the consolidated evidence **and the precise failure condition you will target**. Wait for explicit user sign-off before continuing to Step 1.

### Step 1 — Locate the code path

Use `Grep` + `Read` to find the throwing path and the code that consumes the Step-0 inputs. Cite `file:line` for every claim. **Do not edit anything yet** — this is baseline-only; root cause is recorded later as candidates, not patched here.

### Step 2 — Build the isolated, prod-mirroring sandbox

Isolate the reproduction so nothing touches the main checkout, then mirror production along every axis the bug depends on.

- **Sandbox:** `git fetch origin main` then `git worktree add .claude/worktrees/repro-<slug> -b repro/<slug> origin/main`. Fallback: `~/repro/<slug>/` if there is no enclosing git repo.
- **Pin versions:** match the runtime/language, framework, and DB/browser versions from Step 0 (`nvm`/`asdf`/`pyenv`, the committed lockfile, pinned container tags).
- **Replay data:** load the exact dataset, user state, or recorded API payloads from Step 0 (fixtures, seed scripts, captured requests). State-dependent bugs do not reproduce without their state.
- **Env vars:** export the captured variables (redact secrets in the report).
- **Services:** stand up state-dependent dependencies (`docker compose up -d` for DB / cache / queue) when the bug needs them.

Capture **every** command as a reproducibility ledger. Redact tokens and credentials before any output enters the report.

### Step 3 — Reproduce & isolate edge cases

Run the offending path with the Step-0 inputs and confirm the same failure. If it does not fail every time, force consistency:

- **Concurrency / race conditions:** loop the trigger to make an intermittent bug reliable, and record the rate. Add logging around shared state to expose thread-blocking or ordering, and use the language's race detector where available (e.g. `go test -race`).

  ```bash
  for i in $(seq 1 1000); do <trigger-command> || echo "FAIL run $i"; done | tee repro-loop.log
  ```

- **Network & timing:** simulate throttled connections or added latency (`tc`/`netem`, a throttling proxy, or injected delays) to surface timing-dependent races that only appear under real network conditions.
- **Boundary with `/detect-flaky`:** that skill diagnoses non-determinism in an **existing** test suite; this skill reproduces a **new** bug. If the investigation turns into "why is this existing test flaky", hand off to `/detect-flaky`.

### Step 4 — Write the failing regression test

- Detect the runner — `Makefile` → `make test`; `package.json` → `npm`/`pnpm`/`yarn` test; `go.mod` → `go test ./...`; `pyproject.toml` → `pytest`.
- Write the **minimal** test that triggers the bug, in the appropriate test file **inside the sandbox**. Assert the **correct** expected behavior so the test fails now and will pass once the bug is fixed.
- Run it and **paste the actual failure output** — this red result is the objective baseline.

**Gate:** you must have a deterministically failing test, **or** a documented reproduction rate for an intermittent bug (e.g. "fails 7/1000 runs"). If you cannot make it fail, STOP — report the evidence gathered and exactly what is still missing. Do not write the report as if the bug were reproduced.

### Step 5 — Write the report

Generate a filename `<topic-slug>-<YYYY-MM-DD>.md` in lowercase kebab-case (e.g. `checkout-500-large-cart-2026-06-14.md`). Create `docs/reproductions/` if it doesn't exist. Use this structure:

````markdown
# Bug Reproduction: <Title> — <YYYY-MM-DD>

<One-line symptom.>

## Symptom

- **Observed:** <what happens>
- **Expected:** <what should happen>

## Evidence Gathered

Stack trace:

```text
<top frames>
```

| Aspect                   | Value                         |
| ------------------------ | ----------------------------- |
| Inputs / payload         | <exact trigger>               |
| Env vars (redacted)      | <KEY=…>                       |
| OS / runtime             | <e.g. Ubuntu 22.04 / Node 20> |
| Framework / DB / browser | <versions>                    |

Logs / traces: <pointer or snippet of the path before the throw>

## Code Path

- `<file:line>` — <role in the failure>

## Isolated Environment

Sandbox: `<absolute path>`

```bash
<exact setup commands: worktree, version pins, seed/replay, env exports, docker compose>
```

Version pins: `<runtime>`, `<framework>`, `<db/browser>`

## Reproduction

```bash
<commands that trigger the failure>
```

Failure rate: `<deterministic | N/M runs>` (intermittent only)

## Failing Test

Path: `<test file>`

```<lang>
<the failing test>
```

Red baseline:

```text
<pasted failure output>
```

## Suspected Root Cause

Candidates (**not** fixed here):

- <hypothesis> — for: <evidence> / against: <evidence>

## Next Step

- `/fix-with-evidence <bug>` — the failing test above satisfies its Phase-1 Reproduce gate, OR
- `/create-experiment <fix idea>` — compare candidate fixes against this red baseline, OR
- `/create-audit <area>` — if the bug looks systemic.

## Sandbox Cleanup

```bash
git worktree remove .claude/worktrees/repro-<slug>   # or  rm -rf ~/repro/<slug>
```
````

### Step 6 — Report back

Reply with: the doc path, a one-line repro summary (include the failure rate if intermittent), the sandbox path, and the failing-test path. **Do not paste the full document into chat.** Point the user to the Next Step.

## Rules

- All work runs **locally**. No production endpoints, no real credentials, no shared infrastructure. Mock external services or use disposable test accounts.
- Capture every setup and reproduction command in the report — reproducibility is the bar.
- Redact tokens, keys, and PII before anything enters the doc.
- **Do not fix the bug.** This skill stops at the red baseline; the patch is `/fix-with-evidence`'s job.
- The bar is a deterministically failing test, or a documented failure rate for intermittent bugs. "Probably this" without a failing run is not a reproduction.
- Leave the doc, the test, and the sandbox untracked for the user.
- Tables and code blocks over prose. No filler.
