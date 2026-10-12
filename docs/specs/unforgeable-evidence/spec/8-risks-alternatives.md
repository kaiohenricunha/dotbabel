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
| A-5  | Human-presence key: security-key SSH signature, touch per signature        | 2 (presence only)         | 3          | 2          | 2                 | yes, see R-1            |

### A-1 — GitHub App check-run

Only a GitHub App can create a check run, and a gate can pin the check run to the App's ID. A personal token can still create a commit **status** with any name, so the gate must read check runs by App ID and never statuses. The weak point is the App's private key. If it is a file the human's UID can read, the agent reads it and the score is 0. If a separate user holds it, the option inherits A-4's custody and adds a registered App on top. It is a publisher, not a custody answer.

### A-2 — Self-hosted runner as a separate OS user

Jobs on a self-hosted runner use no GitHub-hosted minutes, and the agent cannot author a check run as the GitHub Actions App. Two problems remain. The workflow file comes from the pull request head, so a pull request can rewrite the job; `.github/workflows/**` must be governed so that such a pull request lands on the explicit path. The same problem applies to this design's own CI classify job (ARCH-8, R-10). And this repository is public, so a fork's pull request can run code on the maintainer's machine unless fork workflows need approval. On WSL it has A-4's interop weakness.

### A-3 and A-3' — CI-hosted verification

A-3' is the honest baseline: GitHub runs the matrix and the agent cannot forge a check run. It is exactly the spend that `local-attest` exists to avoid (`skills/local-attest/references/operator-guide.md:3-7`). A-3 saves minutes but leaves the expensive legs, the ones the gate skips (`docs/attestation.md:63`), as forgeable as today. A-3' stays the fallback for any repository that does not configure a key: with attestation enforcement off, `/merge-pr` verifies explicitly.

### A-4 — Separate-user signer

The strongest local option. The signer proves both who signed and that a real run happened, because it fetches the head from the remote and runs the matrix itself (§4). It needs no human approval of the bytes. Its costs are an OS user, a service, a pinned install, and a sandbox for the matrix. On this maintainer's machine it is weaker: `wsl.exe` is on the path (`/mnt/c/WINDOWS/system32/wsl.exe`) and `/etc/wsl.conf` has no `[interop]` section, so interop is on, and WSL lets a Linux process start `wsl.exe -u root` without a password. That is documented WSL behavior; this spec did not exercise it. Root defeats any separation between two users of the same distribution.

### A-5 — Human-presence key (recommended default)

A security key signs only after a physical touch, and the authenticator signs a user-presence flag with the data. The verifier refuses a signature without that flag (KD-11). The agent can build the payload and call `ssh-keygen`, but a believed signature does not exist until the human acts. The touch is not bound to the content, because the key has no display (R-1). So A-5 scores 2 under the rubric ("cannot without a human gesture"), with the qualifier "presence only". Setup is one key and one line in `allowed_signers`. The same verifier serves A-4, so a maintainer can move from A-5 to A-4 without a gate change.

## Recommendation

Adopt one verifier: SSH signatures over the payload line, checked against signers on the trust ref (§3). Make **A-5** the default custody. It meets the narrow goal (the agent cannot produce believed evidence without a human gesture) at the lowest setup cost and with zero CI minutes. Offer **A-4** as the stronger tier for machines where OS separation holds, because it also proves that the run happened. Keep **A-3'** as the fallback for repositories without a key. Make the remote test job a required check on the default branch, so that the CI classify job (ARCH-8) has a verdict that GitHub enforces.

## Risks

- **R-1 — No trusted display.** The human has no trusted display of the bytes being signed. The key has no screen. The writer that prints the summary runs in a process the agent controls, and the agent can also call `ssh-keygen -Y sign` directly. So a touch approves whatever payload the agent prepared, and a human who touches whenever the key blinks approves anything. A-5 proves presence, not approval and not an honest run. Mitigations: a dedicated key (SEC-7), so that a blink never means a commit or a push; Q-1, which reduces touches to one for each head; and the trust-root payload, which names the key change (§5.3). A-4 removes the human from the honesty question. If none of these is enough, A-5 meets the §1 goal only when the human reads a summary from a source the agent does not control.
- **R-2 — WSL interop root.** On WSL with interop enabled, A-4's user separation does not hold (§8 A-4). Mitigation: doctor warns `EVIDENCE_WSL_INTEROP`; WSL users take A-5 unless they disable interop in `/etc/wsl.conf`.
- **R-3 — The trust root can change.** A pull request can try to change the trust root: add a key to the signers file, set a switch to `false`, or remove the `evidence` block. Each of these costs zero touches today. The trust-root rule closes that path: such a pull request needs a trust-root signature from a trust-ref signer, or the merge gate blocks it (ARCH-6, AC-9). The remaining risk: an admin token can push to the default branch directly, change branch protection, or merge with `gh pr merge --admin`, and none of these passes through the gate. These are audited settings changes or direct pushes, outside the pull-request flow. A `permissions.ask` rule does not close them, because the agent can reach the same API with `curl` and `gh auth token`, or from a Node script. §1 makes the same argument against text guards. A token without admin rights for agent sessions closes this risk, and it is out of scope here.
- **R-4 — Platform skew.** A signature made by Windows OpenSSH must verify with Linux OpenSSH. Experiment E-1 in PR-2 checks it before the WSL guidance ships.
- **R-5 — Lost or rotated keys.** Covered by OPS-3: a second enrolled key signs the trust-root change, and the R-3 path remains when every key is lost.
- **R-6 — Old writers.** dotbabel versions before PR-1 post unsigned evidence. While a family's switch is off they keep working (AC-5), and no `config_hash` changes (§5.1). After it is on, their attestation goes to `explicit`, and their criteria evidence is refused with a code that names the fix.
- **R-7 — The local verifier runs as the agent.** The merge gate and `pr-stack entry` run as the agent's UID, from an install the agent can edit. ARCH-7 closes `git replace`, redirected object stores, and a `PATH` shadow of `ssh-keygen`. It cannot close an edit to the dotbabel checkout or to the git object files. A local verdict is only as trustworthy as the local install (§2 Boundaries).
- **R-8 — Stacked bases.** The base of a stacked pull request is a feature branch that the agent can push to. Fixed by KD-9: the gate reads trust configuration from the default branch only (AC-11).
- **R-9 — Deleted comments.** The gate cannot see a deleted comment. If the owner's token deletes a newer signed `fail`, an older signed `pass` for the same head becomes the newest comment that verifies. A human touched both for that head, so the agent cannot make a pass alone. It can hide a later fail. No design based on comments can detect a deletion.
- **R-10 — The CI workflow comes from the pull request.** The `pull_request` trigger loads the classify step from the pull request. A pull request that edits the step can force a skip of the remote test job. ARCH-8 makes the workflow file governed, so such a pull request lands on `explicit` at the merge gate (AC-16). But the merge gate is local (R-7), and GitHub reads a skipped required check as a success. So the classify step is a control only for a pull request that does not edit its workflow. Q-4 records the stronger option.

## Residual risk, stated plainly

- The owner can always forge. The owner holds the key and the default branch. This spec does not try to stop the owner.
- The post-pr-review receipt stays agent-asserted. A signed review-complete comment proves that a human was present, not that a review ran (§2).
- A-5 proves that a human touched the key. It does not prove that the human saw or approved the payload, and it does not prove the run. Only A-4 and A-3' prove the run.
- An admin token can go around every gate with a direct push, a settings change, or an admin merge (R-3).
- The local gate is not an enforcement point against an agent that edits its verifier (R-7). The CI classify job is not one against a pull request that edits its workflow (R-10).
- The gate cannot see a deleted comment (R-9).
