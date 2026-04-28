# Handoff drift — known disagreements (Phase 1 baseline)

> Fixture for `handoff-drift.test.mjs`. Documents symbols that exist in
> one source but not the other. The Phase 1 drift test asserts agreement
> on the _intersection_ of symbols across `--help` and
> `skills/handoff/SKILL.md`; everything below is intentionally outside the
> asserted intersection until the named Phase 2 PR (per
> `docs/specs/handoff-skill/spec/6-implementation-plan.md` §6.3) resolves it.
>
> When a Phase 2 PR moves a symbol from "disagreement" to "agreement," it
> deletes the corresponding entry below and lets the test's intersection
> assertion grow. The last Phase 2 PR (PR 8) folds in `docs/handoff-guide.md`
> as a third source.
>
> **`docs/handoff-guide.md` is excluded entirely from Phase 1.** Per spec §1
> it is heavily drifted from both `--help` and `SKILL.md` (refs removed
> sub-commands `digest`/`file`/`describe`, says "five forms", uses `--cli`
> legacy alias). It joins as the third source in PR 8.

## Excluded flags

The Phase 1 test extracts a flat global flag set from each source and
asserts agreement on the intersection. Flags that appear in only one
source are excluded until reconciled.

| Flag                                                            | Present in | Missing from | Resolves in                                          |
| --------------------------------------------------------------- | ---------- | ------------ | ---------------------------------------------------- |
| `--no-color`, `--verbose`/`-v`, `--help`/`-h`, `--version`/`-V` | `--help`   | `SKILL.md`   | Out of scope — universal CLI flags, no spec coverage |
