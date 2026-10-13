# §7 — Non-Functional Requirements

> REL and SEC are invariants that fail closed. PERF and OPS are ceilings.

## Security

- **SEC-1:** The gate reads the signers and the signature policy from the trust ref only (§5.2). A signer added at the head is unknown to the gate for that pull request (AC-3). A signer added on a feature-branch base is unknown too (AC-11).
- **SEC-2:** A bundle signature binds exactly one repository, one pull request number, and one head SHA, inside the signed bundle payload. It binds each named family payload by its hash, under one family name, and that payload names the same repository, pull request, family, and head. Any mismatch blocks with `EVIDENCE_SIGNATURE_SCOPE` (AC-4).
- **SEC-3:** In the separate-user tier, the process that runs the matrix has no read access to the signing key. The key file is mode 0600, owned by the signer user, and outside every path that the sandbox mounts.
- **SEC-4:** Doctor checks every signer line at the trust ref and every key in the reachable `ssh-agent`, not only the configured key (§5.8, AC-7, AC-15).
- **SEC-5:** The signature namespace is `dotbabel-evidence@v1`. A signature made under another namespace never verifies as evidence. A signers line that does not pin the namespace is ignored (AC-14).
- **SEC-6:** A security-key signature without the user-presence flag never verifies as evidence. When `evidence.require_user_verification` is true, a signature without the user-verification flag never verifies either. A key that is not a security key verifies only for a principal in `evidence.unattended_principals`, or for a fingerprint that `evidence.signer_tiers` declares with the tier `approval-agent` (AC-10, AC-18). Neither of these carries a presence flag, so the gate verifies nothing about presence for them.
- **SEC-7:** The evidence key is dedicated. Doctor warns when it is also a git signing key, an SSH login key, or a key on the GitHub account (§5.5).
- **SEC-8:** A change to the trust root merges only with a trust-root payload that names that change, named in a bundle that a trust-ref signer signed (AC-9).

## Reliability

- **REL-1:** When a family requires a signature, the gate resolves `ssh-keygen` from a fixed list of absolute system paths and verifies a shipped `sk-ssh-ed25519` test vector with `-Y find-principals` and `-Y verify`. If no binary passes, the gate blocks with `EVIDENCE_VERIFIER_UNAVAILABLE` and exit 2. It never parses a version string, and it never treats an unverifiable signature as a pass. OpenSSH 8.2 or later passes the probe.
- **REL-2:** When the trust ref requires no signature for a family and no current bundle names the selected comment, the gate output for that comment is byte-identical to its output before this spec (AC-5).
- **REL-3:** The verifier writes its inputs to a temporary directory with mode 0700, and deletes the directory on every exit path.
- **REL-4:** An unreadable trust ref is not "no policy". The merge gate blocks with `EVIDENCE_TRUST_REF_UNREADABLE`, and `pr-stack entry` skips nothing (§5.2).

## Performance

- **PERF-1:** For each bundle comment it judges, the verifier starts at most two `ssh-keygen` processes: one `find-principals` and one `verify`. It verifies each current bundle at most once for each gate run, for all families. A family comment costs one SHA-256 hash and no process. With the switch on, the gate judges the current comments of a family from newest to oldest and stops at the first one that passes the signature rung. With the switch off, it judges only the newest current comment, as today. The capability probe runs once for each process.

## Operations

- **OPS-1:** The change adds zero npm runtime dependencies. The one new external requirement is OpenSSH 8.2 or later, on the verifier side only.
- **OPS-2:** With the human-presence tier, a pull request head needs one touch: the bundle that names every family, and the trust-root payload when the pull request changes the trust root (KD-12). With the approval-agent tier, it needs one approval in the dialog. A family comment whose line 2 changes after the bundle needs one more bundle, so one more touch.
- **OPS-3:** Losing one key does not block a trust-root change, because a second enrolled key signs it (§5.4). Losing every key leaves one recovery: the owner restores the trust root outside the pull-request flow, with a direct push to the default branch. That is the R-3 path, used on purpose. Doctor reports `EVIDENCE_SINGLE_SIGNER` before that happens.
- **OPS-4:** Enforcement does not start before a custody tier works on the maintainer's main machine, or the owner accepts a tier below the §1 goal on the record (§6, PR-3). E-1 found that Windows Hello does not work there (Q-3), and the owner does not plan an A-5 security key there. The owner accepts A-6 there as a casual-only tier that scores 0 on agent resistance (owner decisions, 2026-10-12, §8 A-6). So, on that host, the evidence gate would stop casual or accidental agent signing only, and a determined agent on the same Windows account can defeat it. The spec is parked, so no enforcement is scheduled (§6 Status).
