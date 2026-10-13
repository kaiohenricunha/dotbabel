# merge-verification — Engineering Spec

> Detect a forged attestation. Do not try to prevent one. Verify a share of attested pull requests anyway, read what the default branch's own CI says about each merge, and raise an alarm when a real failure contradicts a passing attestation.
>
> Created: 2026-10-12
> Branch: `feat/merge-verification`
> Base: `origin/main` @ `33f66a8`

## Status

The spec is `implementing`. Every acceptance criterion is `active`. Run them with:

```bash
dotbabel criteria verify --spec merge-verification
```

## Read this

- [spec.md](spec.md) — the problem, the design, the three run states, the cumulative rule, the fallback when CI does not run, and the limits.
- [docs/attestation.md](../../attestation.md), section "Spot checks and the contradiction alarm" — the user guide.
- [docs/cli-reference.md](../../cli-reference.md), `dotbabel-pr-stack` — the three subcommands.

## Related specs

- `qa-verification-harness` — the attestation and the merge gate that this spec watches.
- `unforgeable-evidence` — signed evidence that an agent cannot produce alone. It is parked as an opt-in design, because a generic open-source tool cannot require a hardware key. This spec is the soft path that any repository can turn on.
