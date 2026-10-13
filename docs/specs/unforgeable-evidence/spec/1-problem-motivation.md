# §1 — Problem / Motivation

**PARKED (owner decision, 2026-10-12).** dotbabel does not implement this spec. It stays as an opt-in, default-off design record (§6 Status).

> What is broken, who does it hurt, and what is the threat?

## The problem

The merge gate decides whether a pull request may skip work because of evidence comments. Three families of evidence exist, plus one receipt that a writer reads. Each one is a hidden first-line marker, and each evidence family adds a JSON payload on line 2. The local-attest and review-complete families encode it as base64url through one codec (`encodePayloadLine` and `decodePayloadLine`, `plugins/dotbabel/src/lib/evidence-payload.mjs:30-31,54-64`). The criteria family never used that codec. Its writer raw-deflates the JSON before base64url, the `z1:` form (`plugins/dotbabel/src/criteria/comment.mjs:73-81`). Its reader also accepts the plain base64url form that older versions posted (`plugins/dotbabel/src/criteria/evidence.mjs:67-82`).

The gate believes a comment when two facts hold:

1. The author association is in the trusted list. The default is `["OWNER"]` (`plugins/dotbabel/src/lib/attest-marker.mjs:60`, `plugins/dotbabel/src/attestation-gate-inputs.mjs:144-146`).
2. The comment was never edited (`evaluateAttestation` and `evaluateCriteria`, `plugins/dotbabel/src/pr-gates.mjs:663-665,903-905`; `plugins/dotbabel/src/review-evidence.mjs:185,239-241`).

Neither fact says which program wrote the bytes. An agent that drives `gh` with the owner's token **is** the owner to GitHub. `docs/hooks.md:33-36` states this directly: "An agent driving `gh` **is** a trusted author, and the gate cannot tell a marker the tool derived from a real criteria run from one an agent typed — the bytes are identical." The hook header repeats it (`.claude/hooks/guard-criteria-evidence.sh:7-12`).

The payload is JSON in base64url, with no signature and no secret. Anyone who can post a comment as the owner can write a valid payload by hand.

## What a forgery costs

A forged evidence comment does not misreport verification. It removes verification. The first three rows are the evidence families that this spec signs. The fourth row is the receipt, which stays agent-asserted (§2).

| Kind                       | Sanctioned writer                                                                                              | Reader                                                                                                                                                                                                     | Effect of a forgery                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attestation (evidence)     | `dotbabel local-attest --pr <N>` (`postAttestComment`, `plugins/dotbabel/src/local-attest-runner.mjs:820-860`) | merge gate `evaluateAttestation` (`plugins/dotbabel/src/pr-gates.mjs:602`); CI classify job (`.github/workflows/test.yml:39-47`); `hasCurrentAttestation` (`plugins/dotbabel/src/attestation.mjs:272-285`) | `/merge-pr` skips the test suite and the quality profile (`docs/attestation.md:63`), and CI skips the remote test job (`.github/workflows/test.yml:52`). |
| Criteria (evidence)        | `dotbabel criteria verify --pr <N> --post` (`plugins/dotbabel/src/criteria/comment.mjs:67-69,146`)             | merge gate `evaluateCriteria` (`plugins/dotbabel/src/pr-gates.mjs:793`) through `plugins/dotbabel/src/criteria/gate-inputs.mjs:44,389-391`                                                                 | A failing acceptance criterion reads as passing.                                                                                                         |
| Review-complete (evidence) | `dotbabel pr-stack review-complete --pr <N>` (`plugins/dotbabel/src/review-complete.mjs:60,123`)               | `evaluateReviewEvidence` (`plugins/dotbabel/src/review-evidence.mjs:171-206`); `pr-stack entry` through `reviewEntryFacts` (`plugins/dotbabel/src/review-gate-inputs.mjs:154-162`)                         | `/pr-conductor` skips phases 1 to 4 on a review nobody did.                                                                                              |
| Review receipt             | `plugins/dotbabel/scripts/post-pr-review-post-receipt.sh` (`:9-22`)                                            | `checkReviewReceipt` (`plugins/dotbabel/src/review-evidence.mjs:229-263`)                                                                                                                                  | The review-complete writer believes a review ran, so it launders a forged run through the honest command.                                                |

The guard comment ranks the attestation family as the worst case: "the merge gate skips the full test suite AND the quality profile on it, so a forged one removes verification rather than misreporting it" (`.claude/hooks/guard-criteria-evidence.sh:47-60`).

## Why the current guard is not enough

`guard-criteria-evidence.sh` is a `PreToolUse` hook on `Bash`. It refuses a command whose text, or whose readable `--body-file`, carries a marker (`.claude/hooks/guard-criteria-evidence.sh:61-69,141-163`). The docs state its limit (`docs/hooks.md:41-50`): it does **not** stop a marker assembled out of band — shell variables, base64, a heredoc, a body written with the Write tool, or `--body-file -` from stdin (`.claude/hooks/guard-criteria-evidence.sh:148`). "No textual guard on a single Bash call can close them."

The guard has a cost too. It also blocks read-only commands. On 2026-10-12, while this spec was written, a `grep` for the receipt marker literal was refused with the same "writes a dotbabel evidence marker by hand" message. A guard that blocks reads trains agents to search around it.

`docs/hooks.md:48-50` already names the durable fix: "for the gate to stop trusting comment text — an unforgeable value derived from the run, or a check-run artifact the agent cannot author." This spec designs that fix.

## Threat model

**Actor.** An AI agent session (Claude Code, Codex, Copilot CLI, or another runtime) that runs as the human's OS user.

**What the actor has.**

- The human's shell, with the same UID and groups.
- The human's `gh` token. On a personal repository this token has admin permission, which maps to `OWNER` (`plugins/dotbabel/src/lib/perm-to-assoc.mjs:9-15`).
- Read and write access to every file the human can read and write, including `~/.ssh`, `~/.config`, environment variables, the git object store, and the npm-linked dotbabel checkout.
- The ability to run any program, including Windows programs through WSL interop on a WSL host.

**What the actor wants.** A merge gate verdict of `verified` (or a skipped review stage) for a head SHA whose matrix, criteria, or review did not pass or did not run. The motive is not malice. The usual motive is a loop that wants to finish: a model that has failed a gate several times and finds the evidence comment easier to produce than the evidence.

**Why the simple fixes fail.**

- **A signing key or an HMAC secret in a user-scope file.** The actor reads the file and signs whatever it wants. A secret that the agent's UID can read proves only that the agent's UID signed.
- **A secret in an environment variable.** The actor inherits the environment. The guard's bypass variable is safe only because the hook reads Claude Code's own environment, and the actor cannot change it for each call (`docs/hooks.md:64-75`). The actor can still read a secret from that environment.
- **A better text guard.** Every guard on one tool call can be split across two calls (`docs/hooks.md:41-47`).
- **A stronger author check.** GitHub cannot tell the human from a program that holds the human's token.

**The goal, stated narrowly.** The agent must not be able to produce evidence that the gate believes **without the human**. A human who wants to forge evidence can always forge it, because the human owns the trust root. This spec does not try to stop the owner. The goal is about believed evidence. Where the verdict is enforced, and which verifier the human can trust, is in §2 Boundaries.

## Who it hurts

- The maintainer, who reads `verified` and does not run the suite again. That verdict comes from a gate that runs in the agent's session (§2 Boundaries).
- Consumers of `@dotbabel/dotbabel`, who adopt `attestation.enforce` because the docs describe it as a verification shortcut (`docs/attestation.md:1-14`), and who have the same agent-as-owner exposure.
