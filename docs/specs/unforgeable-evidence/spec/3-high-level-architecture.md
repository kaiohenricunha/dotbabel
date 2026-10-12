# §3 — High-Level Architecture

> The shape of the fix, and the decisions that fix its shape.

## Overview

```text
 writer (local-attest | criteria verify --post | pr-stack review-complete)
   │ 1. build payload (as today) + scope {repo, pr, family}
   │ 2. encode line 2 (as today)
   │ 3. ssh-keygen -Y sign -n dotbabel-evidence@v1 over the line-2 bytes
   │      key custody: security key (touch)  or  separate-user signer
   ▼
 PR comment:  line 1 marker   line 2 payload   line 3 signature
   │
   ▼
 gate (merge gate | pr-stack entry | CI test.yml classify)
   │ a. policy and allowed_signers from the BASE ref (git show)
   │ b. ssh-keygen -Y verify against allowed_signers, namespace pinned
   │ c. payload scope == this repo, this PR, this head, this family
   │ d. existing ladder: trusted author, no edit, current, complete
   ▼
 verified | blocked with a reason code
```

The signature replaces "who posted the comment" as the fact that makes evidence believable. The comment stays the transport, so no new GitHub surface is needed.

## Constraints

- **ARCH-1.** The gate reads the signature policy and the `allowed_signers` file from the base ref only, with `git show`, as it reads the attestation policy today (`plugins/dotbabel/src/attestation-gate-inputs.mjs:12-15`).
- **ARCH-2.** Verification is a decision over three inputs: the line-2 bytes, the line-3 signature, and the base-ref `allowed_signers` text. `ssh-keygen` runs behind the existing `deps.run` seam, so every branch is testable without a key or a network (`plugins/dotbabel/src/attestation-gate-inputs.mjs:22`).
- **ARCH-3.** For each family, unsigned evidence is accepted if and only if the base ref does not require a signature for that family.
- **ARCH-4.** The trusted-association and no-edit checks stay (`plugins/dotbabel/src/pr-gates.mjs:536-538,776-778`). A signature is an extra fact, never a replacement for an existing refusal.
- **ARCH-5.** Every gate that reads a family reads it the same way. The merge gate, `pr-stack entry`, and the CI classify job share the verifier. Today the CI job does not check edits (`.github/workflows/test.yml:39-47`); after this spec it verifies the signature instead.

## Key decisions

- **KD-1 — SSH signatures, not a GitHub App.** `ssh-keygen -Y sign` and `-Y verify` ship with OpenSSH 8.1 and later, on every GitHub-hosted runner and on the maintainer's machine (OpenSSH 9.6p1, checked 2026-10-12). No npm dependency (ADR-0002), no registered App, no hosted service. A GitHub App moves the problem to "where is the App's private key", which is the same custody problem (§8, A-1).
- **KD-2 — Sign the line-2 bytes verbatim.** The signed message is the exact UTF-8 text of the payload line. No canonical-JSON step can disagree between writer and verifier.
- **KD-3 — Scope inside the payload.** The payload names `repo`, `pr`, `head_sha`, and `family`. The verifier compares each one to the pull request it judges, so a valid signature cannot be replayed onto another repository, pull request, head, or family.
- **KD-4 — The namespace is pinned.** Signatures use namespace `dotbabel-evidence@v1`, and each `allowed_signers` line carries `namespaces="dotbabel-evidence@v1"`. A git commit-signing key in the same file cannot vouch for evidence, and an evidence key cannot vouch for a commit.
- **KD-5 — Human presence is the default custody.** The default key is a FIDO2 security key (`ssh-keygen -t ed25519-sk`), which needs a physical touch for each signature. The agent can prepare a payload, but it cannot complete the signature. This meets the goal in §1 exactly: the agent cannot produce believed evidence **without the human**. A touch proves presence, not honesty of the run, and §8 R-1 names that limit.
- **KD-6 — A separate-user signer is the optional stronger tier.** A signer that runs as another OS user fetches the head SHA from the remote, runs the governed matrix itself, and signs with a key the human's UID cannot read. It proves both who signed and that a real run happened. It costs the most setup, and on WSL it is weaker (§8 R-2).
- **KD-7 — One switch per family, attestation first.** `require_signature` is set per family. Attestation flips first, because its forgery removes verification (`.claude/hooks/guard-criteria-evidence.sh:47-61`).
- **KD-8 — The text guard becomes hygiene.** When the gate stops believing unsigned text, `guard-criteria-evidence.sh` no longer carries the security claim. It keeps catching the casual path, and its read-only false positive (§1) is fixed by matching only commands that post.

## What this design does not change

- The governance-file hash and the `explicit` state (`docs/attestation.md:82-91`). A signer approves a payload; the hash still decides whether the matrix in that payload was the base's matrix.
- The post-pr-review receipt. It stays agent-asserted (§2, Out of Scope).
