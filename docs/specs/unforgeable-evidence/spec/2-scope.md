# §2 — Scope

> What is in, what is out, and where are the boundaries?

## In Scope

- **A signed evidence bundle.** One signature for each pull-request head, over the hashes of the payloads of the three run-derived families (attestation, criteria, and review-complete) and of the new trust-root family (§5.3, §5.6, KD-12). The family comments keep their unsigned payload lines.
- **Signer trust from the trust ref.** A namespace-pinned `allowed_signers` file and the `evidence` policy, read with `git show` from the default branch (§5.2). A stacked pull request reads them from the default branch too, never from its feature-branch base.
- **Trust-root change control.** A pull request that changes the signers file or the `evidence` block needs a trust-root payload that a bundle from a current signer names (ARCH-6).
- **Gate verification.** `evaluateAttestation`, `evaluateCriteria`, `evaluateReviewEvidence`, `hasCurrentAttestation`, and the CI `test.yml` classify job use one verifier (ARCH-5).
- **Key custody tiers.** Documented ways to hold the signing key, so that the agent cannot sign without the human: a security key that needs a touch, and a key held by a separate OS user. A declared approval agent is a casual-only tier: the gate cannot check its dialog, and it does not meet the §1 goal (KD-13, §8 A-6). Enforcement on the maintainer's WSL host needs a working tier, or the owner's acceptance on the record of A-6 as casual-only, because the owner does not plan an A-5 security key there (§6, PR-3).
- **Doctor findings.** `dotbabel doctor` checks every signer line, every key in the `ssh-agent`, the dedicated-key rule, and the governance of the CI workflow file (§5.8).
- **Migration.** One `evidence.require_signature.<family>` switch for each family. While a family's switch is off, the gate accepts unsigned and signed evidence. Once it is on, the gate does not skip work on that family's unsigned evidence. A repository that never turns a switch on keeps today's behavior.
- **The guard's new role.** `guard-criteria-evidence.sh` becomes hygiene, not a control. Its read-only false positive (§1) is fixed when it is no longer the only defense.

## Out of Scope

- **Stopping the owner.** The owner holds the trust root and can always sign. See §1, "The goal, stated narrowly".
- **The post-pr-review receipt as a signed fact.** The receipt says "an AI review ran". No independent program can check that an LLM review was honest, so a signature on it only moves the assertion. The receipt stays agent-asserted.
- **Proof that a review ran.** A signed review-complete comment proves that a human was present when it was signed. It does not prove that a review ran, in any tier. A review that never ran posts no finding thread, so the thread check passes with zero findings (`evaluateReviewCompletion`, `plugins/dotbabel/src/review-evidence.mjs:288-303`). The receipt check accepts a receipt for any ancestor of the head (`checkReviewReceipt`, `plugins/dotbabel/src/review-evidence.mjs:244-256`), so one real review of an early commit covers every later head. The agent can also resolve its own finding threads with the owner token. So `evidence.require_signature.review` does not close the review-skip path. Q-2 decides whether it is worth turning on.
- **Honest matrices.** A signature proves that a named signer approved a payload for one head. It does not prove that the matrix is honest. The governance-file hash already covers that (`docs/attestation.md:82-93`), and this spec does not change it.
- **A verifier the agent cannot edit, for every repository.** This spec names where such a verifier exists (Boundaries, below). It does not build a CI job that GitHub loads from the base branch (Q-4).
- **A hosted service.** No dotbabel-operated server, API, or key escrow.
- **Runtime-level sandboxing of the agent.** Claude Code, Codex, and other runtimes own their own sandboxes. This spec works with any runtime and assumes none.
- **New npm dependencies.** Verification shells out to `ssh-keygen` (OpenSSH 8.2 or later), in line with ADR-0002 (zero runtime dependencies).

## Boundaries

- **Only a verifier that the agent cannot edit is an enforcement point.** The local gate (`dotbabel pr-stack gate --gate merge` and `pr-stack entry`) runs as the agent's UID. It runs from an npm-linked checkout the agent can edit, with the agent's `PATH` and the agent's git object store. No workflow runs the merge gate. `/merge-pr` runs it in the agent's session and then runs `gh pr merge` (`commands/merge-pr.md:50,298`). So the human reads the verdict in the agent's transcript. The local gate is the honest path and the first check. It is not an enforcement point against an agent that edits its verifier. ARCH-7 closes only the cheap tampering paths.
- **Where a stronger verifier exists.** The CI classify job runs verifier code and signers from the trust ref (ARCH-8). It is outside the agent's reach for a pull request that does not edit its workflow file. The A-4 signer user is outside the agent's reach on a host where OS separation holds. The required checks on the default branch decide whether a merge can happen without these verifiers, and an admin token can change those checks (§8 R-3).
- **The bundle step signs; it does not decide.** The family writers only post their payloads (KD-12).
- **Trust configuration comes from the trust ref only.** A pull request cannot add its own signer: a head-only signer is unknown (AC-3), a feature-branch base is never read (AC-11), and a change to the trust root needs a current signer's signature (AC-9).
- **The comment channel stays.** The signature makes the author of the comment irrelevant to forgery. The trusted-association and no-edit checks stay as defense in depth.
