# §5 — Interfaces and APIs

> The contract: configuration, comment format, reason codes, doctor findings.

## 5.1 Configuration (`.dotbabel.json`, read from the base ref)

```json
{
  "evidence": {
    "allowed_signers": ".dotbabel-allowed-signers",
    "require_signature": {
      "attestation": false,
      "criteria": false,
      "review": false
    }
  }
}
```

- `allowed_signers` is a repository path. It is a plain relative path, with the same rules as a governance file (`plugins/dotbabel/src/attestation.mjs:76`). It is added to the default `attestation.governance_files`, so a pull request that edits it lands on the `explicit` path.
- `require_signature` defaults to `false` for each family. The schema change is in `schemas/dotbabel.config.schema.json`.

## 5.2 Allowed signers file

OpenSSH `allowed_signers` format, one key on each line, with the namespace pinned (KD-4):

```text
owner@dotbabel namespaces="dotbabel-evidence@v1" sk-ssh-ed25519@openssh.com AAAA...
```

## 5.3 Signing key (user scope, never in the repository)

- `DOTBABEL_EVIDENCE_KEY` names a private key file, or a public key file whose private half is in `ssh-agent`.
- The writers read it from the environment or from `~/.config/dotbabel/evidence.env`, the same place pattern that handoff uses (`docs/handoff-guide.md`).
- No key configured: the writer posts unsigned evidence. If the base ref requires a signature for that family, the writer refuses with exit 1 and names the missing key.

## 5.4 Comment format

```text
line 1  <!-- <family marker> verified-sha=<head> -->        unchanged
line 2  <!-- <family payload prefix> <base64url JSON> -->     unchanged prefix; JSON gains scope
line 3  <!-- dotbabel-evidence-signature v1 <base64url SSHSIG> -->   new
```

Payload additions, for each family:

```json
{ "scope": { "repo": "owner/name", "pr": 123, "family": "attestation" } }
```

The evidence schemas (`schemas/dotbabel.attestation-evidence.schema.json`, `dotbabel.criteria-evidence.schema.json`, `dotbabel.review-evidence.schema.json`) gain `scope` as an optional property. It becomes required when a signature is present.

## 5.5 Reason codes

| Code                            | Blocks when                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `EVIDENCE_UNSIGNED`             | The base requires a signature for the family, and the current evidence has no line 3.        |
| `EVIDENCE_SIGNATURE_INVALID`    | Line 3 does not decode, or `ssh-keygen -Y verify` rejects it.                                |
| `EVIDENCE_SIGNER_UNKNOWN`       | No principal in the base-ref `allowed_signers` file matches the signing key.                 |
| `EVIDENCE_SIGNATURE_SCOPE`      | The payload scope names another repository, pull request, head, or family.                   |
| `EVIDENCE_SIGNERS_MISSING`      | A signature is required and the base ref has no `allowed_signers` file at the declared path. |
| `EVIDENCE_VERIFIER_UNAVAILABLE` | A signature is required and `ssh-keygen` is absent or older than 8.1. Exit 2, fail closed.   |

Each code sits in the existing ladder for its family, after "untrusted" and before "stale". A lower rung that fails is reported alone, as the ladder does today (`plugins/dotbabel/src/pr-gates.mjs:457-463`).

## 5.6 Doctor findings

| Level | Code                          | Meaning                                                                                                                                       |
| ----- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| fail  | `EVIDENCE_SIGNERS_MISSING`    | A family requires a signature and the signers file is absent on the base ref.                                                                 |
| warn  | `EVIDENCE_KEY_AGENT_READABLE` | The configured key is a plain file the current UID can read, and it is not an `sk-` key. A signature from it proves nothing about who signed. |
| warn  | `EVIDENCE_KEY_NOT_A_SIGNER`   | The configured key is not in the base-ref signers file, so every signature it makes is refused.                                               |
| warn  | `EVIDENCE_WSL_INTEROP`        | The separate-user tier is configured on WSL with interop enabled (§8 R-2).                                                                    |
| info  | `EVIDENCE_UNSIGNED_MODE`      | No family requires a signature. Nothing is wrong; the gate trusts comment text as before.                                                     |

Doctor never runs a signature. Asking for a touch during a diagnostic would teach the user to touch without reading.
