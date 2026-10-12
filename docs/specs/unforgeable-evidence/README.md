# unforgeable-evidence — Engineering Spec

> Make the merge gate believe evidence that an agent cannot produce without the human. Today the gate believes comment text from a trusted author, and an agent that drives `gh` is that author.
>
> Created: 2026-10-12
> Branch: `spec/unforgeable-evidence`
> Worktree: `.claude/worktrees/spec-unforgeable-evidence/`
> Base: `origin/main` @ `a22b813`

## Status

The spec is a **draft**. All acceptance criteria are `planned`, so nothing runs and nothing is gated yet. Revised once after a four-reviewer pass (architecture, security, compliance, documentation).

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
2. **The decision.** Sign each evidence payload with a dedicated SSH key. Verify the signature against namespace-pinned signers read from the default branch, and refuse a security-key signature without the user-presence flag. Put any change to the signers or the policy under a signature from a current signer ([§3](spec/3-high-level-architecture.md), [§5](spec/5-interfaces-apis.md)).
3. **The limits.** A touch proves presence, not approval of the bytes. A signed review-complete comment does not prove that a review ran. The local gate runs as the agent, so it is not an enforcement point ([§2](spec/2-scope.md), [§8](spec/8-risks-alternatives.md)).
4. **Why not the other options.** A GitHub App, a self-hosted runner, a CI re-run, and a separate OS user are scored in [§8](spec/8-risks-alternatives.md).
5. **The plan.** Three phases: verify, then custody, then enforce for each family where the switch is on. Phase 3 starts only when a custody tier works on the maintainer's WSL host ([§6](spec/6-implementation-plan.md)).
6. **Stable IDs.** ARCH, KD, REL, SEC, PERF, OPS, R, A, S, Q, E, and AC are stable references. Do not renumber them; add new IDs at the end of their family.

## Research Sources

- `docs/hooks.md:33-50` — the evidence guard and its stated scope, including "the durable fix" at `:48-50`.
- `.claude/hooks/guard-criteria-evidence.sh:7-37` — why the guard exists and what it cannot stop.
- `docs/attestation.md:47-50,82-93` — the base-ref policy and the governance-file hash.
- `plugins/dotbabel/src/attestation-gate-inputs.mjs:22,75-154` — the base-ref gather, the governed-file list, and the `deps.run` seam.
- `plugins/dotbabel/src/pr-gates.mjs:422-553,583-964` — the merge gate, `attestationStatus`, and the two evidence ladders.
- OpenSSH `ssh-keygen(1)`: the `-Y sign`, `-Y verify`, and `-Y find-principals` modes with an `allowed_signers` file, and `PROTOCOL.u2f` for the security-key signature flags.
- GitHub REST documentation: only a GitHub App can create check runs; any token with the `repo:status` scope can create commit statuses.
