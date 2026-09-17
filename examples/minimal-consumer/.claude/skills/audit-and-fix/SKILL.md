---
id: audit-and-fix
name: audit-and-fix
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [review, debugging]
maturity: validated
description: >
  Run an audit-then-implement pipeline: produce an audit, cluster findings into PR-sized chunks, and spawn parallel subagents to implement fixes as draft PRs.
  Triggers on: "audit and fix", "clean up domain", "overnight cleanup".
argument-hint: "[domain]"
tools: Read, Grep, Glob, Bash
model: opus
---

Run a long-horizon audit-then-implement pipeline: produce a structured audit, cluster findings into PR-sized chunks, and spawn parallel subagents to implement fixes as draft PRs.

Trigger: when the user asks for "audit and fix", wants to clean up a domain, or kicks off an overnight cleanup run. Also triggered directly via `/audit-and-fix <domain>`.

Arguments: `$ARGUMENTS` — the audit domain (e.g. "hardcoded business logic", "unused exports in moneyballer/pkg/db", "deprecated Storage API calls"). Required — if empty, ask the user.

## Steps

1. **Run the audit.** Invoke the `/create-audit` skill. This produces `docs/audits/<topic-slug>-<YYYY-MM-DD>.md` with Findings and Issues tables. Commit the audit file on a new branch `audit/<topic-slug>-<date>` and push.

2. **Cluster findings into PR groups.** Read the audit's Issues table and group findings by:
   - Same file or package → same cluster
   - Same severity AND same fix pattern → same cluster
   - Cross-cutting infra changes (test harness, CI config) → their own cluster

   Produce **4–8 clusters**, not 30 single-finding PRs. Each cluster is one PR. Print the clustering plan as a table before dispatching:

   | Cluster | Findings | Blast Radius | Recommended Title                 |
   | ------- | -------- | ------------ | --------------------------------- |
   | 1       | 3        | low          | "Remove unused exports in pkg/db" |

3. **Initialize the status file.**

   ```markdown
   # Audit-and-Fix Status — <topic> — <YYYY-MM-DD>

   Audit: docs/audits/<topic-slug>-<date>.md

   | Cluster | PR  | Branch | State   | Last Update |
   | ------- | --- | ------ | ------- | ----------- |
   | 1       | —   | —      | pending | <timestamp> |
   ```

   Write to `docs/audits/<topic-slug>-<date>-status.md`.

4. **Dispatch parallel cluster implementers.** Use the `Agent` tool with `subagent_type: "general-purpose"` in a **single message with multiple tool calls** — one agent per cluster, cap at 6 concurrent. Each subagent receives:
   - The audit file path and the specific findings in its cluster
   - Instructions: create a worktree off `main`, implement the fixes, write or update tests, open a **draft** PR with required sections (Summary, Test plan, Spec ID if applicable), wait for CI, address Copilot comments autonomously
   - A strict rule: **never merge.** Leave the PR as draft when done.
   - Required output: `{cluster, pr_url, branch, final_state}` where `final_state ∈ {ready, ci-failing, review-pending, blocked}`

5. **Monitor and update the status file** every 5 minutes while subagents run. For each cluster, record: PR URL, branch, current state, last-update timestamp. If a subagent fails (worktree disappears, CI times out), mark its cluster `blocked` and record the reason rather than retrying silently.

6. **Post the final summary table** when all clusters reach `ready` or `blocked`:

   | Cluster | PR   | State   | Notes                         |
   | ------- | ---- | ------- | ----------------------------- |
   | 1       | #201 | ready   | 0 Copilot comments            |
   | 2       | #202 | blocked | rebase conflict on pkg/foo.go |

   Do not merge. The user decides which PRs to merge (use `/merge-pr` per PR).

## Rules

- Never merge. This command produces draft PRs only.
- Never force-push. Never use destructive git operations in subagents.
- If a worktree path disappears mid-run, recreate it — do not fail the whole run.
- Cap parallelism at 6 concurrent subagents. Batch the rest.
- Every draft PR must include the audit file path in its Summary section so reviewers can trace the finding.
- Keep the status file updated even on failures — silence is worse than partial information.
- If clustering produces more than 8 PRs, STOP and ask the user to narrow the audit scope.
