# Handoff drift — known disagreements (Phase 1 baseline)

> Fixture for `handoff-drift.test.mjs`. Documents symbols that exist in
> one source but not all three. The Phase 1 drift test asserts agreement
> on the _intersection_ of symbols across `--help`, `skills/handoff/SKILL.md`,
> and `docs/handoff-guide.md`; everything below is intentionally outside the
> asserted intersection (per
> `docs/specs/handoff-skill/spec/6-implementation-plan.md` §6.3).
>
> All Phase 2 PRs (6–8) are complete. The three sources are reconciled.
> Remaining disagreements are out of scope for Phase 1 (no spec coverage
> or deferred to Phase 3 per-command flag rigor).

## Excluded flags

The Phase 1 test extracts a flat global flag set from each source and
asserts agreement on the intersection. Flags that appear in only a subset
of sources are listed here.

| Flag                                                            | Present in       | Missing from                   | Resolves in                                          |
| --------------------------------------------------------------- | ---------------- | ------------------------------ | ---------------------------------------------------- |
| `--no-color`, `--verbose`/`-v`, `--help`/`-h`, `--version`/`-V` | `--help`         | `SKILL.md`, guide              | Out of scope — universal CLI flags, no spec coverage |
| `--local`, `--remote`                                           | guide + `--help` | `SKILL.md` cross-cutting flags | Out of scope — per-command flags, Phase 3 flag rigor |
