# §6 — Implementation Plan

> Three phases. Phase 1 takes two pull requests (PR-1a and PR-1b), and phase 3 takes several. Each pull request leaves the gate in a working state.

## Status: parked, not scheduled (owner decision, 2026-10-12)

dotbabel does not implement signed evidence. This spec is parked as an opt-in design that stays default-off and is not planned for dotbabel. PR-1a, PR-1b, PR-2, and PR-3 are not scheduled, and no acceptance criterion is activated. The owner prefers that a generic open-source tool require no hardware key and no password manager. dotbabel takes a softer path instead: a spot-check re-verification at merge, and an alarm when CI on the default branch contradicts an attestation. A separate, new spec covers that path. The plan below stays as the design record, with the E-1 and A-6 results and the casual-only A-6 decision (§8 A-6). The review findings that would change the parked design are listed, not applied, under "Review findings not pursued" at the end of §6.

## PR-1a — The verifier, pure and testable without GitHub

- Add `plugins/dotbabel/src/lib/evidence-signature.mjs`: sign, parse, the SSHSIG flag reader for `sk-` signers (KD-11), the signer-tier check (KD-13), the signers-line filter (§5.4), the bundle payload and the payload-line hash (§5.6), the capability probe (REL-1), and verify through `deps.run`.
- Give `deps.run` the `input` option, and give the real runner the cleaned git environment and `--no-replace-objects` (ARCH-2, ARCH-7).
- Add the `evidence` block, with `signer_tiers`, to `schemas/dotbabel.config.schema.json`. Add `scope` to the three evidence schemas, and add the trust-root and bundle schemas.
- Add `plugins/dotbabel/bin/dotbabel-evidence.mjs` with `verify` over explicit inputs (`--comments`, `--signers`, `--policy`, §5.9). It reads nothing from GitHub and no trust ref.
- Experiment E-2 is deferred until a hardware key exists (owner decision, 2026-10-12). The owner does not plan one on the maintainer's host. The flag reader ships with test vectors only. Before this repository enrolls an `sk-` signer, E-2 records, with a real authenticator: (a) that a key handle with the no-touch-required flag signs without a touch and leaves the user-presence flag clear, (b) whether `ssh-keygen -Y verify` accepts such a signature, and (c) where the flags byte sits in the SSHSIG blob. Two of these are claims from the review of this spec, not tested facts.
- Activate AC-10, AC-14, and AC-18 (`status: planned` to `active`) in this pull request, with their tests. Their tests drive the shared verifier with a recording `deps.run`.

**Exit state.** No gate calls the new module yet, so no gate output changes. The verifier and its codes are tested without a key, a network, or GitHub.

## PR-1b — Wire the verifier into the gates, behind switches that default to off

- Add `evidenceGateInputs`: the trust ref (§5.2), the `evidence` block, the signers, the current bundles, and the trust-root change (§5.3). Call it from `gatherMergeGate` and from `reviewEntryFacts`.
- Add the signature rung to the three ladders and to `hasCurrentAttestation`. Add the trust-root rung to `checkMergeGate`. Map `EVIDENCE_UNSIGNED` to `explicit` in `attestationStatus` (KD-10).
- Add `scope` to the three payload builders. The family writers post lines 1 and 2, and never sign.
- Add the bundle writer, `dotbabel evidence bundle --pr <N>`, and the trust-root writer, `dotbabel evidence trust-root --pr <N>`. Add `--pr <N>` to `dotbabel evidence verify`, which gathers its inputs through `evidenceGateInputs` (§5.9).
- Activate AC-1 to AC-5, AC-9, AC-11 to AC-13, and AC-17 in this pull request, with their tests.

**Exit state.** No repository behaves differently until its trust ref sets a switch or enrolls a signer. A family comment that a verified bundle names is verified, and a failure is a visible warning before anyone depends on it (§5.7).

## PR-2 — Key custody and doctor

- Doctor findings from §5.8, the approval-agent tier and the Windows agent check on WSL included. Activate AC-7, AC-15, and AC-19.
- `docs/attestation.md` gains a custody section: a dedicated security key on Linux and macOS (`ssh-keygen -t ed25519-sk`, without `-O no-touch-required`), two enrolled keys (OPS-3), the separate-user signer recipe (§4) as an optional tier, and the approval-agent tier (§8 A-6) as casual-only, with its `evidence.signer_tiers` declaration and its limits.
- Experiment E-1 ran on 2026-10-12, before the WSL guidance (`docs/experiments/2026-10-12-unforgeable-evidence-e1.md`). The question was whether Windows OpenSSH (`ssh-keygen.exe`), started from WSL, can hold an `sk-` key in Windows Hello. **Result: no.** In all three attended attempts, Windows Hello (Ngc) `MakeCredential` returned `0x80090029` "The requested operation is not supported" for the `ssh-keygen.exe` request. The same Windows dialog appeared for `ed25519-sk` and `ecdsa-sk`. Windows then fell back to the phone (hybrid, QR) flow, and the phone ended each tunnel 1 to 4 s after setup with `0x800704CD`. No key file was made. The inference, not proven, is that phone passkey providers refuse the relying-party ID `ssh:`.
- E-1 never reached a signature with Windows Hello. The attended A-6 run did, and its Windows signature verified with Linux `ssh-keygen` (R-4 for A-6, §8 A-6 fact (c)). `usbipd-win` is absent on the host, and the host has no USB security key, so neither USB route was tested. The owner does not plan a FIDO or USB security key on that host (owner decision, 2026-10-12).

**Exit state.** A maintainer can hold a key that the agent cannot use alone (A-5, A-4), or a declared approval-agent key that doctor reports as casual-only (A-6). Doctor says when a key or a signer line does not meet that bar.

## PR-3 — Enforce per family where the switch is on

**Entry condition (OPS-4).** PR-3 does not start until a custody tier works on the maintainer's main machine, which runs WSL with interop on (§8 A-4), or the owner accepts a tier below the §1 goal on the record. E-1 showed that Windows Hello cannot hold a key there (Q-3), and the owner does not plan an A-5 security key on that host. So, on that host, PR-3 may proceed on A-6 only as an owner-accepted tier below the §1 goal (owner decisions, 2026-10-12, §8 A-6). A-6 scores 0 on agent resistance there: fact (d) fails, and fact (e) is untested and likely fails. On A-6, PR-3 starts only when all of these hold:

1. Facts (a) and (c) pass, as measured (§8 A-6).
2. One bundle in the PR-1b format, signed through the Bitwarden agent with Windows OpenSSH, verifies with Linux `ssh-keygen` (R-4).
3. The PR-3a pull request records the acceptance in its body, and names facts (b) and (d) as failed and fact (e) as untested.
4. The gate output and doctor name the tier casual-only (§5.7, §5.8).

On that host, the evidence gate then stops casual or accidental agent signing only, and a determined agent on the same Windows account can defeat it. A USB security key through `ssh-keygen.exe` (A-5) meets the §1 goal when it signs with the user-presence flag and verifies; it is not tested on this host, and the owner does not plan it. Without an accepted tier, every unsigned attestation goes to `explicit` (KD-10), which costs an explicit run on each merge but blocks nothing.

- **PR-3a, bootstrap.** Add `.dotbabel-allowed-signers` with two keys, and the `evidence` block with every switch off and a `signer_tiers` entry for each approval-agent key. Add `.github/workflows/test.yml` to this repository's `attestation.governance_files` (ARCH-8), and activate AC-16. The trust ref has no signer yet, so this pull request lands unsigned on the explicit path, once (§5.3).
- **PR-3b, attestation.** Flip `evidence.require_signature.attestation`. This is a trust-root change, so it needs the first real bundle that names a trust-root payload (AC-9).
- The CI classify job in `.github/workflows/test.yml` and in its template checks out the trust ref and runs `dotbabel evidence verify` (ARCH-8). Activate AC-8.
- `commands/merge-pr.md` gains a recovery line for each `EVIDENCE_*` code, and the `explicit` path for `EVIDENCE_UNSIGNED` without a governed-file diff.
- Flip `criteria`, then `review`, one pull request each, after one week of clean attestation runs. Each flip is a trust-root change. Activate AC-6.
- Demote `guard-criteria-evidence.sh` to hygiene (KD-8) in all three byte-identical copies, add the trust-root and bundle markers to its list, and update `docs/hooks.md:41-50` to say what now carries the security claim.
- In the next major release after PR-3, the default of each switch becomes `true` for a repository whose trust ref declares an `allowed_signers` file. Unsigned evidence stays readable for repositories that never adopt a key, and those repositories keep today's behavior and today's documented limit.

## Migration rule

While a family's switch is off, the gate accepts both unsigned and signed evidence, and a failing signature is only a warning (AC-5). Once the switch is on, a family accepts only signed evidence for a skip (AC-2). Unsigned attestation then goes to `explicit`, so a pull request without a touch is verified explicitly and not blocked. Criteria evidence that no bundle names blocks until `dotbabel evidence bundle` runs with a key. Review-complete evidence that no bundle names only stops the skip. No state accepts neither form. So the migration itself blocks no pull request for attestation or review. Criteria evidence needs one bundle for each head, and that is why PR-3 does not start before a custody tier works (OPS-4).

## Mapping

| PR    | Criteria                                  | Files (see `spec.json` `linked_paths`)                                                                                                                                                                                                                                  |
| ----- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR-1a | AC-10, AC-14, AC-18                       | `plugins/dotbabel/src/lib/evidence-signature.mjs`, `plugins/dotbabel/bin/dotbabel-evidence.mjs` (`verify` over files), the `deps.run` seam in `plugins/dotbabel/bin/dotbabel-pr-stack.mjs`, `plugins/dotbabel/src/attestation-gate-inputs.mjs` (git hardening), schemas |
| PR-1b | AC-1 to AC-5, AC-9, AC-11 to AC-13, AC-17 | payload builders, ladders, gathers, `plugins/dotbabel/src/pr-gates.mjs`, `plugins/dotbabel/src/review-gate-inputs.mjs`, `plugins/dotbabel/bin/dotbabel-evidence.mjs` (`bundle`, `trust-root`, `verify --pr`), `plugins/dotbabel/bin/dotbabel-pr-stack.mjs`              |
| PR-2  | AC-7, AC-15, AC-19                        | `plugins/dotbabel/bin/dotbabel-doctor.mjs`, `docs/attestation.md`                                                                                                                                                                                                       |
| PR-3  | AC-6, AC-8, AC-16                         | `.github/workflows/test.yml`, `plugins/dotbabel/templates/workflows/test.yml`, `commands/merge-pr.md`, the three guard copies, `docs/hooks.md`                                                                                                                          |

## Open questions

- **Q-1 — decided 2026-10-12: one touch for each pull-request head.** A bundle signature names the payload hash of each family, and of the trust-root payload when the pull request changes the trust root (KD-12, §5.6). The family writers stay separate commands, and one final bundle step signs. PR-1b builds the bundle writer.
- **Q-2.** Does criteria evidence need human presence, or is a separate-user signer enough for it? Criteria argv runs repository code, which is exactly what the separate-user tier is built for. Also decide whether `evidence.require_signature.review` is worth turning on. With the bundle it costs no extra touch, but a signed review-complete comment proves presence and not a review (§2).
- **Q-3 — decided 2026-10-12: no.** Windows Hello cannot hold an OpenSSH `sk-` key from WSL on the maintainer's host (E-1, PR-2). The owner chose the A-6 approval agent for that host (KD-13, §8 A-6). After the A-6 run, the owner accepted it as a casual-only tier, with no A-5 security key planned there, and then parked this spec (Status, above).
- **Q-4.** Should the classify decision move to a job that GitHub loads from the base branch, so that a pull request cannot edit it? The options are a `pull_request_target` job that never checks out or runs head code, and a workflow that a ruleset requires. The first conflicts with the template rule against `pull_request_target` (`plugins/dotbabel/tests/workflow-templates.test.mjs:88-94`). The second needs an organization ruleset. Either one would remove R-10.

## Review findings not pursued (spec parked)

The four-reviewer pass of the amendment (#463, 2026-10-12) found these design gaps. The spec is parked, so they are recorded here for a revival and not applied. Each one names its reviewer.

- **A newer unbundled comment hides behind an older bundled one** (architecture). With the switch on, the gate picks the newest comment that a bundle names (§5.7), so an honest `fail` posted after the bundle loses to the older bundled `pass`. Fix: a newer current comment that no bundle names makes the family unsigned (`explicit` for attestation); add that case to AC-17, and update PERF-1, §4, and R-9.
- **AC-13 tests PR-1a work but activates in PR-1b** (architecture). PR-1a changes the git argv and environment of the live attestation gather and the real runner. Fix: split AC-13 into an attestation-gather AC for PR-1a and an evidence-gather AC for PR-1b.
- **The trust-root payload rides in the routine bundle** (architecture, security). One content-blind approval can then enroll an agent-held key as `approval-agent` for good (§8 R-3). Fix: sign a trust-root payload only in its own bundle, and require a dedicated trust-root key (for example `dotbabel-trust-root`, so that the dialog names the operation), an `sk-` signer, or two distinct signers for a change that adds a signer line or a `signer_tiers` entry; update KD-12, KD-13, §5.3, SEC-8, OPS-2, OPS-3, and AC-9.
- **`evidence verify` over files lacks the inputs its exit rule needs** (architecture). The stale rung needs a head SHA, and the scope check needs the repository, the pull request, and the family. Fix: add `--head --repo --pr --family` to the file form (§5.9), and add a PR-1a AC that runs the command.
- **No pull request wires the bundle step into the pipeline** (architecture). Fix: a PR-3 bullet and mapping entry that run `dotbabel evidence bundle` at the end of pr-conductor phase 5 when the owner is present, a `/merge-pr` recovery path for `EVIDENCE_UNSIGNED`, and `skills/pr-conductor/SKILL.md`, `commands/merge-pr.md`, and their template and example copies in `linked_paths`.
- **The approval-agent key needs a vault setting** (security). §5.5 now states that the Bitwarden key is a vault item. Fix: require Bitwarden's per-item "Master password re-prompt" on the evidence key, and measure whether the item can leave the vault without a fresh prompt.
- **A tier declaration silences `EVIDENCE_KEY_IN_AGENT` in every agent** (security). Fix: omit the finding only for the Windows agent pipe on WSL while the Windows `ssh-agent` service is disabled, always warn when `ssh-add -L` through `SSH_AUTH_SOCK` lists a declared key, and add those negative cases to AC-19.
- **`require_user_verification` does not constrain non-sk signers** (security). Fix: when it is true, refuse `approval-agent` and `unattended` signatures with `EVIDENCE_NO_USER_PRESENCE` (§5.1, §5.7, SEC-6, AC-18).
- **AC-19 omits the kept signer line that both doctor findings need** (compliance). Fix: add "the signers file has a kept line for K" to the AC-19 given, as AC-18 has it.
- **AC-4 and AC-17 assert attestation states without `attestation.enforce true`** (compliance). `attestationStatus` returns `off` without it (`plugins/dotbabel/src/pr-gates.mjs:533-535`). Fix: add `attestation.enforce true` to both givens.
- **`DOTBABEL_EVIDENCE_SSH_KEYGEN` is used but not defined** (documentation). Fix: define it in §5.5 and §5.9 (default `ssh-keygen`; on WSL, for example, `/mnt/c/Windows/System32/OpenSSH/ssh-keygen.exe`; the bundle step reads it, the verifier never does), and name it in the PR-1b plan.
