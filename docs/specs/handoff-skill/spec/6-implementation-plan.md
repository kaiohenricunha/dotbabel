# §6 — Implementation Plan

> **Release-bang with phased PRs.** Multiple PRs land on `main` over a
> tight window with no npm release between Phase 1 and cutover; the
> npm version bumps exactly once (major) when the new surface is
> complete. No deprecation warnings ever ship — the major version bump
> is the deprecation signal, which is what semver is for. Internally
> staged, externally atomic.
>
> **The on-disk remote format does not change.** Per §3 ARCH-6 the v1
> description decoder is already preserved and only v2 encodes.
> Existing pushed branches in users' `$DOTBABEL_HANDOFF_REPO` keep
> working through the verb rename — there is no data migration, just
> a CLI surface migration. This makes the big-bang less scary.

## 6.1 Phased Rollout

### Phase 1 — Foundation (no user-visible change)

| Field | Detail                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal  | Land ARCH-10's drift test asserting the **current (old)** symbol list before any surface changes ship.                                                                                                        |
| Why   | A drift test that baselines against current state proves the test mechanism works before it has to defend a moving target. If it starts failing in Phase 2, that's the cutover signal, not a bug in the test. |
| Exit  | Drift test on `main`, CI green, asserting old surface (`pull` = remote fetch, bare-positional = local emit, `--to` accepted, `push` falls back to env detection when no `<query>` and no `--from`).           |
| Risk  | Low — purely additive, no behavior change.                                                                                                                                                                    |

### Phase 2 — Surface cutover

| Field | Detail                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal  | Binary reshape + SKILL.md shrink + docs reconciliation land in lockstep PRs that flip the drift-test expectations PR by PR. Each PR makes the drift test **fail** on the old assertion and **pass** on the new one. No npm release in between.                                                                                                                                                 |
| How   | The drift test has its expected-symbol-list updated in the same PR that changes the binary surface. CI on each PR validates that PR's slice of the cutover is internally consistent (binary + SKILL.md + docs all updated together for that slice). Phase 2 ends when the full new surface is on `main`, all assertions are green, and the cumulative diff equals "old surface → new surface." |
| Exit  | New surface on `main`: `pull` (local cross-agent), `fetch` (remote download), `push` (with mandatory `--from` rule), `--to` removed, supporting commands per §5.2.4. SKILL.md shrunk per §3 component table + §5.5 mapping. `docs/handoff-guide.md` reconciled.                                                                                                                                |
| Risk  | Medium — the breaking change. Mitigated by lockstep PRs (small reviewable diffs), no release until Phase 2 complete (no user breakage during partial state), and the drift test forcing every component to update together.                                                                                                                                                                    |

### Phase 3 — Cleanup

| Field | Detail                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Goal  | Dead-code removal (any compatibility shims that helped Phase 2 stay reviewable), drop legacy `metadata.tag` field per §5.1.1, drift-test refinements based on what slipped through Phase 2. |
| Exit  | No legacy fields written; no compatibility shims; drift test asserts only the new shape from §5.                                                                                            |
| Risk  | Low — internal cleanup, no public-surface change.                                                                                                                                           |

### Release

After Phase 3, **one major version bump** ships to npm via the existing
`release-please` automation. CHANGELOG entry includes the migration table
from §6.5. No patch / minor releases between the start of Phase 1 and the
major-version release.

## 6.2 Workstream Breakdown

Five parallel workstreams. Dependencies (edges) determine merge ordering
within and between phases.

| ID  | Workstream                          | Files (primary)                                                                            |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| W-1 | Binary surface refactor             | `plugins/dotbabel/bin/dotbabel-handoff.mjs`, `plugins/dotbabel/src/lib/handoff-remote.mjs` |
| W-2 | SKILL.md + references rewrite       | `skills/handoff/SKILL.md`, `skills/handoff/references/*.md`                                |
| W-3 | Tests update                        | `plugins/dotbabel/tests/bats/handoff-*.bats`, `plugins/dotbabel/tests/handoff-*.test.mjs`  |
| W-4 | Drift-detection test infrastructure | `plugins/dotbabel/tests/handoff-drift.test.mjs` (new), CI wiring in `.github/workflows/`   |
| W-5 | Long-form docs reconciliation       | `docs/handoff-guide.md`                                                                    |

### Dependency edges

```
                    Phase 1
   ┌─────────────────────────────────────┐
   │ W-4 (drift test, baselines OLD)     │
   └────────────────┬────────────────────┘
                    │ exits Phase 1 → green CI
                    ▼
                    Phase 2
   ┌──────────────────────────────────────┐
   │ W-1 (binary reshape)  ◀───┐          │
   │   ↳ drives PR-by-PR       │          │
   │     drift-test flips      │          │
   │                           │          │
   │ W-3 (tests update)  ──────┘          │
   │   must move WITH W-1                  │
   │   (same PR or immediate next)         │
   │                                       │
   │ W-2 (SKILL.md shrink) ── parallel ──  │
   │   to W-1, must merge before drift     │
   │   test asserts new SKILL.md mapping   │
   │                                       │
   │ W-5 (docs guide) ── waits on W-1+W-2  │
   │   (downstream of binary surface and   │
   │    SKILL.md, reconciles to both)      │
   └──────────────────────────────────────┘
                    │
                    ▼
                    Phase 3
   ┌──────────────────────────────────────┐
   │ W-1 (cleanup, drop metadata.tag)     │
   │ W-3 (drop tests for removed surface) │
   │ W-4 (refine drift assertions)        │
   └──────────────────────────────────────┘
                    │
                    ▼
                  Release
```

## 6.3 Prompt Sequence

Skeletal, deliberately. Per-PR prompts are **derived work** from the
spec, not part of the spec itself. Pre-written prompts rot — by the
time PR #N is being worked on, the codebase has moved past PR #(N-1)'s
assumptions and the pre-written prompt is stale. The discipline §1's
"stop the patch loop" needs is supplied by:

1. The spec existing and being referenced (§1-5).
2. ARCH-10's drift test failing when surface drifts.
3. PRs scoped to single workstreams (this section).

Per-PR prompts get written at implementation kickoff, not now.

### Phase 1

| Workstream | One-line PR summary                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W-4        | Add `handoff-drift.test.mjs` asserting the current (old) symbol list across SKILL.md and `--help`. CI wires it on every PR. Test passes on green main. `docs/handoff-guide.md` drift remains deferred in Phase 1. |

### Phase 2

| Order | Workstream | One-line PR summary                                                                                                                          |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | W-1 + W-3  | Add new `pull` verb (local cross-agent emit, was bare-positional). Drift test flipped for `pull`. Old bare-positional path kept temporarily. |
| 2     | W-1 + W-3  | Add new `fetch` verb (remote download, replaces old `pull`). Drift test flipped for `fetch`. Old `pull` kept temporarily.                    |
| 3     | W-1 + W-3  | Make `--from` mandatory on `push` without `<query>`; remove env-detection fallback. Drift test flipped. Exit 64 with usage hint.             |
| 4     | W-1 + W-3  | Remove `--to` flag entirely + render single generic Next-step line per §5.1.3. Drift test flipped.                                           |
| 5     | W-1 + W-3  | Remove old verbs: bare-positional path, old `pull`. Remove unused `digest`, `file`, `resolve`, `remote-list` subs. Drift test flipped.       |
| 6     | W-2        | Shrink SKILL.md per §3 component table; install §5.5 phrase mapping verbatim. Drift test asserts new SKILL.md mapping.                       |
| 7     | W-2        | Prune `skills/handoff/references/*.md` of removed-flag references. Update `from-codex.md` for new verb names.                                |
| 8     | W-5        | Reconcile `docs/handoff-guide.md` against new surface. Drift test now passes against the full new symbol list.                               |

PRs 1-5 ship the binary cutover; PRs 6-7 ship the SKILL.md cutover; PR 8 closes docs. Within Phase 2 these can interleave but each PR must leave drift-test green for whatever subset has cut over.

### Phase 3

| Workstream | One-line PR summary                                                                         |
| ---------- | ------------------------------------------------------------------------------------------- |
| W-1        | Drop `metadata.tag` legacy field from push writes; readers continue to accept old reads.    |
| W-3        | Drop tests for removed surface (`--to`, env-detection, old verbs).                          |
| W-4        | Refine drift-test assertions based on Phase 2 lessons (likely: stricter regex on prefixes). |

### Where the actual prompts live (when they're written)

Reference: `docs/plans/handoff-skill-prompts.md` — **to be written at implementation kickoff**, not now while the spec is settling. That artifact will pull <read-first> file lists, TDD test names, and exact paths from the §3-§5 ground truth as it exists at the moment each PR starts.

## 6.4 Testing Strategy

| Workstream | UNIT                                                                                | INTEGRATION                                                                              | POST-DEPLOY (manual)                                                                              |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| W-1        | argv parser per command (5.2 flag matrices), exit codes per command (5.3 templates) | end-to-end `pull` / `push` / `fetch` against `file://` bare repo (existing bats pattern) | one round-trip against the real `$DOTBABEL_HANDOFF_REPO` from a fresh shell                       |
| W-2        | n/a (markdown)                                                                      | drift-test asserts §5.5 mapping survives the rewrite                                     | trigger a real `/handoff` via Claude Code from a session, confirm Bash invocation matches mapping |
| W-3        | bats coverage per command kept ≥ 90%                                                | every primary command + every supporting command + every error path in §5.3              | run full bats suite from `npm test` on macOS + Linux                                              |
| W-4        | unit test for the symbol-list extractor itself                                      | drift-test runs in CI on every PR; intentional drift (test fixture) must fail it         | n/a                                                                                               |
| W-5        | n/a (markdown)                                                                      | drift-test asserts `docs/handoff-guide.md` symbol list                                   | render docs locally, eyeball                                                                      |

ARCH-10's drift test runs as a **gate** on every PR through CI. Local
dev runs `npm test` to surface drift before push.

## 6.5 Migration Sequence

> **The migration that doesn't happen:** the on-disk remote format
> doesn't change. v1 description decode is preserved; only v2 encodes.
> Existing branches in users' `$DOTBABEL_HANDOFF_REPO` keep working
> through the verb rename. There is **no data migration step in this
> spec.**

The migration table for the major-version CHANGELOG:

| Old surface (v0.x)                               | New surface (v1.x)                               | User action required                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dotbabel handoff <query>` (bare positional)     | `dotbabel handoff pull <query>`                  | Add the `pull` verb                                                                                                                                                                                                                 |
| `dotbabel handoff pull <query>` (remote fetch)   | `dotbabel handoff fetch <query>`                 | Rename invocation: `pull` → `fetch` for remote retrieval                                                                                                                                                                            |
| `dotbabel handoff push --to <cli>`               | `dotbabel handoff push` (no `--to`)              | Remove `--to`. The flag did nothing functional; it tuned a one-line Next-step text that's now generic                                                                                                                               |
| `dotbabel handoff push` (env-detection fallback) | `dotbabel handoff push --from <cli>` (mandatory) | When pushing without a `<query>`, pass `--from <your-cli>`. The skill's auto-trigger contract fills this for slash-command users; direct shell users must add it. **Calling `push` without either will exit 64 with a usage hint.** |
| `dotbabel handoff digest <cli> <id>`             | `dotbabel handoff describe <id> --json`          | Use `describe --json` for scripting (preview without rendering)                                                                                                                                                                     |
| `dotbabel handoff file <cli> <id>`               | `dotbabel handoff pull <id> > <path>`            | Pipe the rendered block to a file; the dedicated `file` sub is removed                                                                                                                                                              |
| `dotbabel handoff resolve <cli> <id>`            | (removed)                                        | Internal sub no longer exposed; was scripting-only and unused                                                                                                                                                                       |
| `dotbabel handoff remote-list`                   | `dotbabel handoff list --remote`                 | Use `list --remote` (and `list --local` for local sessions)                                                                                                                                                                         |
| `metadata.json.tag` (legacy field)               | `metadata.json.tags` (array)                     | None — readers ignore unknowns, the legacy single-tag field is dropped from writes in Phase 3                                                                                                                                       |

Three user-visible breakages explicit in the table because they have
different user-affordance shapes:

1. **Verb rename** (rows 1, 2). Mechanical find-replace in any scripts.
2. **`--to` removal** (row 3). The flag was cosmetic; remove from any saved invocations.
3. **`--from` mandatory on `push`** (row 4). New friction for shell-direct users; transparent for slash-command users.

## 6.6 Rollback Plan

| Scenario                                                  | Action                                                                                                                                                                                          | Notes                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Critical bug discovered post-release                      | Publish a **patch release** that restores the prior surface (revert the cutover commits, bump major's first patch). Users `npm install -g @dotbabel/dotbabel@<prior-major>` to pin until fixed. | The drift test on the revert PR catches partial reverts; CI must pass before publishing. |
| Bug discovered between Phase 2 and release                | Revert the offending Phase 2 PR(s) on `main`. Drift test stays green because the assertions revert with the surface change.                                                                     | This is the cheap rollback window — no users affected because no release has shipped.    |
| Bug discovered during Phase 3 (post-cutover, pre-release) | Same as above — revert offending PR. Phase 3 is internal cleanup; no user-visible state to migrate.                                                                                             | Same drift-test invariant.                                                               |
| Phase 1 drift test itself is buggy                        | Revert W-4 PR. Phase 1 has no other artifacts.                                                                                                                                                  | Trivial.                                                                                 |
| User pins to old major and never upgrades                 | Acceptable. v0.x stays on npm under its tags; users upgrade when they're ready.                                                                                                                 | This is what semver major is for.                                                        |

### Things explicitly NOT in the rollback plan

| Anti-action                              | Why not                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm unpublish`                          | 72-hour publish window only; generally a bad-idea operation that breaks lockfiles for anyone who installed during the window. Don't do it. |
| Hot-patching old releases with backports | Out of scope. v0.x is the "old major"; bug fixes there require explicit user demand and are a separate decision.                           |
| Dual-publishing v0.x and v1.x            | Out of scope. The deprecation signal is the major version bump, not parallel maintenance.                                                  |

### Pre-release confidence is the actual rollback insurance

ARCH-10's drift test running on every PR through Phase 1 + Phase 2 + Phase 3 means the major version that ships has been incrementally validated for surface consistency from baseline → cutover. The drift test is what makes the big-bang less scary; it's the rollback insurance, not a literal rollback procedure.

## 6.7 Cross-references

- §3 ARCH-10 — drift-test invariant, the gating mechanism throughout this plan.
- §5.5 — SKILL.md auto-trigger phrase mapping that drift-test asserts against.
- §5.1 — frozen schemas; §6 does not change them, the surface migration is CLI-only.
- §7 — non-functional acceptance gates for Phase 2 PRs (latency, scrub fail-closed semantics).
- §8 — risks specific to this migration (verb-rename muscle-memory cost, `--from` mandatory friction, accidental Phase 1 baseline drift).
