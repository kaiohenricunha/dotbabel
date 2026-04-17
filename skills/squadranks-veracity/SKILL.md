---
name: squadranks-veracity
description: >
  Audit a ranking pipeline for Veracity and Value. Dispatches
  squadranks-data-scientist, squadranks-compliance-auditor, and data-engineer
  agents with project-specific context injected. Defaults target the
  wc-squad-rankings layout; all paths are overridable via flags.
  Subcommands: audit (full pipeline walk), score-check (scoring math only),
  gate-check (gate coverage only), source-trace <source> (single source end-to-end).
  Invoke when: "audit pipeline", "veracity check", "scoring math correct?",
  "check gates", "trace source", "verify quality gates", "ASR correct?".
argument-hint: "audit | score-check | gate-check | source-trace <source> [--config <path>] [--quality-config <path>] [--pipeline-dir <path>] [--rating-dir <path>]"
effort: max
model: opus
tools: Read, Grep, Glob, Bash
---

# SquadRanks Veracity Auditor

Orchestrating audit skill for ranking pipelines. Dispatches specialized sub-agents
with injected project context. Produces inline audit findings; optional `--save`
writes to `docs/audits/`.

**Covers two concerns:**
- **Veracity** — source reliability, scoring math integrity, quality gate completeness
- **Value** — primary-score vs. legacy-composite correctness, blend-config wiring

---

## Arguments

All flags are optional. Defaults target the wc-squad-rankings layout.

| Flag | Default | Purpose |
|---|---|---|
| `--config <path>` | `api/config/rating.yaml` | Scoring config (alpha tiers, caps, weights) |
| `--quality-config <path>` | `api/config/data_quality.yaml` | Gate declarations |
| `--pipeline-dir <path>` | `api/internal/pipeline/` | Pipeline step source files |
| `--rating-dir <path>` | `api/internal/rating/` | Rating math source files |
| `--project-root <path>` | cwd | Project root when invoking from outside the repo |
| `--save` | off | Write findings to `docs/audits/veracity-<YYYY-MM-DD>.md` |
| `--since <spec>` | — | `gate-check` only: focus on checks added within this window (e.g. `"30 days ago"`) |

---

## Pre-flight (always runs first)

1. Resolve all paths: prepend `--project-root` to any relative path argument (or use cwd).

2. Verify the three required agents are installed:
   ```
   ~/.claude/agents/data-engineer.md
   ~/.claude/agents/squadranks-data-scientist.md
   ~/.claude/agents/squadranks-compliance-auditor.md
   ```
   If any are missing, halt:
   ```
   Missing agent(s): <list>
   Run: dotclaude bootstrap
   Then re-invoke this skill.
   ```

3. Confirm `--config` path resolves to a readable file. If not found, halt:
   ```
   Config not found: <path>
   Pass --config <path> to override the default location.
   ```

---

## Subcommand: `audit` (default — no args)

Full pipeline walk. Dispatches three agents in parallel, then synthesizes.

### Step 1 — Read shared context

Read both config files in full and retain their content to inject as a preamble into every agent prompt:
- `<--config>` (scoring constants: alpha tiers, NT cap, minutes trust, squad/bench weights)
- `<--quality-config>` (gate declarations: named checks, thresholds, blocking flags)

### Step 2 — Dispatch three agents in parallel

**Agent A — data-engineer**

```
Task: Audit source reliability across all pipeline steps.
Scope: <--pipeline-dir> (all step*.go files), provider/ or service/ directories nearby
Preamble: [inject both config file contents]
Checks:
  - Squad/roster ingestion step: how are missing/null player IDs handled? What on HTTP 429/503?
  - Match history step: is the rolling-window cutoff calendar or epoch-based? Any timezone assumptions?
  - For each external source: schema version check present? Fallback when source unavailable? IDs validated before use?
  - Placeholder/fallback cases: when does the last-resort case trigger silently vs. with a logged warning?
Output: P0/P1/P2 findings table per source with file:line.
  P0 = data loss/corruption, P1 = reliability gap, P2 = efficiency improvement.
Constraints: read-only
```

**Agent B — squadranks-data-scientist**

```
Task: Validate scoring math integrity.
Scope: <--rating-dir> (rating.go, gate.go), <--pipeline-dir> (transform and scoring step files)
Preamble: [inject --config file content in full]
Checks:
  - Alpha/tier selection function: tier boundaries match config exactly — check strict vs. loose comparisons at edges.
  - Power-law adjustment function: formula matches declared intent.
  - Credibility-weighting function (e.g. √-minutes): confirm formula, trust horizon, and [0,1] clamp.
  - Multi-source cap (e.g. NT 25%): confirm it is applied AFTER tier adjustment (order matters for range correctness); cite the line.
  - Fallback case chain: for each case, state trigger condition + rating produced + whether output is bounded to a sane range. Flag any case that can produce an out-of-range rating.
  - Empty-collection edge case in aggregation step (e.g. empty bench): division-by-zero risk?
  - Primary score vs. legacy composite: does any export path still apply a scale conversion (e.g. ×10 or /10) from the old composite range? Grep for scale conversions in service, export, and handler files.
Output: math integrity table (Formula | Expected | Code Behavior | Verdict | File:Line).
  Verdict: PASS / FAIL / AMBIGUOUS. FAIL entries include a one-line recommended fix.
Constraints: read-only
```

**Agent C — squadranks-compliance-auditor**

```
Task: Gate completeness — coverage matrix of <--quality-config> declarations vs. enforcement code.
Scope: <--quality-config>, <--pipeline-dir> (gate step), <--rating-dir> (gate.go)
Preamble: [inject both config file contents]
Checks:
  - Build coverage matrix for all named checks in quality config.
  - Flag DECLARED-NOT-ENFORCED (CRITICAL) and ENFORCED-NOT-DECLARED (WARNING).
  - Per-entity gate function: verify it is called for every entity in every run (trace call site in pipeline gate step, not just in isolation).
  - Verify gate outcome (pass/fail, reason) is persisted to a durable store for every run.
  - Threshold mismatch: compare threshold values between quality config and any hardcoded literals in the gate step.
  - Recent additions: flag any check added to quality config that lacks a corresponding test in the gate test file.
Output: coverage matrix (Check | Declared | Enforced | Blocking | Threshold Match | Test | File:Line)
  + gap list (Severity | Gap Type | Check Name | Detail | File:Line).
Constraints: read-only
```

### Step 3 — Synthesize

After all three agents return:
1. Deduplicate findings that share the same `file:line`.
2. Assign the highest severity from any agent that flagged the same location.
3. Output:

```
## Source Reliability
[data-engineer P0/P1/P2 table]

## Scoring Math
[squadranks-data-scientist PASS/FAIL/AMBIGUOUS table]

## Gate Coverage
[squadranks-compliance-auditor coverage matrix + gap list]

## Summary
N CRITICAL · N WARNING · N INFO
Top action: <one sentence — the highest-severity finding's recommended fix>
```

If `--save` was passed, write this output to `docs/audits/veracity-<YYYY-MM-DD>.md` (relative to project root). Create the directory if it doesn't exist.

---

## Subcommand: `score-check`

Dispatch `squadranks-data-scientist` only. Use after any change to `--config` or the transform step.

1. Read `<--config>` in full.
2. Dispatch Agent B above with the config content injected.
3. Output the math integrity table directly — no synthesis.

---

## Subcommand: `gate-check`

Dispatch `squadranks-compliance-auditor` only. Use after any change to `--quality-config`.

1. Read `<--quality-config>` and the pipeline gate step file in full.
2. If `--since` is present (e.g. `--since="30 days ago"`):
   - Run: `git log --since="<value>" --oneline -- <--quality-config>`
   - Extract check names added in recent commits.
   - Prepend to agent prompt: "Focus on these recently added checks: <list>. Verify each has enforcement in the gate step AND a test in its test file."
3. Dispatch Agent C above.
4. Output the coverage matrix and gap list directly — no synthesis.

---

## Subcommand: `source-trace <source>`

Dispatch `data-engineer` with single-source scope.

1. Require one positional argument naming the source to trace. If not provided, print available sources by grepping `<--pipeline-dir>` for provider import names, then halt.

2. Build a targeted file list:
   - Use `Grep` to find all files in `<--pipeline-dir>` and nearby provider/service directories that reference the source name.
   - Include the scoring config (`<--config>`) for context on how this source's data affects the final score.

3. Dispatch:
   ```
   Task: Trace <source> data end-to-end through the pipeline.
   Scope: [targeted file list]
   For each file:
     (a) Where does this source's data enter?
     (b) What schema fields are consumed?
     (c) What happens when the source returns stale, null, or out-of-schema data?
     (d) Is the source ID space validated against a reference set before use?
     (e) What is the downstream scoring impact if this source fails silently?
   Output: Stage | File:Line | Fields consumed | Failure mode | Mitigation (Y/N).
   Constraints: read-only
   ```

---

## Key Principles

1. **Audit, don't fix.** Findings only. Log bugs with severity and `file:line`; let the user decide what to act on.
2. **Inject context, don't assume.** Always read and inject `--config` (and `--quality-config` where relevant) into agent prompts so agents share a consistent source of truth without re-reading independently.
3. **Parallel where independent.** `audit` runs three agents concurrently because the three concern domains (source, math, gates) are fully independent. The other subcommands are single-agent by design.
4. **Evidence before verdict.** Every FAIL/CRITICAL must cite `file:line`. AMBIGUOUS is a valid verdict when the code path is conditional — do not guess.
5. **Defaults work for wc-squad-rankings.** Override any path with the corresponding flag if the project layout differs.
