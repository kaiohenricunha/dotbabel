# §7 — Non-Functional Requirements

> REL and SEC are invariants that fail closed. PERF and OPS are ceilings.

## Security

- **SEC-1:** The gate reads signers and the signature policy from the base ref only. A signer added at the head is unknown to the gate for that pull request (AC-3).
- **SEC-2:** A signature binds exactly one repository, one pull request number, one head SHA, and one family. Any mismatch blocks with `EVIDENCE_SIGNATURE_SCOPE` (AC-4).
- **SEC-3:** In the separate-user tier, the process that runs the matrix has no read access to the signing key. The key file is mode 0600, owned by the signer user, and outside every path the sandbox mounts.
- **SEC-4:** Doctor warns when the configured key is a plain file readable by the current UID and is not an `sk-` key (AC-7).
- **SEC-5:** The signature namespace is `dotbabel-evidence@v1`. A signature made under any other namespace never verifies as evidence.

## Reliability

- **REL-1:** When a family requires a signature and `ssh-keygen` is absent or reports a version below 8.1, the gate blocks with `EVIDENCE_VERIFIER_UNAVAILABLE` and exit 2. It never treats an unverifiable signature as a pass.
- **REL-2:** When no family requires a signature, the gate output for an unsigned comment is byte-identical to its output before this spec (AC-5).
- **REL-3:** The verifier writes its three inputs to a temporary directory with mode 0700 and deletes the directory on every exit path.

## Performance

- **PERF-1:** Verification starts at most two `ssh-keygen` processes for each evidence comment it judges: one `find-principals` and one `verify`. The gate judges at most one comment for each family, the newest trusted one for the head.

## Operations

- **OPS-1:** The change adds zero npm runtime dependencies. The one new external requirement is OpenSSH 8.1 or later, on the verifier side only.
- **OPS-2:** With the human-presence tier, a pull request head needs at most three touches, one for each family, until Q-1 decides on bundling.
- **OPS-3:** Losing a key never blocks merging forever. The owner adds a new signer in a pull request that lands on the explicit path, and evidence signed by the new key verifies from the next pull request on.
