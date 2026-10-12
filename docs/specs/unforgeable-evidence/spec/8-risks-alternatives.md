# §8 — Risks and Alternatives

> Why this design, what else was scored, and what risk is left.

## Alternatives

Scoring uses 0 to 3 on each axis, where 3 is best. **Agent resistance is a gate, not a weight.** An option that scores below 2 there does not meet the goal in §1, whatever its other scores. The other three axes rank the options that pass.

- **Agent resistance:** 3 = the agent cannot produce believed evidence, even with the human's token and files. 2 = it cannot without a human gesture or an OS privilege change. 1 = it can for part of the evidence. 0 = it can alone.
- **CI minutes:** 3 = no GitHub-hosted minutes. 0 = the full matrix on hosted runners for each push. The operator guide records why minutes matter: "CI minutes are billed" (`skills/local-attest/references/operator-guide.md:3-7`).
- **Solo setup:** 3 = nothing to set up. 0 = new OS users, services, and keys.
- **Consumer adoption:** 3 = works for any consumer with no new concepts. 0 = needs infrastructure most consumers will not run.

| Id   | Option                                                                     | Agent resistance          | CI minutes | Solo setup | Consumer adoption | Passes the gate         |
| ---- | -------------------------------------------------------------------------- | ------------------------- | ---------- | ---------- | ----------------- | ----------------------- |
| S-0  | Status quo: marker, trusted association, no-edit check, text guard         | 0                         | 3          | 3          | 3                 | no                      |
| A-1  | GitHub App check-run, App key on the maintainer's machine                  | 0 to 2                    | 3          | 1          | 1                 | only with A-4's custody |
| A-2  | Self-hosted GitHub Actions runner as a separate OS user                    | 2                         | 3          | 1          | 1                 | yes                     |
| A-3  | CI-hosted cheap legs, local attestation for the expensive legs             | 1                         | 1          | 3          | 3                 | no                      |
| A-3' | CI-hosted full matrix, no local attestation                                | 3                         | 0          | 3          | 3                 | yes                     |
| A-4  | Separate-user signer that runs the matrix itself and signs (SSH signature) | 2 (1 on WSL with interop) | 3          | 0          | 1                 | yes, not on WSL         |
| A-5  | Human-presence key: security-key SSH signature, touch per signature        | 2                         | 3          | 2          | 2                 | yes                     |

### A-1 — GitHub App check-run

Only a GitHub App can create a check run, and a gate can pin the check run to the App's ID. A personal token can still create a commit **status** with any name, so the gate must read check runs by App ID and never statuses. The weak point is the App's private key. If it is a file the human's UID can read, the agent reads it and the score is 0. If it is held by a separate user, the option inherits A-4's custody and adds a registered App on top. It is a publisher, not a custody answer.

### A-2 — Self-hosted runner as a separate OS user

Jobs on a self-hosted runner use no GitHub-hosted minutes, and the agent cannot author a check run as the GitHub Actions App. Two problems remain. The workflow file comes from the pull request head, so a pull request can rewrite the job; `.github/workflows/**` must be governed so that such a pull request lands on the explicit path. And this repository is public, so a fork's pull request can run code on the maintainer's machine unless fork workflows need approval. On WSL it has A-4's interop weakness.

### A-3 and A-3' — CI-hosted verification

A-3' is the honest baseline: GitHub runs the matrix and the agent cannot forge a check run. It is exactly the spend `local-attest` exists to avoid (`skills/local-attest/references/operator-guide.md:3-7`). A-3 saves minutes but leaves the expensive legs, the ones the gate skips (`docs/attestation.md:63`), as forgeable as today. A-3' stays the fallback for any repository that does not configure a key: with attestation enforcement off, `/merge-pr` verifies explicitly.

### A-4 — Separate-user signer

The strongest local option. The signer proves both who signed and that a real run happened, because it fetches the head from the remote and runs the matrix itself (§4). Its costs are an OS user, a service, a pinned install, and a sandbox for the matrix. On this maintainer's machine it is weaker: `wsl.exe` is on the path (`/mnt/c/WINDOWS/system32/wsl.exe`) and `/etc/wsl.conf` has no `[interop]` section, so interop is on, and WSL lets a Linux process start `wsl.exe -u root` without a password. That is documented WSL behavior; this spec did not exercise it. Root defeats any separation between two users of the same distro.

### A-5 — Human-presence key (recommended default)

A security key signs only after a physical touch. The agent can build the payload and call `ssh-keygen`, but the signature does not exist until the human acts. Setup is one key and one line in `allowed_signers`. The same verifier serves A-4, so a maintainer can move from A-5 to A-4 without a gate change.

## Recommendation

Adopt one verifier: SSH signatures over the payload line, checked against signers on the base ref (§3). Make **A-5** the default custody, because it meets the goal — the agent cannot produce believed evidence without the human — at the lowest setup cost and with zero CI minutes. Offer **A-4** as the stronger tier for machines where OS separation holds, because it also proves that the run happened. Keep **A-3'** as the fallback for repositories without a key.

## Risks

- **R-1 — Touch fatigue.** A human who touches whenever the key blinks approves whatever the agent prepared. A touch proves presence, not that the run was honest. Mitigation: the writer prints the head, the family, and the verdict before the touch (§4); Q-1 reduces touches to one per head; A-4 removes the human from the honesty question.
- **R-2 — WSL interop root.** On WSL with interop enabled, A-4's user separation does not hold (§8 A-4). Mitigation: doctor warns `EVIDENCE_WSL_INTEROP`; WSL users take A-5 unless they disable interop in `/etc/wsl.conf`.
- **R-3 — The trust root is the default branch.** The signers file is read from the base ref. An agent with the owner's admin token can push to the default branch, or change branch protection through the API, and add its own key. This spec moves forgery from "post a comment" to "change the default branch or repository settings". Those actions are conspicuous, appear in the repository's audit trail, and are narrow enough for a permission rule (`permissions.ask` on the matching `gh api` and `git push` forms). A token without admin rights for agent sessions closes it, and is out of scope here.
- **R-4 — Platform skew.** A signature made by Windows OpenSSH must verify with Linux OpenSSH. Experiment E-1 in PR-2 checks it before the WSL guidance ships.
- **R-5 — Lost or rotated keys.** Covered by OPS-3: the explicit path always remains.
- **R-6 — Old writers.** dotbabel versions before PR-1 post unsigned evidence. While a family's switch is off they keep working (AC-5); after it is on, their evidence is refused with a code that names the fix.

## Residual risk, stated plainly

- The owner can always forge. The owner holds the key and the default branch. This spec does not try to stop the owner.
- The post-pr-review receipt stays agent-asserted (§2).
- A-5 proves that a human was present, not that the run was honest. Only A-4 and A-3' prove the run.
