# §3 — High-Level Architecture

> The shape of the fix, and the decisions that fix its shape.

## Overview

```text
 writers (local-attest | criteria verify --post | pr-stack review-complete | evidence trust-root)
   │ 1. build payload (as today) + scope {repo, pr, family}
   │ 2. post line 1 marker + line 2 payload, unsigned (as today)
   ▼
 bundle step (dotbabel evidence bundle --pr <N>), once for each head
   │ 3. read the current family comments for the head
   │ 4. bundle payload: scope {repo, pr, family: bundle}, head_sha,
   │      families [{family, payload_sha256 of that family's line 2}]
   │ 5. ssh-keygen -Y sign -n dotbabel-evidence@v1 over the bundle line-2 bytes
   │      key custody: security key (touch), approval agent (dialog),
   │      or separate-user signer
   ▼
 PR comments:  family  line 1 marker   line 2 payload
               bundle  line 1 marker   line 2 payload   line 3 signature
   │
   ▼
 verifier (merge gate | pr-stack entry | CI classify through `dotbabel evidence verify`)
   │ a. trust ref = the base if it is the default branch, else the default branch tip
   │ b. evidence policy and namespace-pinned signers from the trust ref (git show)
   │ c. each current bundle, once: find-principals, verify, signer tier,
   │      signed scope and head
   │ d. ladder: missing → untrusted → stale → signature → payload → family rungs
   │      signature = a verified bundle names this comment's line-2 hash
   │      under this family, and the comment's own scope and head match
   │ e. merge gate only: a trust-root change needs a trust-root comment
   │      that a verified bundle names
   ▼
 verified | explicit | blocked with a reason code
```

The bundle signature replaces "who posted the comment" as the fact that makes evidence believable. One signature covers every family for one head, so a human-presence tier costs one touch for each head (KD-12). The comment stays the transport, so no new GitHub surface is necessary.

A verifier is only as strong as the place where it runs. §2 Boundaries states which verifiers are enforcement points and which are not.

## Constraints

- **ARCH-1.** The gate reads the `evidence` policy and the signers file from the trust ref only (§5.2), with `git show`, as it reads the attestation policy from the base today (`plugins/dotbabel/src/attestation-gate-inputs.mjs:12-15`). The trust ref is the default branch. It is never the head, and never the feature branch under a stacked pull request.
- **ARCH-2.** Verification is a decision over five inputs: the family line-2 bytes, the bundle line-2 bytes, the bundle line-3 signature, the trust-ref signers text, and the trust-ref policy. `ssh-keygen` runs behind the `deps.run` seam, so every branch is testable without a key or a network. The seam gains an `input` option for stdin (§5.9). Today it has no stdin (`plugins/dotbabel/src/attestation-gate-inputs.mjs:22`, `plugins/dotbabel/bin/dotbabel-pr-stack.mjs:175-183`), and `ssh-keygen -Y verify` reads the message from stdin.
- **ARCH-3.** For each family, the gate accepts unsigned evidence if and only if the trust ref does not require a signature for that family. While the switch is off, a bundle that names the comment and fails verification gives a warning, never a reason (§5.7).
- **ARCH-4.** The trusted-association and no-edit checks stay (`plugins/dotbabel/src/pr-gates.mjs:663-665,903-905`, `plugins/dotbabel/src/review-evidence.mjs:185`). A signature is an extra fact, never a replacement for an existing refusal. The signature rung sits after the `stale` rung and before the `payload` rung, in every family (§5.7).
- **ARCH-5.** Every reader of a family uses the one verifier: the merge gate (`evaluateAttestation`, `evaluateCriteria`), `pr-stack entry` (`evaluateReviewEvidence` and `hasCurrentAttestation`, both through `reviewEntryFacts`, `plugins/dotbabel/src/review-gate-inputs.mjs:154-162`), and the CI classify job through `dotbabel evidence verify` (§5.9). Today the CI job checks only an `OWNER` first line, with no edit check and no payload check (`.github/workflows/test.yml:39-47`).
- **ARCH-6.** The trust root is under change control (§5.3). A pull request that changes the signers file or the `evidence` block needs a trust-root comment that a bundle from a trust-ref signer names. The rule does not depend on `attestation.enforce` or on the declared `governance_files`, and it does not change any `config_hash`.
- **ARCH-7.** The local verifier closes the cheap tampering paths. Every git call in the attestation and evidence gathers runs `git --no-replace-objects`, with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, and `GIT_REPLACE_REF_BASE` removed from the environment. Today `showAtRev` runs a plain `git show` (`plugins/dotbabel/src/attestation-gate-inputs.mjs:58-61`), so a `git replace` ref changes what it returns. The verifier runs `ssh-keygen` by an absolute path from a fixed list of system locations, never through `PATH`. It still runs as the agent's UID, from an install the agent can edit, so it is not an enforcement point (§2 Boundaries).
- **ARCH-8.** The CI classify step runs verifier code and signers from the trust ref. It checks out the trust ref, never the head or the merge ref, and runs `dotbabel evidence verify` from that checkout. A consumer repository runs a published dotbabel version that its workflow file pins. The workflow file itself comes from the pull request, because the trigger is `pull_request` (`.github/workflows/test.yml:3-6`). So the workflow file must be in `attestation.governance_files`: a pull request that edits it then lands on `explicit` (AC-16), and doctor warns when it is not governed (§5.8). The template rule against `pull_request_target` stays (`plugins/dotbabel/tests/workflow-templates.test.mjs:88-94`); Q-4 records the stronger option.

## Key decisions

- **KD-1 — SSH signatures, not a GitHub App.** `ssh-keygen -Y sign` and `-Y verify` arrived in OpenSSH 8.1. Security-key key types and `-Y find-principals` arrived in 8.2, so the floor is OpenSSH 8.2. The verifier checks the capability with a test vector, not with a version string (REL-1). OpenSSH ships on every GitHub-hosted runner and on the maintainer's machine (OpenSSH 9.6p1, checked 2026-10-12). There is no npm dependency (ADR-0002), no registered App, and no hosted service. A GitHub App moves the problem to "where is the App's private key", which is the same custody problem (§8, A-1).
- **KD-2 — Sign the bundle's line-2 bytes verbatim, and hash each family's line-2 bytes verbatim.** The signed message is the exact UTF-8 text of the bundle payload line, prefix included. Each family payload line enters the bundle as the SHA-256 of its exact UTF-8 text, prefix and suffix included, as `decodePayloadLine` splits it from the body on `\n` (`plugins/dotbabel/src/lib/evidence-payload.mjs:54-56`). The criteria reader splits its line 2 the same way (`plugins/dotbabel/src/criteria/evidence.mjs:62`). No canonical-JSON step can disagree between writer and verifier.
- **KD-3 — Scope inside the signed payload.** Every payload names `repo`, `pr`, and `family` in `scope`, and `head_sha`. The bundle payload uses the family `bundle`, and its `families` list pairs each family name with a payload hash. The verifier compares the signed bundle scope and `head_sha` with the pull request it judges. It checks that the bundle names the family comment's hash under that comment's family, and it compares the family payload's own scope and `head_sha` too. It never relies on the unsigned line-1 marker alone. So a valid bundle cannot be replayed onto another repository, pull request, or head, and a named payload cannot move to another family.
- **KD-4 — The namespace is pinned, and the key is dedicated.** Signatures use the namespace `dotbabel-evidence@v1`. The verifier keeps only the signers lines that pin that namespace (§5.4), because OpenSSH accepts a line with no `namespaces=` option for every namespace. The evidence key signs nothing else: no commits and no SSH logins (§5.5). So a commit-signing key cannot vouch for evidence, and a blink of the evidence key always means evidence.
- **KD-5 — Human presence is the default custody, and presence is all that it proves.** The default key is a FIDO2 security key (`ssh-keygen -t ed25519-sk`). The authenticator sets a user-presence flag inside the signed data only after a physical touch, and the verifier refuses a signature without that flag (SEC-6). The agent can prepare a bundle, but it cannot complete a believed signature without the human. That meets the narrow goal in §1. It does not prove that the human approved this payload. The key has no display, and the summary that the writer prints comes from a process the agent controls. A touch proves presence. It does not prove approval of the bytes, and it does not prove an honest run. §8 R-1 states that limit.
- **KD-6 — A separate-user signer is the optional stronger tier.** A signer that runs as another OS user fetches the head SHA from the remote, runs the governed matrix itself, and signs with a key the human's UID cannot read. It proves both who signed and that a real run happened, and it needs no human approval of the bytes. It costs the most setup, and on WSL it is weaker (§8 R-2).
- **KD-7 — One switch per family, attestation first.** `evidence.require_signature.<family>` is set per family. Attestation flips first, because its forgery removes verification (`.claude/hooks/guard-criteria-evidence.sh:47-60`). The trust-root rule has no switch: it applies as soon as the trust ref has a signer.
- **KD-8 — The text guard becomes hygiene.** When the gate stops believing unsigned text, `guard-criteria-evidence.sh` no longer carries the security claim. It keeps catching the casual path, and its read-only false positive (§1) is fixed by matching only commands that post.
- **KD-9 — The trust ref is the default branch.** Policy and signers come from the default branch, never from the base of a stacked pull request. The agent can push to a feature branch and add its own signer there (§8 R-8).
- **KD-10 — An unsigned attestation goes to `explicit`, not `failed`.** With the switch on, unsigned attestation evidence means "verify explicitly". The gate still never skips verification on evidence the agent wrote, which is the §1 goal. A headless run, or a machine without a working tier, is not a dead end, because `/merge-pr` never runs the matrix on `failed` (`docs/attestation.md:66`). A signature that is present but wrong is an attack signal, so it stays `failed`.
- **KD-11 — The verifier reads the security-key flags itself, for `sk-` signers only.** The design does not trust `ssh-keygen -Y verify` to refuse a signature without user presence. For an `sk-` signature, the verifier parses the SSHSIG blob and reads the flags byte that the authenticator signed. A signature from a key that is not a security key has no flags byte, so for it the verifier checks only the declaration (KD-13, §5.1). Experiment E-2 (§6) checks the OpenSSH behavior that this decision assumes. E-2 is deferred until a hardware key exists (owner decision, 2026-10-12).
- **KD-12 — One touch for each pull-request head, by a bundle signature (Q-1, decided 2026-10-12).** The family writers post unsigned payload lines, as today. One final step, `dotbabel evidence bundle --pr <N>`, signs one bundle payload that names the SHA-256 of each current family payload line for the head (§5.6). The trust-root payload joins the same bundle when the pull request changes the trust root, so that change costs no extra touch. The gate verifies the bundle signature once, and a family comment counts as signed only through a verified bundle that names its hash. The costs: one touch now approves every payload that the bundle names (§8 R-1), and a family comment that changes after the bundle is unsigned until a new bundle names it.
- **KD-13 — An approval agent is a declared, casual-only tier (owner decision, 2026-10-12).** A desktop SSH agent that shows an approval dialog before each signature, such as the Bitwarden desktop SSH agent, holds a plain `ssh-ed25519` key (§8 A-6). Its signature has no user-presence flag, so the gate verifies nothing about presence for it. The gate accepts it only when the trust ref's `evidence.signer_tiers` declares the key's fingerprint with the tier `approval-agent` (§5.1). That declaration is a trust-root change (ARCH-6), so the agent cannot declare its own key without one owner approval. With A-6, the dialog does not show the change, so that approval can enroll a key that the agent holds (§8 R-3). On the maintainer's WSL host, A-6 scores 0 on agent resistance (§8 A-6). Windows Hello cannot hold the key there (Q-3, E-1), and the owner does not plan an A-5 security key there. So the owner accepts A-6 there as a casual-only tier below the §1 goal: the evidence gate would stop casual or accidental agent signing only. Doctor and the gate output name the tier casual-only (§5.7, §5.8).

## What this design does not change

- The governance-file hash and the `explicit` state (`docs/attestation.md:82-93`). A signer approves a payload; the hash still decides whether the matrix in that payload was the base's matrix. The trust-root paths join the `explicit` routing, never the hash input (§5.3).
- The attestation policy (`attestation.*`), the merge base, and the `config_hash` stay on the pull request's base ref.
- The post-pr-review receipt. It stays agent-asserted (§2, Out of Scope).
