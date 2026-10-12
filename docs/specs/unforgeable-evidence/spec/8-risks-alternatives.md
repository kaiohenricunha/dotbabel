# §8 — Risks and Alternatives

> Why this design, what else was scored, and what risk is left.

## Alternatives

Scoring uses 0 to 3 on each axis, where 3 is best. **Agent resistance is a gate, not a weight.** An option that scores below 2 there does not meet the goal in §1, whatever its other scores. The other three axes rank the options that pass.

- **Agent resistance:** 3 = the agent cannot produce believed evidence, even with the human's token and files. 2 = it cannot without a human gesture or an OS privilege change. 1 = it can for part of the evidence. 0 = it can alone.
- **CI minutes:** 3 = no GitHub-hosted minutes. 0 = the full matrix on hosted runners for each push. The operator guide records why minutes matter: "CI minutes are billed" (`skills/local-attest/references/operator-guide.md:3-7`).
- **Solo setup:** 3 = nothing to set up. 0 = new OS users, services, and keys.
- **Consumer adoption:** 3 = works for any consumer with no new concepts. 0 = needs infrastructure most consumers will not run.

| Id   | Option                                                                                       | Agent resistance                 | CI minutes | Solo setup | Consumer adoption | Passes the gate                           |
| ---- | -------------------------------------------------------------------------------------------- | -------------------------------- | ---------- | ---------- | ----------------- | ----------------------------------------- |
| S-0  | Status quo: marker, trusted association, no-edit check, text guard                           | 0                                | 3          | 3          | 3                 | no                                        |
| A-1  | GitHub App check-run, App key on the maintainer's machine                                    | 0 to 2                           | 3          | 1          | 1                 | only with A-4's custody                   |
| A-2  | Self-hosted GitHub Actions runner as a separate OS user                                      | 2                                | 3          | 1          | 1                 | yes                                       |
| A-3  | CI-hosted cheap legs, local attestation for the expensive legs                               | 1                                | 1          | 3          | 3                 | no                                        |
| A-3' | CI-hosted full matrix, no local attestation                                                  | 3                                | 0          | 3          | 3                 | yes                                       |
| A-4  | Separate-user signer that runs the matrix itself and signs (SSH signature)                   | 2 (1 on WSL with interop)        | 3          | 0          | 1                 | yes, not on WSL                           |
| A-5  | Human-presence key: security-key SSH signature, touch per signature                          | 2 (presence only)                | 3          | 2          | 2                 | yes, see R-1                              |
| A-6  | Approval agent: plain SSH key in a desktop agent that asks in a dialog before each signature | 0 to 2 (dialog only, unmeasured) | 3          | 2          | 2                 | only if its measured facts hold, see R-11 |

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

On the maintainer's WSL host, Windows Hello cannot hold the key. Experiment E-1 (2026-10-12) found that Windows Hello refuses the `ssh-keygen.exe` enrollment with `0x80090029`, and that the phone fallback ends its tunnel with `0x800704CD` (§6 PR-2, `docs/experiments/2026-10-12-unforgeable-evidence-e1.md`). A USB security key through Windows OpenSSH is not tested on that host.

### A-6 — Approval agent (the maintainer's tier)

The key is a plain `ssh-ed25519` key that a desktop SSH agent holds. The agent shows an approval dialog before it signs. The owner chose the Bitwarden desktop SSH agent on 2026-10-12, after E-1 showed that Windows Hello cannot hold an `sk-` key on the WSL host (Q-3). From WSL, the bundle step reaches it through Windows OpenSSH (`ssh-keygen.exe`) and the Windows agent pipe (§5.5).

What it proves, scored honestly:

- **The gate verifies nothing about presence.** The signature is a plain ed25519 signature with no user-presence flag. The verifier cannot tell a signature that a human approved from one that a program approved, and KD-11's flag check does not apply.
- **Presence rests on things outside the gate.** It rests on the Bitwarden desktop approval dialog, and on the agent process not being able to change Bitwarden's settings or approve its own request. This spec has not measured either one.
- **Any WSL process can ask for a signature.** It runs `ssh-keygen.exe`, which reaches the Windows agent pipe. The only barrier is the dialog.
- **WSL interop starts Windows programs as the Windows user** (A-4). This spec has not tested whether such a program can approve the dialog or change the agent's settings.

So A-6 scores 0 to 2 on agent resistance: 2 only if all four measured facts below hold, and 0 if one of them fails. Even when they hold, A-6 is weaker than A-5, because the presence of A-5 is a flag that the gate verifies. Setup is the desktop app, one key in it, and one declaration on the trust ref, so it scores 2. A consumer can use any approval agent that shows a dialog for each signature, so adoption scores 2.

**Declaration.** The trust ref declares the key: `evidence.signer_tiers` names its fingerprint with the tier `approval-agent` (§5.1). Without the declaration, the gate refuses the key's signatures with `EVIDENCE_NO_USER_PRESENCE` (SEC-6). The declaration is a trust-root change (ARCH-6), so the agent cannot declare its own key. With it, doctor does not warn `EVIDENCE_KEY_IN_AGENT` for that key, and it reports `EVIDENCE_SIGNER_APPROVAL_AGENT` instead (§5.8). The gate output names the tier of each verified bundle (§5.7).

#### Measured facts (pending attended run)

> **Placeholder.** Fill each bullet from an attended run on the maintainer's host, with counts and log lines, before PR-3 starts (OPS-4). Do not fill it from product documentation.

- (a) **Pending.** Does the dialog appear for every signature, a second request a few seconds after the first included?
- (b) **Pending.** What does the dialog show?
- (c) **Pending.** What can a WSL process reach: the Windows agent pipe, the dialog, or both?
- (d) **Pending.** Can a WSL process write Bitwarden's settings?

## Recommendation

Adopt one verifier: one SSH signature for each head, over a bundle payload line that names the hash of each evidence payload, checked against signers on the trust ref (§3, KD-12). Make **A-5** the default custody. It meets the narrow goal (the agent cannot produce believed evidence without a human gesture) at the lowest setup cost and with zero CI minutes. Offer **A-4** as the stronger tier for machines where OS separation holds, because it also proves that the run happened. Allow **A-6** only as a declared, weaker tier (KD-13). The maintainer uses it on the WSL host, where Windows Hello cannot hold the key (E-1), until a USB security key exists there. Keep **A-3'** as the fallback for repositories without a key. Make the remote test job a required check on the default branch, so that the CI classify job (ARCH-8) has a verdict that GitHub enforces.

## Risks

- **R-1 — No trusted display.** The human has no trusted display of the bytes being signed. The key has no screen. The writer that prints the summary runs in a process the agent controls, and the agent can also call `ssh-keygen -Y sign` directly. So a touch approves whatever payload the agent prepared, and a human who touches whenever the key blinks approves anything. A-5 proves presence, not approval and not an honest run. Mitigations: a dedicated key (SEC-7), so that a blink never means a commit or a push; the bundle (KD-12), which reduces touches to one for each head and prints each family it names before the touch; and the trust-root payload, which names the key change (§5.3). The bundle has a cost too: one touch now approves every payload that it names, up to four, so a careless touch approves more than one payload. What the A-6 dialog shows is pending (§8 A-6, fact b). A-4 removes the human from the honesty question. If none of these is enough, A-5 meets the §1 goal only when the human reads a summary from a source the agent does not control.
- **R-2 — WSL interop root.** On WSL with interop enabled, A-4's user separation does not hold (§8 A-4). Mitigation: doctor warns `EVIDENCE_WSL_INTEROP`; WSL users take A-5 with a USB security key, or the weaker A-6, unless they disable interop in `/etc/wsl.conf`. Windows Hello is not an A-5 option from WSL (E-1).
- **R-3 — The trust root can change.** A pull request can try to change the trust root: add a key to the signers file, set a switch to `false`, or remove the `evidence` block. Each of these costs zero touches today. The trust-root rule closes that path: such a pull request needs a trust-root payload that a bundle from a trust-ref signer names, or the merge gate blocks it (ARCH-6, AC-9). The remaining risk: an admin token can push to the default branch directly, change branch protection, or merge with `gh pr merge --admin`, and none of these passes through the gate. These are audited settings changes or direct pushes, outside the pull-request flow. A `permissions.ask` rule does not close them, because the agent can reach the same API with `curl` and `gh auth token`, or from a Node script. §1 makes the same argument against text guards. A token without admin rights for agent sessions closes this risk, and it is out of scope here.
- **R-4 — Platform skew.** A signature made by Windows OpenSSH must verify with Linux OpenSSH. Experiment E-1 (2026-10-12) did not reach a signature, because Windows Hello refused the enrollment and no key was made (§6 PR-2). The question is still open. The A-6 bundle step signs with Windows `ssh-keygen.exe`, and the verifier runs Linux `ssh-keygen` (§5.5). So one A-6 signature must verify with Linux `ssh-keygen` before PR-3 starts (§6, entry condition).
- **R-5 — Lost or rotated keys.** Covered by OPS-3: a second enrolled key signs the trust-root change, and the R-3 path remains when every key is lost.
- **R-6 — Old writers.** dotbabel versions before PR-1b post evidence without `scope`, and they have no bundle step. While a family's switch is off they keep working (AC-5), and no `config_hash` changes (§5.1). After it is on, no bundle names their comments, because the bundle step names only payloads that carry `scope` (§4). So their attestation goes to `explicit`, and their criteria evidence is refused with a code that names the fix.
- **R-7 — The local verifier runs as the agent.** The merge gate and `pr-stack entry` run as the agent's UID, from an install the agent can edit. ARCH-7 closes `git replace`, redirected object stores, and a `PATH` shadow of `ssh-keygen`. It cannot close an edit to the dotbabel checkout or to the git object files. A local verdict is only as trustworthy as the local install (§2 Boundaries).
- **R-8 — Stacked bases.** The base of a stacked pull request is a feature branch that the agent can push to. Fixed by KD-9: the gate reads trust configuration from the default branch only (AC-11).
- **R-9 — Deleted comments.** The gate cannot see a deleted comment. If the owner's token deletes a newer signed `fail`, an older signed `pass` for the same head becomes the newest comment that verifies. A human touched both for that head, so the agent cannot make a pass alone. It can hide a later fail. No design based on comments can detect a deletion. With bundles, deleting a bundle comment unsigns every family that it names until a new bundle exists; that is a denial, not a forgery. A later comment for the same head that no bundle names does not replace an earlier one that a verified bundle names, because the gate selects the newest named comment (§5.7). The agent could already hide a later result by not posting it.
- **R-10 — The CI workflow comes from the pull request.** The `pull_request` trigger loads the classify step from the pull request. A pull request that edits the step can force a skip of the remote test job. ARCH-8 makes the workflow file governed, so such a pull request lands on `explicit` at the merge gate (AC-16). But the merge gate is local (R-7), and GitHub reads a skipped required check as a success. So the classify step is a control only for a pull request that does not edit its workflow. Q-4 records the stronger option.
- **R-11 — The approval agent rests on a dialog.** With A-6, the gate cannot verify presence (KD-13). Any WSL process can ask the Windows agent for a signature through `ssh-keygen.exe`, and only the dialog stands between that request and a believed signature. If a WSL process can approve the dialog, or can write Bitwarden's settings so that no dialog appears, A-6 scores 0 on agent resistance. Mitigations: the four measured facts under A-6 must be recorded and hold before PR-3 starts (OPS-4); doctor reports the tier as weaker (§5.8); and the gate output names the tier. A USB security key (A-5) removes this risk.

## Residual risk, stated plainly

- The owner can always forge. The owner holds the key and the default branch. This spec does not try to stop the owner.
- The post-pr-review receipt stays agent-asserted. A signed review-complete comment proves that a human was present, not that a review ran (§2).
- A-5 proves that a human touched the key. It does not prove that the human saw or approved the payload, and it does not prove the run. Only A-4 and A-3' prove the run.
- A-6 proves presence only if a dialog that the gate cannot check holds (R-11). Its measured facts are pending.
- An admin token can go around every gate with a direct push, a settings change, or an admin merge (R-3).
- The local gate is not an enforcement point against an agent that edits its verifier (R-7). The CI classify job is not one against a pull request that edits its workflow (R-10).
- The gate cannot see a deleted comment (R-9).
