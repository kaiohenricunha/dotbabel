# §2 — Scope

> What is in, what is out, and where are the boundaries?

## In Scope

- **A signed evidence payload.** One signature format for the three run-derived families: attestation, criteria, and review-complete.
- **Signer trust from the base ref.** An `allowed_signers` file, read with `git show` from the base ref, as the attestation policy is today (`docs/attestation.md:49-50`).
- **Gate verification.** `evaluateAttestation`, `evaluateCriteria`, `evaluateReviewEvidence`, and the CI `test.yml` classify job verify the signature when the base ref requires it.
- **Key custody tiers.** Documented ways to hold the signing key so that the agent cannot sign without the human: a security key that needs a touch, and a key held by a separate OS user.
- **Doctor findings.** `dotbabel doctor` reports a signing key that the current UID can read and use without a human gesture.
- **Migration.** A `require_signature` switch per family. Unsigned and signed evidence are both accepted until the switch is on; then the unsigned marker is retired.
- **The guard's new role.** `guard-criteria-evidence.sh` becomes hygiene, not a control. Its read-only false positive (§1) is fixed when it is no longer the only defense.

## Out of Scope

- **Stopping the owner.** The owner holds the trust root and can always sign. See §1, "The goal, stated narrowly".
- **The post-pr-review receipt as a signed fact.** The receipt says "an AI review ran". No independent program can check that an LLM review was honest, so a signature on it only moves the assertion. The receipt stays agent-asserted. Its effect is limited because the review-complete writer also checks threads and criteria on GitHub (`plugins/dotbabel/src/review-evidence.mjs:279-285`), and those checks are signed with the review-complete payload.
- **Honest matrices.** A signature proves that a named signer approved a payload for one head. It does not prove that the matrix is honest. The governance-file hash already covers that (`docs/attestation.md:82-91`), and this spec does not change it.
- **A hosted service.** No dotbabel-operated server, API, or key escrow.
- **Runtime-level sandboxing of the agent.** Claude Code, Codex, and other runtimes own their own sandboxes. This spec works with any runtime and assumes none.
- **New npm dependencies.** Verification shells out to `ssh-keygen` (OpenSSH 8.1 or later), in line with ADR-0002 (zero runtime dependencies).

## Boundaries

- The gate is the only enforcement point. The writers sign; they do not decide.
- Trust configuration is read from the base ref only. A pull request cannot add its own signer.
- The comment channel stays. The signature makes the author of the comment irrelevant to forgery, but the trusted-association and no-edit checks stay as defense in depth.
