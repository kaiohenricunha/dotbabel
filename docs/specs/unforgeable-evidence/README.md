# unforgeable-evidence — Engineering Spec

> Make the merge gate believe evidence that an agent cannot produce without the human. Today the gate believes comment text from a trusted author, and an agent that drives `gh` is that author.
>
> Created: 2026-10-12
> Branch: `spec/unforgeable-evidence`
> Worktree: `.claude/worktrees/spec-unforgeable-evidence/`
> Base: `origin/main` @ `73e297f`

## Status

The spec is a **draft**. All acceptance criteria are `planned`, so nothing runs and nothing is gated yet.

| #   | Section                     | Status   |
| --- | --------------------------- | -------- |
| 1   | Problem / Motivation        | [x] done |
| 2   | Scope                       | [x] done |
| 3   | High-Level Architecture     | [x] done |
| 4   | Data Flow / Components      | [x] done |
| 5   | Interfaces and APIs         | [x] done |
| 6   | Implementation Plan         | [x] done |
| 7   | Non-Functional Requirements | [x] done |
| 8   | Risks and Alternatives      | [x] done |

## Quick Start

1. **The problem in one line.** A trusted author association does not tell the gate whether a tool or an agent wrote the comment ([§1](spec/1-problem-motivation.md)).
2. **The decision.** Sign each evidence payload with an SSH key, and verify the signature against signers read from the base ref. Keep the key where the agent cannot use it without a human gesture ([§3](spec/3-high-level-architecture.md)).
3. **Why not the other options.** A GitHub App, a self-hosted runner, a CI re-run, and a separate OS user are scored in [§8](spec/8-risks-alternatives.md).
4. **The plan.** Three pull requests: verify, then custody, then enforce and retire the unsigned marker ([§6](spec/6-implementation-plan.md)).
5. **Constraint IDs (ARCH / KD / REL / SEC / OPS / R / A) are stable references.** Do not renumber them.

## Research Sources

- `docs/hooks.md:29-46` — the evidence guard and its stated scope, including "the durable fix".
- `.claude/hooks/guard-criteria-evidence.sh:7-37` — why the guard exists and what it cannot stop.
- `docs/attestation.md:47-50,82-91` — the base-ref policy and the governance-file hash.
- OpenSSH `ssh-keygen(1)`, the `-Y sign` and `-Y verify` modes with an `allowed_signers` file.
- GitHub REST documentation: check runs can be created only by a GitHub App; commit statuses can be created by any token with the `repo:status` scope.
