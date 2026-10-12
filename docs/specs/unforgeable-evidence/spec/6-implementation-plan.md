# §6 — Implementation Plan

> Three pull requests. Each one leaves the gate in a working state.

## PR-1 — Verify, behind switches that default to off

- Add `src/lib/evidence-signature.mjs` (sign, parse, verify through `deps.run`).
- Add `scope` to the three payload builders, and an optional line 3 to the three renderers.
- Writers sign when `DOTBABEL_EVIDENCE_KEY` is set. They post unsigned otherwise.
- The three ladders gain the signature rung. It runs only when line 3 is present or the base requires it (ARCH-3).
- Add the `evidence` block to `schemas/dotbabel.config.schema.json`.
- Activate AC-1 to AC-5 (`status: planned` to `active`) in the same pull request that adds their tests.

**Exit state.** No repository behaves differently until it sets `require_signature`. A signed comment is verified when it is present, so a broken signature is visible before anyone depends on it.

## PR-2 — Key custody and doctor

- Doctor findings from §5.6. Activate AC-7.
- `docs/attestation.md` gains a custody section: a security key on Linux and macOS (`ssh-keygen -t ed25519-sk`), and the separate-user signer recipe (§4) as an optional tier.
- Run experiment E-1 before the WSL guidance is written: sign with Windows OpenSSH (`ssh-keygen.exe`) through Windows Hello from inside WSL, verify the signature with Linux `ssh-keygen`, and record whether a WSL process can complete the Windows Hello prompt without the human. The result decides whether WSL users get the human-presence tier or only the explicit path.

**Exit state.** A maintainer can hold a key the agent cannot use alone, and doctor says when the configured key does not meet that bar.

## PR-3 — Enforce, then retire the unsigned marker

- Flip `evidence.require_signature.attestation` on this repository's base. That pull request edits a governed file, so it lands on the explicit path once, as the attestation policy did (`docs/attestation.md:43-46`).
- The CI `test.yml` classify job and its template verify the signature. Activate AC-8.
- Flip `criteria`, then `review`, one pull request each, after one week of clean attestation runs. Activate AC-6.
- Demote `guard-criteria-evidence.sh` to hygiene (KD-8), and update `docs/hooks.md:37-46` to say what now carries the security claim.
- In the next major release after PR-3, the default of `require_signature` becomes `true` for repositories that declare an `allowed_signers` file. Unsigned evidence stays readable for repositories that never adopt a key, and those repositories keep today's behavior and today's documented limit.

## Migration rule

The gate accepts both unsigned and signed evidence while a family's switch is off (AC-5). It accepts only signed evidence once the switch is on (AC-2). There is no state in which the gate accepts neither, so no pull request is blocked by the migration itself.

## Mapping

| PR   | Criteria                     | Files (see `spec.json` `linked_paths`)                                                          |
| ---- | ---------------------------- | ----------------------------------------------------------------------------------------------- |
| PR-1 | AC-1, AC-2, AC-3, AC-4, AC-5 | `src/lib/evidence-signature.mjs`, payload builders, ladders, config schema, evidence schemas    |
| PR-2 | AC-7                         | `bin/dotbabel-doctor.mjs`, `docs/attestation.md`                                                |
| PR-3 | AC-6, AC-8                   | `.github/workflows/test.yml`, its template, `hooks/guard-criteria-evidence.sh`, `docs/hooks.md` |

## Open questions

- **Q-1.** One touch per head or one per family? Today a pull request can produce three evidence comments, so up to three touches. A bundle signature over all three payloads needs the three writers to run in one command. Decide in PR-1.
- **Q-2.** Does criteria evidence need human presence, or is a separate-user signer enough for it? Criteria argv runs repository code, which is exactly what the separate-user tier is built for.
- **Q-3.** Is Windows Hello signing from WSL viable (E-1)?
