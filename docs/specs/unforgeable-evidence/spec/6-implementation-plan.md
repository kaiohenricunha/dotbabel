# §6 — Implementation Plan

> Three phases. Each phase leaves the gate in a working state. Phase 3 takes several pull requests.

## PR-1 — Verify, behind switches that default to off

- Add `plugins/dotbabel/src/lib/evidence-signature.mjs`: sign, parse, the SSHSIG flag reader (KD-11), the signers-line filter (§5.4), the capability probe (REL-1), and verify through `deps.run`.
- Give `deps.run` the `input` option, and give the real runner the cleaned git environment and `--no-replace-objects` (ARCH-2, ARCH-7).
- Add `evidenceGateInputs`: the trust ref (§5.2), the `evidence` block, the signers, and the trust-root change (§5.3). Call it from `gatherMergeGate` and from `reviewEntryFacts`.
- Add `scope` to the three payload builders, and an optional line 3 to the three renderers. Writers sign when `DOTBABEL_EVIDENCE_KEY` is set, and post unsigned otherwise.
- Add the signature rung to the three ladders and to `hasCurrentAttestation`. Add the trust-root rung to `checkMergeGate`. Map `EVIDENCE_UNSIGNED` to `explicit` in `attestationStatus` (KD-10).
- Add `plugins/dotbabel/bin/dotbabel-evidence.mjs` with `verify` and `trust-root` (§5.9).
- Add the `evidence` block to `schemas/dotbabel.config.schema.json`, `scope` to the three evidence schemas, and the trust-root schema.
- Run experiment E-2 before the flag reader merges: with a real authenticator, record (a) that a key handle with the no-touch-required flag signs without a touch and leaves the user-presence flag clear, (b) whether `ssh-keygen -Y verify` accepts such a signature, and (c) where the flags byte sits in the SSHSIG blob. Two of these are claims from the review of this spec, not tested facts.
- Activate AC-1 to AC-5 and AC-9 to AC-14 (`status: planned` to `active`) in the same pull request that adds their tests.

**Exit state.** No repository behaves differently until its trust ref sets a switch or enrolls a signer. A signed comment is verified when it is present, and a failure is a visible warning before anyone depends on it (§5.7).

## PR-2 — Key custody and doctor

- Doctor findings from §5.8. Activate AC-7 and AC-15.
- `docs/attestation.md` gains a custody section: a dedicated security key on Linux and macOS (`ssh-keygen -t ed25519-sk`, without `-O no-touch-required`), two enrolled keys (OPS-3), and the separate-user signer recipe (§4) as an optional tier.
- Run experiment E-1 before the WSL guidance is written: sign with Windows OpenSSH (`ssh-keygen.exe`) through Windows Hello from inside WSL, verify the signature with Linux `ssh-keygen`, and record whether a WSL process can complete the Windows Hello prompt without the human. Also record whether a USB security key that `usbipd-win` attaches to WSL2 signs with the user-presence flag. The result decides which tier WSL users get.

**Exit state.** A maintainer can hold a key that the agent cannot use alone, and doctor says when a key or a signer line does not meet that bar.

## PR-3 — Enforce per family where the switch is on

**Entry condition (OPS-4).** PR-3 does not start until one custody tier works on the maintainer's main machine, which runs WSL with interop on (§8 A-4). E-1 passes, or a security key attached through `usbipd-win` signs with the user-presence flag and verifies. The pull request records the run. Without a working tier, every unsigned attestation goes to `explicit` (KD-10), which costs an explicit run on each merge but blocks nothing.

- **PR-3a, bootstrap.** Add `.dotbabel-allowed-signers` with two keys, and the `evidence` block with every switch off. Add `.github/workflows/test.yml` to this repository's `attestation.governance_files` (ARCH-8), and activate AC-16. The trust ref has no signer yet, so this pull request lands unsigned on the explicit path, once (§5.3).
- **PR-3b, attestation.** Flip `evidence.require_signature.attestation`. This is a trust-root change, so it needs the first real trust-root signature (AC-9).
- The CI classify job in `.github/workflows/test.yml` and in its template checks out the trust ref and runs `dotbabel evidence verify` (ARCH-8). Activate AC-8.
- `commands/merge-pr.md` gains a recovery line for each `EVIDENCE_*` code, and the `explicit` path for `EVIDENCE_UNSIGNED` without a governed-file diff.
- Flip `criteria`, then `review`, one pull request each, after one week of clean attestation runs. Each flip is a trust-root change. Activate AC-6.
- Demote `guard-criteria-evidence.sh` to hygiene (KD-8) in all three byte-identical copies, add the trust-root marker to its list, and update `docs/hooks.md:41-50` to say what now carries the security claim.
- In the next major release after PR-3, the default of each switch becomes `true` for a repository whose trust ref declares an `allowed_signers` file. Unsigned evidence stays readable for repositories that never adopt a key, and those repositories keep today's behavior and today's documented limit.

## Migration rule

While a family's switch is off, the gate accepts both unsigned and signed evidence, and a failing signature is only a warning (AC-5). Once the switch is on, a family accepts only signed evidence for a skip (AC-2). Unsigned attestation then goes to `explicit`, so a pull request without a touch is verified explicitly and not blocked. Unsigned criteria evidence blocks until `criteria verify --post` runs with a key. Unsigned review-complete evidence only stops the skip. No state accepts neither form. So the migration itself blocks no pull request for attestation or review. Criteria evidence needs one signed run, and that is why PR-3 does not start before a custody tier works (OPS-4).

## Mapping

| PR   | Criteria                    | Files (see `spec.json` `linked_paths`)                                                                                                                                                     |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PR-1 | AC-1 to AC-5, AC-9 to AC-14 | `plugins/dotbabel/src/lib/evidence-signature.mjs`, payload builders, ladders, gathers, `plugins/dotbabel/bin/dotbabel-evidence.mjs`, `plugins/dotbabel/bin/dotbabel-pr-stack.mjs`, schemas |
| PR-2 | AC-7, AC-15                 | `plugins/dotbabel/bin/dotbabel-doctor.mjs`, `docs/attestation.md`                                                                                                                          |
| PR-3 | AC-6, AC-8, AC-16           | `.github/workflows/test.yml`, `plugins/dotbabel/templates/workflows/test.yml`, `commands/merge-pr.md`, the three guard copies, `docs/hooks.md`                                             |

## Open questions

- **Q-1.** One touch for each head, or one for each family? Today a pull request can produce three evidence comments, so up to three touches. A bundle signature over all three payloads needs the three writers to run in one command. Decide in PR-1.
- **Q-2.** Does criteria evidence need human presence, or is a separate-user signer enough for it? Criteria argv runs repository code, which is exactly what the separate-user tier is built for. Also decide whether `evidence.require_signature.review` is worth one touch for each head, because a signed review-complete comment proves presence and not a review (§2).
- **Q-3.** Is Windows Hello signing from WSL viable (E-1)?
- **Q-4.** Should the classify decision move to a job that GitHub loads from the base branch, so that a pull request cannot edit it? The options are a `pull_request_target` job that never checks out or runs head code, and a workflow that a ruleset requires. The first conflicts with the template rule against `pull_request_target` (`plugins/dotbabel/tests/workflow-templates.test.mjs:88-94`). The second needs an organization ruleset. Either one would remove R-10.
