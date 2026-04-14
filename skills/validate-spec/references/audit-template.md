# Validation Audit Template

Use this exact structure when writing the audit doc in Phase 5. Every section is
required — write "No issues found." or "N/A" rather than omitting a section, so
readers know it was checked.

Tables over prose where possible. No filler.

---

```markdown
# Spec Validation — <Spec Title> — <YYYY-MM-DD>

> Audit of spec **`<spec-id>`** (status: `<spec.json status>`) against the codebase.

## Scope

- **Spec:** `docs/specs/<spec-id>/`
- **Constraints checked:** <N> (across §3–§8)
- **Acceptance commands:** <N> (executed | skipped via `--no-run`)
- **Linked path globs:** <N>
- **Excluded:** <anything explicitly out of scope, e.g. "§6.6 Rollback Plan — not exercised">

## Structural Findings

| Check | Result | Notes |
|-------|--------|-------|
| `spec.json` schema | <pass / fail> | <e.g. "missing `owners` field" or "ok"> |
| `linked_paths` resolve | <N>/<N> globs matched | <list unresolved globs, or "all matched"> |
| `depends_on_specs` resolve | <N>/<N> | <list missing, or "all matched"> |
| README ↔ section consistency | <N> drifts | <e.g. "§4 marked done but file is scaffold-only"> |
| `DOC-N` round-trip | <N> orphans, <N> undefined | <list, or "clean"> |

## Constraint Coverage

| ID | Section | Verdict | Evidence | Notes |
|----|---------|---------|----------|-------|
| ARCH-1 | §3 | Implemented | `api/internal/config/loader.go:42` | <one-line summary of the citation> |
| PERF-2 | §7 | Partial | `src/main.jsx:118` | "p95<200ms" measured for read; write path uncovered |
| KD-3 | §4 | Unverified | — | No literal id mention; no behavioral evidence in `linked_paths` |
| R-1 | §8 | N/A | — | Spec marks risk as accepted; no mitigation expected |

**Coverage summary:**
- Implemented: <N>
- Partial: <N>
- Unverified: <N>
- N/A: <N>
- **Total:** <N>

## Acceptance Command Results

| # | Command | Exit | Duration | Pre-existing? | Output Tail |
|---|---------|------|----------|---------------|-------------|
| 1 | `npm run build` | 0 | 12.4s | — | `built in 11.8s` |
| 2 | `npm run test:coverage` | 1 | 38.1s | **introduced** | `2 failing: should render trends tab` |
| 3 | `cd api && go test ./... -race` | 0 | 67.0s | — | `ok api/internal/handler 14.2s` |

If `--no-run` was passed, replace this section with:

> Acceptance commands not executed in this run (`--no-run`). Commands recorded for reference:
>
> 1. `npm run build`
> 2. `npm run test:coverage`
> 3. `cd api && go test ./... -race`

## Issues

| Severity | Issue | Location | Recommendation |
|----------|-------|----------|----------------|
| CRITICAL | Acceptance command #2 fails (introduced by spec implementation) | `src/__tests__/TrendsView.test.jsx:88` | Investigate failing assertion; spec.json marks status `done` but tests fail |
| WARNING  | KD-3 has no code evidence | spec §4 | Either implement, defer explicitly, or remove from spec |
| WARNING  | `linked_paths` glob `api/internal/legacy/**` resolves to no files | `spec.json:18` | Remove or update glob |
| INFO     | README marks §7 `[x] done` but file is scaffold-only | `README.md`, `spec/7-non-functional-requirements.md` | Update README marker or fill section |
| INFO     | `DOC-4` defined in `sources.md` but never referenced | `research/sources.md:11` | Cite or remove |

If no issues at a severity, write a single row: "No CRITICAL issues." etc. If
genuinely zero issues across all severities, write "No issues found." in place
of the table.

## Summary

<2–3 sentences. State the verdict (implemented / partially implemented / not
implemented), what's healthy, what needs attention, and the recommended next
action.>

Example:
> Spec is **partially implemented**. Structural and metadata checks pass; 12 of
> 15 constraints have direct code evidence. The CRITICAL test failure on
> `TrendsView.test.jsx` is the only blocker — fix that and rerun this audit
> before bumping `spec.json` status to `done`. Two unverified `KD-N` decisions
> (KD-3, KD-7) need either implementation or explicit deferral in §4.
```

---

## Notes on filling the template

- **Citations format:** always `path/to/file.ext:LINE` (single line preferred).
  Multi-line citations only when the evidence genuinely spans multiple lines —
  use `path/to/file.ext:42-58`. Never cite a whole file.

- **"Output Tail"** in the acceptance table: the *last* meaningful line — usually
  the pass/fail summary. Not the whole stderr dump. If a command produced no
  meaningful tail (e.g. silent success), write `—`.

- **"Pre-existing?"** column: only meaningful for failed commands. Use `—` for
  passing commands. For failed commands, the value must be `pre-existing` or
  `introduced`, and the evidence is the result of the `git stash` round-trip
  documented in SKILL.md Phase 4. If working tree was clean (nothing to stash),
  the failure is in committed code — write `pre-existing (clean tree)`.

- **Severity gut-check:** if every issue is INFO, the spec is in good shape. If
  there's a single CRITICAL, the user needs to act before considering the spec
  done. WARNING is "worth fixing soon, doesn't block today".
