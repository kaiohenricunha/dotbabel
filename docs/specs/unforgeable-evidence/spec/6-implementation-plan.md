# §6 — Implementation Plan

> Three phases. Phase 1 takes two pull requests (PR-1a and PR-1b), and phase 3 takes several. Each pull request leaves the gate in a working state.

## PR-1a — The verifier, pure and testable without GitHub

- Add `plugins/dotbabel/src/lib/evidence-signature.mjs`: sign, parse, the SSHSIG flag reader for `sk-` signers (KD-11), the signer-tier check (KD-13), the signers-line filter (§5.4), the bundle payload and the payload-line hash (§5.6), the capability probe (REL-1), and verify through `deps.run`.
- Give `deps.run` the `input` option, and give the real runner the cleaned git environment and `--no-replace-objects` (ARCH-2, ARCH-7).
- Add the `evidence` block, with `signer_tiers`, to `schemas/dotbabel.config.schema.json`. Add `scope` to the three evidence schemas, and add the trust-root and bundle schemas.
- Add `plugins/dotbabel/bin/dotbabel-evidence.mjs` with `verify` over explicit inputs (`--comments`, `--signers`, `--policy`, §5.9). It reads nothing from GitHub and no trust ref.
- Experiment E-2 is deferred until a hardware key exists (owner decision, 2026-10-12). The flag reader ships with test vectors only. Before this repository enrolls an `sk-` signer, E-2 records, with a real authenticator: (a) that a key handle with the no-touch-required flag signs without a touch and leaves the user-presence flag clear, (b) whether `ssh-keygen -Y verify` accepts such a signature, and (c) where the flags byte sits in the SSHSIG blob. Two of these are claims from the review of this spec, not tested facts.
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
- `docs/attestation.md` gains a custody section: a dedicated security key on Linux and macOS (`ssh-keygen -t ed25519-sk`, without `-O no-touch-required`), two enrolled keys (OPS-3), the separate-user signer recipe (§4) as an optional tier, and the approval-agent tier (§8 A-6) with its `evidence.signer_tiers` declaration and its limits.
- Experiment E-1 ran on 2026-10-12, before the WSL guidance (`docs/experiments/2026-10-12-unforgeable-evidence-e1.md`). The question was whether Windows OpenSSH (`ssh-keygen.exe`), started from WSL, can hold an `sk-` key in Windows Hello. **Result: no.** In all three attended attempts, Windows Hello (Ngc) `MakeCredential` returned `0x80090029` "The requested operation is not supported" for the `ssh-keygen.exe` request. The same Windows dialog appeared for `ed25519-sk` and `ecdsa-sk`. Windows then fell back to the phone (hybrid, QR) flow, and the phone ended each tunnel 1 to 4 s after setup with `0x800704CD`. No key file was made. The inference, not proven, is that phone passkey providers refuse the relying-party ID `ssh:`.
- E-1 never reached a signature with Windows Hello. The attended A-6 run did, and its Windows signature verified with Linux `ssh-keygen` (R-4 for A-6, §8 A-6 fact (c)). `usbipd-win` is absent on the host, and the host has no USB security key, so neither USB route was tested.

**Exit state.** A maintainer can hold a key that the agent cannot use alone (A-5, A-4), or a declared approval-agent key that doctor reports as weaker (A-6). Doctor says when a key or a signer line does not meet that bar.

## PR-3 — Enforce per family where the switch is on

**Entry condition (OPS-4).** PR-3 does not start until one custody tier works on the maintainer's main machine, which runs WSL with interop on (§8 A-4). E-1 showed that Windows Hello does not (Q-3). The owner chose the A-6 approval agent (KD-13). A-6 counts as working when all four of its measured facts are recorded and hold (§8 A-6), and one bundle signature from Windows OpenSSH verifies with Linux `ssh-keygen` (R-4). A USB security key through `ssh-keygen.exe` (A-5) also counts when it signs with the user-presence flag and verifies; it is not tested on this host. The pull request records the run. Without a working tier, every unsigned attestation goes to `explicit` (KD-10), which costs an explicit run on each merge but blocks nothing.

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
- **Q-3 — decided 2026-10-12: no.** Windows Hello cannot hold an OpenSSH `sk-` key from WSL on the maintainer's host (E-1, PR-2). The owner chose the A-6 approval agent for that host (KD-13, §8 A-6).
- **Q-4.** Should the classify decision move to a job that GitHub loads from the base branch, so that a pull request cannot edit it? The options are a `pull_request_target` job that never checks out or runs head code, and a workflow that a ruleset requires. The first conflicts with the template rule against `pull_request_target` (`plugins/dotbabel/tests/workflow-templates.test.mjs:88-94`). The second needs an organization ruleset. Either one would remove R-10.
