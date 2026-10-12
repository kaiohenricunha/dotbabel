# §4 — Data Flow / Components

> Which modules change, and how a signature travels from writer to gate.

## Components

| Component                                     | Today                                                                         | After this spec                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/lib/evidence-signature.mjs` (new)        | —                                                                             | `signPayloadLine`, `verifyEvidenceSignature`, `parseSignatureLine`. All `ssh-keygen` calls go through `deps.run`. |
| `src/lib/evidence-payload.mjs`                | Encodes and decodes line 2 (`:25-26,49-59`).                                  | Unchanged format. A helper returns the raw line-2 text, which is the signed message (KD-2).                       |
| `src/lib/attest-marker.mjs`                   | Trusts a first-line marker from a trusted association (`:50-68`).             | Unchanged. It stays the locator and the first rung of the ladder (ARCH-4).                                        |
| `src/attestation.mjs`                         | Builds the payload (`:140`) and renders lines 1-2 (`:165-166`).               | Adds the scope fields (KD-3) and an optional line 3.                                                              |
| `src/local-attest-runner.mjs`                 | Posts and minimizes (`:798-834`).                                             | Signs before posting when a key is configured. Refuses to post unsigned when the base requires a signature.       |
| `src/criteria/comment.mjs`                    | Renders and posts criteria evidence (`:67-69,146`).                           | Same signing step.                                                                                                |
| `src/review-complete.mjs`                     | Posts the review-complete comment (`:123`).                                   | Same signing step.                                                                                                |
| `src/attestation-gate-inputs.mjs`             | Reads policy, governed files, and merge base from the base ref (`:75-154`).   | Also reads `evidence.require_signature` and the `allowed_signers` file from the base ref.                         |
| `src/criteria/gate-inputs.mjs`                | Fetches comments with `authorAssociation` and `lastEditedAt` (`:44,389-391`). | Also hands the base-ref signers to the criteria ladder.                                                           |
| `src/review-gate-inputs.mjs`                  | `reviewEntryFacts` (`:154`).                                                  | Hands the base-ref signers to `evaluateReviewEvidence`.                                                           |
| `src/pr-gates.mjs`                            | `evaluateAttestation` (`:475`), `evaluateCriteria` (`:666`).                  | A signature rung after "trusted" and before "current".                                                            |
| `src/review-evidence.mjs`                     | `evaluateReviewEvidence` (`:171-187`).                                        | The same signature rung.                                                                                          |
| `bin/dotbabel-doctor.mjs`                     | Attestation policy findings.                                                  | Key custody findings (§5).                                                                                        |
| `.github/workflows/test.yml` and its template | Skips on a first-line marker from `OWNER` (`:39-47,52`).                      | Skips only on a signature that verifies against the base-ref signers.                                             |
| `hooks/guard-criteria-evidence.sh`            | The only defense (`docs/hooks.md:37-46`).                                     | Hygiene (KD-8). It matches posting commands only, so a read-only `grep` is no longer blocked.                     |

## Sign path

1. The writer builds the payload as today, plus `scope: { repo, pr, family }`. `head_sha` is already in each payload.
2. The writer renders line 2.
3. If a signing key is configured, the writer runs `ssh-keygen -Y sign -n dotbabel-evidence@v1 -f <key>` with line 2 on stdin. For a security key, the user touches the key now. The writer prints the head SHA, the family, and the verdict before it asks for the touch, so the human sees what the touch approves.
4. The writer appends line 3: `<!-- dotbabel-evidence-signature v1 <base64url of the armored SSHSIG> -->`.
5. The writer posts the comment as today.

## Verify path

1. The gate reads the base-ref policy. If no family requires a signature and no line 3 is present, the ladder runs exactly as today (ARCH-3).
2. The gate reads the `allowed_signers` file from the base ref with `git show <base>:<path>`. An absent file with a required signature blocks with `EVIDENCE_SIGNERS_MISSING`.
3. For each trusted, unedited marker comment for the head, the gate decodes line 3 and writes the line-2 bytes, the signature, and the signers to a private temporary directory.
4. `ssh-keygen -Y find-principals` names the principal. `ssh-keygen -Y verify -I <principal> -n dotbabel-evidence@v1` checks the signature.
5. The gate compares the payload scope with the pull request under judgment (KD-3).
6. The existing rungs continue: current head, valid payload, config hash, merge base, required legs.

## Separate-user signer (optional tier, KD-6)

1. The agent writes a request `{repo, pr, head_sha}` to a spool directory that the signer user can read.
2. The signer, a systemd unit of user `dotbabel-signer`, fetches `head_sha` from the remote into its own checkout. It never reads the agent's worktree.
3. The signer runs the governed matrix from the base-ref configuration in a sandbox with no read access to the key (SEC-3).
4. The signer signs and writes the comment body to an outbox. Any process can post it, because the signature, not the poster, carries the trust.
5. The signer's code is a pinned install owned by the signer user, never the npm-linked development checkout that the agent can edit.
