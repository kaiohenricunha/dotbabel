# §5 — Interfaces and APIs

> The contract: configuration, trust ref, trust root, comment format, ladder, reason codes, doctor findings, and the command line.

## 5.1 Configuration (`.dotbabel.json`, read from the trust ref)

```json
{
  "evidence": {
    "allowed_signers": ".dotbabel-allowed-signers",
    "require_signature": {
      "attestation": false,
      "criteria": false,
      "review": false
    },
    "require_user_verification": false,
    "unattended_principals": [],
    "signer_tiers": []
  }
}
```

- The gate reads this block from the trust ref (§5.2). It never reads it from the head, and never from the base of a stacked pull request. The `attestation` block stays where it is today: the gate reads it from the pull request's base ref (`attestationGateInputs`, `plugins/dotbabel/src/attestation-gate-inputs.mjs:92-102`).
- `evidence.allowed_signers` is a repository path. It follows the governance-file path rule (`isGovernablePath`, `plugins/dotbabel/src/attestation.mjs:76-78`). It is **not** added to `DEFAULT_GOVERNANCE_FILES` (`plugins/dotbabel/src/attestation.mjs:54`), so no `config_hash` changes for any repository. Its change control is the trust-root rule (§5.3).
- `evidence.require_signature.<family>` is the switch for one family: `attestation`, `criteria`, or `review`. Each one defaults to `false`. This is the only key path for the switch in this spec. The trust-root family has no switch (§5.3).
- `evidence.require_user_verification` defaults to `false`. When it is `true`, a security-key signature must carry the user-verification flag (a PIN or a biometric), and not only the user-presence flag (§5.7).
- `evidence.unattended_principals` lists the principals that can sign with a key that is not a security key. It is for the separate-user tier (KD-6) only. It defaults to `[]`, so by default every accepted signature comes from a security key and carries the user-presence flag.
- `evidence.signer_tiers` declares keys that are not security keys and are not unattended. Each entry is `{ "fingerprint": "SHA256:<base64>", "tier": "approval-agent" }`, where the fingerprint is the one `ssh-keygen -l` prints for the signer's public key. `approval-agent` is the only tier in this spec (KD-13, §8 A-6). The gate accepts a non-sk signature from a declared key, and it verifies nothing about presence for it: the signature has no flags. It defaults to `[]`. The block is part of the trust root, so a new declaration needs a bundle from a current signer (§5.3).
- The schema change is in `schemas/dotbabel.config.schema.json`.

## 5.2 Trust ref

The trust ref is the commit from which the gate reads the `evidence` block and the signers file (KD-9).

- When the base of the pull request is the default branch, the trust ref is `baseRefOid`, as `gh pr view` reports it.
- When the base is another branch, the trust ref is the tip of the default branch, as the GitHub API reports it. This is the stacked case: a child pull request targets its parent's branch until the parent merges (`skills/pr-conductor/SKILL.md:17-18`). The agent can push to that branch, so the gate never reads trust configuration from it.
- The gate probes the trust ref with `git cat-file -e`, as REL-21 probes the base today (`refIsReadable`, `plugins/dotbabel/src/attestation-gate-inputs.mjs:42-44,83-90`). When the trust ref is the base, the existing probe already covers it and the gate adds no reason. When it is not, an unreadable trust ref blocks the merge gate with `EVIDENCE_TRUST_REF_UNREADABLE`, and `pr-stack entry` skips nothing.
- The merge base and the `config_hash` stay on the pull request's base, as today.

## 5.3 Trust root and the `trust-root` family

The trust root has two parts: the signers file at the path that the trust ref names, and the `evidence` block of `.dotbabel.json`. The gate compares the `evidence` block as parsed JSON, so a change elsewhere in `.dotbabel.json` is not a trust-root change.

- **When the rule applies.** The rule applies when the trust ref's signers file holds at least one kept signer line (§5.4). It does not depend on `attestation.enforce`, and it does not depend on the declared `governance_files`.
- **What the gate checks.** The gate diffs the trust root from the merge base to the head. If either part changed, the pull request needs a current `trust-root` comment that a verified bundle names (§5.7). Its `changes` must equal the change that the gate computes. If no such comment passes, the merge gate blocks with `EVIDENCE_TRUST_ROOT_UNSIGNED`. A touch therefore approves a bundle that names the hash of a payload that names the key change, not only "a pass for this head".
- **Routing.** When `attestation.enforce` is true, the signers file and `.dotbabel.json` also join the set of files that sends a pull request to `explicit`. This is a union with the declared `governance_files`, or with the default list. The two paths join only the touched-file check (`plugins/dotbabel/src/attestation-gate-inputs.mjs:125-134`), never the `config_hash` input.
- **Bootstrap.** The pull request that adds the first signer cannot carry a bundle from a trust-ref signer, because the trust ref has no signer yet. It lands unsigned, through the explicit path, once. The attestation policy has the same bootstrap rule (`docs/attestation.md:43-45`).
- **Writer.** `dotbabel evidence trust-root --pr <N>` computes the change, prints the signer lines it adds and removes and the `evidence` keys it changes, and posts the trust-root comment, lines 1 and 2. It does not sign. The bundle step names the trust-root payload with the other families, so a trust-root change costs no extra touch (KD-12, §5.9).

Trust-root payload:

```json
{
  "schema_version": 1,
  "head_sha": "<40 hex>",
  "merge_base": "<40 hex>",
  "scope": { "repo": "owner/name", "pr": 123, "family": "trust-root" },
  "changes": {
    "allowed_signers": {
      "path": ".dotbabel-allowed-signers",
      "before": "sha256:<hex>",
      "after": "sha256:<hex>"
    },
    "evidence_block": { "before": "sha256:<hex>", "after": "sha256:<hex>" }
  }
}
```

`before` and `after` are `null` for an absent file or an absent block. The `evidence_block` hash is over the block as JSON with sorted keys and no whitespace. Both sides compute it from git objects, so it is a comparison value and not the signed message (KD-2 still holds).

## 5.4 Allowed signers file

OpenSSH `allowed_signers` format, one key on each line, with the namespace pinned (KD-4):

```text
owner@dotbabel namespaces="dotbabel-evidence@v1" sk-ssh-ed25519@openssh.com AAAA...
backup@dotbabel namespaces="dotbabel-evidence@v1" sk-ssh-ed25519@openssh.com AAAA...
```

- The verifier keeps only the lines whose options contain `namespaces="dotbabel-evidence@v1"` and no other namespace. It drops every other line before it writes the file for `ssh-keygen`. OpenSSH accepts a line without a `namespaces=` option for every namespace, so a commit-signing line would otherwise vouch for evidence.
- In this spec, a "kept signer line" is a line that passes this filter.
- Enroll at least two keys, so that one lost key does not block a trust-root change (OPS-3).
- An approval-agent key (§8 A-6) is a plain `ssh-ed25519` line with the same namespace option. The gate accepts its signatures only when `evidence.signer_tiers` declares its fingerprint (§5.1).

## 5.5 Signing key (user scope, never in the repository)

- `DOTBABEL_EVIDENCE_KEY` names a private key file, or a public key file whose private half is in `ssh-agent`.
- Only the bundle step reads it, from the environment or from `~/.config/dotbabel/evidence.env`, the same place pattern that handoff uses (`docs/handoff-guide.md`). The family writers never sign.
- **Approval-agent custody (A-6).** The private half stays in the approval agent and never exists as a file. On the maintainer's WSL host the agent is the Bitwarden desktop SSH agent on Windows, behind the Windows agent pipe. The bundle step then signs through Windows OpenSSH (`/mnt/c/Windows/System32/OpenSSH/ssh-keygen.exe`, `OpenSSH_for_Windows_9.5p2` on that host, E-1), which `DOTBABEL_EVIDENCE_SSH_KEYGEN` names. The verifier still runs Linux `ssh-keygen` from a fixed path (ARCH-7, REL-1), so R-4 applies. The trust ref declares the key in `evidence.signer_tiers` (§5.1).
- The evidence key is a dedicated key. Do not use it as a git signing key, an SSH login key, or a key on the GitHub account. When the human touches the key only for evidence, a blink means evidence. Doctor warns `EVIDENCE_KEY_SHARED` for a shared key (§5.8).
- No key configured: the family writers post as usual, because they never sign. `dotbabel evidence bundle` exits 1 and names the missing key.

## 5.6 Comment format

A family comment has two lines. It carries no signature:

```text
line 1  <!-- <family marker> verified-sha=<head> -->                 unchanged
line 2  <!-- <family payload prefix> <base64url JSON> -->            unchanged prefix; JSON gains scope
```

The bundle comment has three lines:

```text
line 1  <!-- dotbabel-evidence-bundle verified-sha=<head> -->
line 2  <!-- dotbabel-evidence-bundle-payload <base64url JSON> -->
line 3  <!-- dotbabel-evidence-signature v1 <base64url SSHSIG> -->
```

The signed message is the exact UTF-8 text of the bundle's line 2, prefix included (KD-2).

Payload addition for each family:

```json
{ "scope": { "repo": "owner/name", "pr": 123, "family": "attestation" } }
```

`family` is one of `attestation`, `criteria`, `review`, `trust-root`, and `bundle`. The trust-root family uses the marker `<!-- dotbabel-trust-root verified-sha=<head> -->` and the payload prefix `<!-- dotbabel-trust-root-payload`.

Bundle payload:

```json
{
  "schema_version": 1,
  "head_sha": "<40 hex>",
  "scope": { "repo": "owner/name", "pr": 123, "family": "bundle" },
  "families": [
    { "family": "attestation", "payload_sha256": "sha256:<hex>" },
    { "family": "criteria", "payload_sha256": "sha256:<hex>" },
    { "family": "review", "payload_sha256": "sha256:<hex>" },
    { "family": "trust-root", "payload_sha256": "sha256:<hex>" }
  ]
}
```

- `repo` and `pr` sit in `scope`, as in every family payload (KD-3).
- `families` lists only the families that have a current comment for the head when the bundle step runs. The `trust-root` entry is present only when the pull request changes the trust root.
- `payload_sha256` is the SHA-256 of the exact UTF-8 text of that family comment's line 2, prefix and suffix included, without the line terminator (KD-2).
- A family comment counts as signed only through a verified bundle that names its hash under its family (§5.7). Every family's signature, the trust root's included, travels in a bundle.

The evidence schemas (`schemas/dotbabel.attestation-evidence.schema.json`, `schemas/dotbabel.criteria-evidence.schema.json`, `schemas/dotbabel.review-evidence.schema.json`) gain `scope` as an optional property, so a payload from an old writer stays valid. The signature rung requires it: a named payload without a matching `scope` fails with `EVIDENCE_SIGNATURE_SCOPE`. Two new schemas describe the trust-root payload (`schemas/dotbabel.trust-root-evidence.schema.json`) and the bundle payload (`schemas/dotbabel.evidence-bundle.schema.json`).

## 5.7 The ladder and its reason codes

Every family uses one ladder. Each rung assumes that the rung above it passed. The first rung that fails is reported alone, as the ladders do today (`plugins/dotbabel/src/pr-gates.mjs:583-592,782-788`, `plugins/dotbabel/src/review-evidence.mjs:165-166`).

| Rung      | Passes when                                                           | Code (attestation / criteria / review)                                       |
| --------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| missing   | a comment carries the family marker                                   | `ATTESTATION_MISSING` / `CRITERIA_EVIDENCE_MISSING` / `REVIEW_MISSING`       |
| untrusted | a marker comment has a trusted association and no edit                | `ATTESTATION_UNTRUSTED` / `CRITERIA_EVIDENCE_UNTRUSTED` / `REVIEW_UNTRUSTED` |
| stale     | the line-1 marker of a trusted comment names the head                 | `ATTESTATION_STALE` / `CRITERIA_EVIDENCE_STALE` / `REVIEW_STALE`             |
| signature | new; see below                                                        | `EVIDENCE_*`                                                                 |
| payload   | the payload of the selected comment decodes and is valid              | `ATTESTATION_INVALID` / `CRITERIA_EVIDENCE_INVALID` / `REVIEW_INVALID`       |
| family    | attestation: config, base, legs, verdict; criteria: coverage, verdict | the codes of today                                                           |

The "current comments" are the trusted comments that pass the stale rung.

**Bundle verification.** The current bundle comments are the comments with the bundle marker, a trusted association, no edit, and a line-1 marker that names the head. The gate verifies each one once for each run, for all families, newest first. For each bundle it runs these checks in order, and it stops at the first check that fails:

1. Line 3 is present and decodes to an armored SSHSIG (else `EVIDENCE_SIGNATURE_INVALID`).
2. `ssh-keygen -Y find-principals` names exactly one principal among the kept signer lines. No principal, more than one principal, or a wildcard pattern gives `EVIDENCE_SIGNER_UNKNOWN`.
3. `ssh-keygen -Y verify -I <principal> -n dotbabel-evidence@v1` accepts the bundle's line-2 bytes (else `EVIDENCE_SIGNATURE_INVALID`).
4. The verifier checks the signer tier. For an `sk-` key, it parses the SSHSIG blob itself (KD-11): the signature must carry the user-presence flag, and also the user-verification flag when `evidence.require_user_verification` is true. A key that is not a security key must belong to a principal in `evidence.unattended_principals`, or have a fingerprint that `evidence.signer_tiers` declares with the tier `approval-agent` (KD-13). Else `EVIDENCE_NO_USER_PRESENCE`.
5. Line 2 carries the bundle payload prefix and decodes, and the signed `scope.repo`, `scope.pr`, `scope.family` (`bundle`), and `head_sha` match the pull request and the head under judgment (else `EVIDENCE_SIGNATURE_SCOPE`). The gate compares the signed `head_sha`, never only the line-1 marker.

A bundle that passes all five checks is a verified bundle. The result records the signer's tier (`security-key`, `approval-agent`, or `unattended`), and the gate output names it, so a verdict that rests on an approval-agent signature does not read as a touch. A bundle "names" a hash when its line 2 decodes and its `families` list holds that hash. This needs no signature check.

**The signature rung, switch on.** The gate judges the current comments of the family from newest to oldest. A comment passes when both of these hold:

- A verified bundle names the SHA-256 of the comment's line 2 under this family.
- The comment's line 2 carries this family's payload prefix and decodes, and its own `scope.repo`, `scope.pr`, `scope.family`, and `head_sha` match the pull request and the head. Its `head_sha` therefore equals the bundle's.

The first comment that passes is the selected comment, and the ladder continues with it. If no comment passes, the gate reports one code for the newest current comment:

1. `EVIDENCE_UNSIGNED` when no current bundle names its hash. This covers a pull request with no bundle, and a comment re-posted after the bundle with a different line 2 (§4).
2. Else, if a verified bundle names its hash, `EVIDENCE_SIGNATURE_SCOPE`: the bundle names it under another family, or the comment's own prefix, scope, or `head_sha` does not match.
3. Else, the code of the newest current bundle that names its hash and fails the bundle checks.

Before the loop, a trust ref with no kept signer line gives `EVIDENCE_SIGNERS_MISSING`, and a failed capability probe gives `EVIDENCE_VERIFIER_UNAVAILABLE` (REL-1).

**The signature rung, switch off.** The selected comment is the newest current comment, as today. If no current bundle names its hash, the rung does nothing (REL-2). If a current bundle names it, the gate runs the same checks. A pass changes nothing. A failure, `EVIDENCE_SIGNERS_MISSING` and `EVIDENCE_VERIFIER_UNAVAILABLE` included, becomes a **warning** with that code, and the gate judges the comment as unsigned evidence. While the switch is off, a signature never makes evidence weaker than no signature, because the agent could delete the bundle.

| Code                            | When                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EVIDENCE_UNSIGNED`             | The family requires a signature, no current comment passes, and no current bundle names the hash of the newest current comment.                                                                                          |
| `EVIDENCE_SIGNATURE_INVALID`    | The bundle's line 3 is absent or does not decode, or `ssh-keygen -Y verify` rejects it.                                                                                                                                  |
| `EVIDENCE_SIGNER_UNKNOWN`       | No kept signer line matches the key, or the match is not exactly one principal.                                                                                                                                          |
| `EVIDENCE_NO_USER_PRESENCE`     | A security-key signature without the required flags, or a non-sk key that is neither in `unattended_principals` nor declared with the tier `approval-agent`.                                                             |
| `EVIDENCE_SIGNATURE_SCOPE`      | The signed bundle names another repository, pull request, or head; a verified bundle names the comment's hash under another family; or the named family payload names another repository, pull request, family, or head. |
| `EVIDENCE_SIGNERS_MISSING`      | A signature is required and the trust ref has no kept signer line at the declared path.                                                                                                                                  |
| `EVIDENCE_VERIFIER_UNAVAILABLE` | A signature is required and no `ssh-keygen` at a fixed system path passes the capability probe. Exit 2.                                                                                                                  |
| `EVIDENCE_TRUST_REF_UNREADABLE` | The trust ref is not the base, and its commit is not in this clone (§5.2).                                                                                                                                               |
| `EVIDENCE_TRUST_ROOT_UNSIGNED`  | The pull request changes the trust root, and no current trust-root comment that a verified bundle names has `changes` equal to the change.                                                                               |

**Effect of each code when the family requires a signature.**

- Attestation: `EVIDENCE_UNSIGNED` gives the state `explicit` with a warning, not a blocking reason (KD-10). `/merge-pr` then verifies explicitly, as it does for `off` (`docs/attestation.md:61-66`). Every other `EVIDENCE_*` code gives the state `failed` and blocks, because a signature that is present but wrong is an attack signal.
- Criteria: every `EVIDENCE_*` code blocks. Criteria have no explicit path. The recovery for `EVIDENCE_UNSIGNED` is `dotbabel criteria verify --pr <N> --post`, then `dotbabel evidence bundle --pr <N>` with a key configured.
- Review: every `EVIDENCE_*` code gives `reviewedAtHead: false`, so `pr-stack entry` does not skip the review stage. The review family never blocks a merge.
- `EVIDENCE_TRUST_ROOT_UNSIGNED` and `EVIDENCE_TRUST_REF_UNREADABLE` block the merge gate for every family.
- `/merge-pr` gets one recovery line for each code (`commands/merge-pr.md`).

## 5.8 Doctor findings

Doctor reads the signers file at the trust ref and checks every line, not only the configured key.

| Level | Code                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fail  | `EVIDENCE_SIGNERS_MISSING`       | A family requires a signature, and the trust ref has no kept signer line.                                                                                                                                                                                                                                                                                                                                                                                |
| warn  | `EVIDENCE_KEY_AGENT_READABLE`    | A non-sk signer key has a private key file that the current UID can read: the configured key, or a `~/.ssh` key whose `.pub` matches a signer line. A signature from it proves nothing about who signed.                                                                                                                                                                                                                                                 |
| warn  | `EVIDENCE_KEY_IN_AGENT`          | `ssh-add -L` lists a non-sk signer key in the `ssh-agent` that `SSH_AUTH_SOCK` reaches, or, on WSL with interop on, `ssh-add.exe -L` lists one in the Windows agent. The agent can sign through it with no gesture, unless the key was added with `ssh-add -c`, which doctor cannot see. A key that `evidence.signer_tiers` declares with the tier `approval-agent` does not raise this finding; doctor reports `EVIDENCE_SIGNER_APPROVAL_AGENT` for it. |
| warn  | `EVIDENCE_SIGNER_NOT_SK`         | A signer line holds a non-sk key, its principal is not in `evidence.unattended_principals`, and `evidence.signer_tiers` does not declare its fingerprint. The gate refuses every signature from it.                                                                                                                                                                                                                                                      |
| warn  | `EVIDENCE_SIGNER_APPROVAL_AGENT` | A kept signer line holds a key that `evidence.signer_tiers` declares with the tier `approval-agent`. This tier is weaker than a security key: the gate verifies nothing about presence for it, any process that reaches the agent can ask for a signature, and the only barrier is the agent's dialog (§8 A-6, R-11).                                                                                                                                    |
| warn  | `EVIDENCE_SIGNER_NO_NAMESPACE`   | A signers line does not pin `namespaces="dotbabel-evidence@v1"`. The gate ignores it.                                                                                                                                                                                                                                                                                                                                                                    |
| warn  | `EVIDENCE_KEY_SHARED`            | The evidence key is also `git config user.signingkey`, an `IdentityFile` in `~/.ssh/config`, or an authentication or signing key on the GitHub account.                                                                                                                                                                                                                                                                                                  |
| warn  | `EVIDENCE_KEY_NO_TOUCH`          | The configured sk key handle carries the no-touch-required flag. The gate refuses its signatures (SEC-6).                                                                                                                                                                                                                                                                                                                                                |
| warn  | `EVIDENCE_KEY_NOT_A_SIGNER`      | The configured key is not a kept signer line at the trust ref, so the gate refuses every signature it makes.                                                                                                                                                                                                                                                                                                                                             |
| warn  | `EVIDENCE_WORKFLOW_UNGOVERNED`   | `attestation.enforce` is true, and the workflow file that holds the classify job is not in `attestation.governance_files` (ARCH-8).                                                                                                                                                                                                                                                                                                                      |
| warn  | `EVIDENCE_WSL_INTEROP`           | The separate-user tier is configured on WSL with interop enabled (§8 R-2).                                                                                                                                                                                                                                                                                                                                                                               |
| info  | `EVIDENCE_SINGLE_SIGNER`         | The trust ref has one kept signer line. If that key is lost, only the R-3 path can change the trust root (OPS-3).                                                                                                                                                                                                                                                                                                                                        |
| info  | `EVIDENCE_UNSIGNED_MODE`         | No family requires a signature. Nothing is wrong; the gate trusts comment text as before.                                                                                                                                                                                                                                                                                                                                                                |

Doctor never runs a signature. A touch request during a diagnostic would teach the user to touch without reading.

## 5.9 Command line and seams

- `dotbabel evidence verify --pr <N> --family attestation` runs the shared verifier for the CI classify job (ARCH-8). It reads the policy and the signers from the trust ref. When the trust ref requires attestation signatures, it exits 0 only when a current comment passes the signature rung and its verdict is `pass`. When it does not, it exits 0 on a current, trusted, unedited, passing attestation, as `hasCurrentAttestation` decides today (`plugins/dotbabel/src/attestation.mjs:272-285`). Exit 1 means "not verified". Exit 2 means that the verifier or an input is not available.
- `dotbabel evidence verify` also takes its inputs from files: `--comments <file> --signers <file> --policy <file>`. That form needs no GitHub and no trust ref, and PR-1a tests it that way (§6).
- `dotbabel evidence trust-root --pr <N>` is the trust-root writer (§5.3). It posts lines 1 and 2, and it does not sign.
- `dotbabel evidence bundle --pr <N>` is the bundle writer and the only command that signs (§4 Sign path, KD-12). It exits 1 when no key is configured, and when the head has no current family comment to name.
- The three family writers keep their commands: `dotbabel local-attest --pr <N>`, `dotbabel criteria verify --pr <N> --post`, and `dotbabel pr-stack review-complete --pr <N>`. They never sign.
- **The `deps.run` seam gains an `input` option.** The new signature is `run(argv, { input })`, where `input` is the text for stdin. `ssh-keygen -Y verify` and `-Y sign` read the message from stdin. Today the seam has no stdin: the typedef is `run: (argv) => {status, stdout, stderr}` (`plugins/dotbabel/src/attestation-gate-inputs.mjs:22`, `plugins/dotbabel/src/review-gate-inputs.mjs:10`), and the real `run` spawns with `stdio: ["ignore", "pipe", "pipe"]` (`plugins/dotbabel/bin/dotbabel-pr-stack.mjs:175-183`). `ghApiWithInput` is the precedent for a stdin input (`plugins/dotbabel/bin/dotbabel-pr-stack.mjs:206-215`).
