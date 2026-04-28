# Handoff drift — known disagreements (Phase 1 baseline)

> Fixture for `handoff-drift.test.mjs`. Documents symbols that exist in
> one source but not the other, on `c117418` (origin/main HEAD when this
> baseline was pinned). The Phase 1 drift test asserts agreement on the
> _intersection_ of symbols across `--help` and `skills/handoff/SKILL.md`;
> everything below is intentionally outside the asserted intersection
> until the named Phase 2 PR (per `docs/specs/handoff-skill/spec/6-implementation-plan.md` §6.3) resolves it.
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

## Excluded sub-commands

| Symbol        | Present in                                                          | Missing from               | Resolves in                                            |
| ------------- | ------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------ |
| `prune`       | `--help`                                                            | `SKILL.md`                 | Phase 2 PR 5 (cleanup)                                 |
| `remote-list` | `--help`, SKILL.md (Sub-commands table only — see "Internal" below) | `SKILL.md` (argument-hint) | Phase 2 PR 5 — migration table maps to `list --remote` |
| `resolve`     | `SKILL.md`                                                          | `--help`                   | Phase 2 PR 5 (cleanup)                                 |

## Excluded flags

The Phase 1 test extracts a flat global flag set from each source and
asserts agreement on the intersection. Flags that appear in only one
source are excluded until reconciled.

| Flag                                                            | Present in                                                                     | Missing from                                                              | Resolves in                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `--from-file`                                                   | `SKILL.md`                                                                     | `--help`                                                                  | Phase 2 PR 7 (references prune)                            |
| `--all`                                                         | `--help`                                                                       | `SKILL.md` (mentioned mid-bullet under `--limit`, not a canonical entry)  | Phase 2 PR 6 (SKILL.md shrink) — promote to its own bullet |
| `--out-dir`                                                     | `--help`                                                                       | `SKILL.md`                                                                | Phase 2 PR 4 (`--to` removal sweep)                        |
| `--remote`, `--local`                                           | `--help`                                                                       | `SKILL.md` cross-cutting block (mentioned in prose for `list`)            | Phase 2 PR 6 (SKILL.md shrink)                             |
| `--verify`                                                      | `--help`                                                                       | `SKILL.md`                                                                | Phase 2 PR 6 (SKILL.md shrink)                             |
| `--force-collision`                                             | `--help`                                                                       | `SKILL.md`                                                                | Phase 2 PR 6 (SKILL.md shrink)                             |
| `--dry-run`                                                     | `--help`                                                                       | `SKILL.md`                                                                | Phase 2 PR 6 (SKILL.md shrink)                             |
| `--older-than`, `--yes`                                         | `--help`                                                                       | `SKILL.md`                                                                | Phase 2 PR 6 (SKILL.md shrink)                             |
| `--cli`                                                         | `--help`, SKILL.md (mentioned as "legacy alias on `search` and `remote-list`") | (cross-cutting bullet)                                                    | Phase 2 PR 7 — migration to `--from`                       |
| `--tags`                                                        | `--help`                                                                       | `SKILL.md` cross-cutting block (mentioned in `--tag` prose for histogram) | Phase 2 PR 6 (SKILL.md shrink)                             |
| `--to`                                                          | `SKILL.md` (synopsis line 45 + cross-cutting bullet 98-101 + cross-agent rule §b 129-132) | `--help` (binary dropped in PR 4 — `pull` next-step now always uses detected host) | Phase 2 PR 6 (SKILL.md shrink) — drop the cross-cutting bullet + §b paragraph |
| `--no-color`, `--verbose`/`-v`, `--help`/`-h`, `--version`/`-V` | `--help`                                                                       | `SKILL.md`                                                                | Out of scope — universal CLI flags, no spec coverage       |

## Internal — SKILL.md self-disagreement

Not an excluded symbol per se, but a third datapoint for §1's "patch-loop
tax" thesis: `SKILL.md` is internally inconsistent on `c117418`.

- `argument-hint` frontmatter (line 27): `pull|push|fetch|list|search|resolve|doctor` — omits `remote-list`.
- `Sub-commands` markdown table (lines 81-90): includes `remote-list`, omits `prune`.

The Phase 1 extractor pins on the `argument-hint` frontmatter line as the
authoritative SKILL.md command source — it is structured YAML, machine-
parseable, and matches the SKILL.md schema's contract. The Sub-commands
table is prose documentation that drifted from the frontmatter under the
patch-loop. Phase 2 PR 6 (SKILL.md shrink per §3 component table) is
where the two SKILL.md sub-symbol sources reconverge.
