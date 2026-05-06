# Alias Resolver Investigation (#158)

**Date:** 2026-05-02
**Trigger:** [GitHub issue #158](https://github.com/kaiohenricunha/dotbabel/issues/158) — request for an "alias" form in `dotclaude handoff pull` that resolves a session by the human-readable name a CLI's `--resume` UX displays ("Upgrade dotclaude and configure globally", "Handoff Pull Validation", etc.), not just by UUID prefix or `latest`.
**Scope:** `plugins/dotclaude/scripts/handoff-resolve.sh` resolver dispatch, `plugins/dotclaude/bin/dotclaude-handoff.mjs` wrapper TSV consumer, and `docs/specs/handoff-skill/spec/5-interfaces-apis.md` §5.2.1 / §5.4 grammar.
**Verdict:** **PROCEED** with deliberate-label alias resolution. Single PR, v1.3.0 `feat:` scope, estimated 8–9 hours focused work.

---

## Investigation question

Could a single new resolver function per CLI close the gap, or does any CLI's TUI alias live somewhere unreachable from disk? The implementation cost varies from "one substrate function per CLI" to "out of scope" depending on per-CLI alias-storage shape.

This investigation answered:

1. Per-CLI alias-storage verdict with `file:line` evidence
2. Resolution-semantics recommendations (match style, case, multi-match, precedence, --from interaction)
3. Cost estimate and recommended path forward

## Existing resolver landscape

`plugins/dotclaude/scripts/handoff-resolve.sh` (308 lines) already supports:

| CLI     | UUID | short-UUID | latest | alias scan today                              |
| ------- | ---- | ---------- | ------ | --------------------------------------------- |
| claude  | yes  | yes        | yes    | `customTitle` only (lines 106–124)            |
| copilot | yes  | yes        | yes    | **none**                                      |
| codex   | yes  | yes        | yes    | `thread_name` via event_msg (lines 199–214)   |
| any     | yes  | yes        | yes    | union with collision → exit 2 (lines 240–290) |

Spec freeze in `docs/specs/handoff-skill/spec/5-interfaces-apis.md`:

- §5.2.1 `pull <query>` — Notes cell at line 191 lists "UUID / 8-hex short / `latest` / Claude customTitle / Codex thread_name"
- §5.4 cross-cutting `<query>` grammar table at line 332 — currently 8 forms; lines 337–338 codify the customTitle / thread_name scans
- §5.4 line 343–344: "Copilot has **no** alias support; UUID / short / `latest` only"

The header docstring of `handoff-resolve.sh:9` advertises alias support for codex only. Claude's `customTitle` scan exists but is undocumented in the docstring and not exercised by typical TUI-derived names.

## Phase 1 — Per-CLI Alias Storage Findings

### Claude Code — STORED with computed fallback

Claude Code uses **two display mechanisms** depending on whether the TUI has auto-summarized the session, plus a third user-set mechanism the resolver already handles:

1. **`ai-title` records** (NEW — primary TUI title source, NOT in current resolver):
   - File: `~/.claude/projects/<slug>/<uuid>.jsonl`, JSONL record type `"ai-title"`, field `aiTitle`
   - Verified sample: `{"type":"ai-title","aiTitle":"Upgrade dotclaude and configure globally","sessionId":"69fc7f60-1d65-49b7-97ea-717994206509"}` in `69fc7f60-…jsonl`
   - Coverage: 4 of 24 sessions in the dotclaude project carry ai-title records — Claude Code adds them only after enough conversation accumulates for a meaningful summary
   - Mechanism: LLM-generated locally by Claude Code, persisted as a JSONL record

2. **First-user-prompt fallback** (computed — what the TUI shows when no ai-title exists):
   - For sessions with no `ai-title` record, `claude --resume`'s picker displays the first user-message content truncated
   - Verified sample: session `342730dc-…` has no ai-title; the TUI shows "Merge PR #151" because the first user message starts with `"Merge PR #151. Then run the rest of the chain:\n\n1. …"`
   - Mechanism: prefix of the first `{"type":"user", ..., "message":{"content":"…"}}` record

3. **`custom-title` records** (already supported in resolver, lines 106–124):
   - Set when user runs `claude --resume "<title>"` explicitly. **0 instances** in the current dotclaude project's 24 sessions — uncommon in practice

4. **`slug` field** (kebab-case auto-pseudonym): out of scope per scope decision

**Verdict:** STORED (ai-title) + COMPUTED fallback (first user prompt). TUI picker logic is `aiTitle if present else first_user_prompt_prefix`. Resolver must mirror both.

### Codex — COMPUTED (history.jsonl) + STORED user-aliases

Two distinct alias surfaces:

1. **`thread_name` user-set aliases** (already in resolver, lines 199–214):
   - Persisted as `{"type":"event_msg", "payload":{"thread_name":"my-feature", …}}` in the rollout JSONL — already supported

2. **TUI first-prompt preview** (NEW):
   - Source: `~/.codex/history.jsonl` — append-only file with `{"session_id":"…", "ts":…, "text":"…"}` tuples per session
   - The `text` field holds the **first meaningful user prompt** (stripped of `<environment_context>` envelope), which is what `codex resume`'s TUI displays
   - Verified by cross-referencing rollout `019d9dbf-…` against its history.jsonl entry — both contain identical first-prompt text
   - The rollout JSONL itself has no title/preview field — `session_meta` keys: `["base_instructions","cli_version","cwd","git","id","model_provider","originator","source","timestamp"]`

**Verdict:** thread_name STORED (already handled). First-prompt preview COMPUTED — derivation rule is "first `response_item` where `payload.role=='user'` AND content does not start with `<environment_context>`, take `payload.content[0].text`". The history.jsonl indexes this so the resolver can do a single jq pass over one file rather than scanning every rollout.

### Copilot — STORED on disk, no resolver support today

Copilot persists an LLM-generated session name at session-start time and never updates it:

- File: `~/.copilot/session-state/<uuid>/workspace.yaml`, top-level YAML key `name` (companion key `summary` is identical)
- Verified samples (matching observed `copilot --resume` UX):
  - `d33d3897-…` → `name: Handoff Pull Validation`
  - `774b576f-…` → `name: Pull Handoff Commit 342730dc`
  - `97806e3e-…` → `name: Validate Cross-Root Pull Behavior`
- `user_named: false` — auto-generated, LLM-style rephrasings (terms extracted, reordered, capitalized), not deterministic prefixes
- `events.jsonl` has no title/name/summary records (47 events sampled, none)
- No `~/.copilot/sessions.json` index file exists

**Verdict:** STORED. Despite being LLM-generated upstream, the value is on disk in a stable YAML file. Cleanest case of the three — no derivation needed, just a YAML key read.

### Phase 1 summary

| CLI     | Field/source                               | Verdict for #158                       | Resolver gap                                         |
| ------- | ------------------------------------------ | -------------------------------------- | ---------------------------------------------------- |
| claude  | `ai-title` records + first-user-prompt     | STORED (primary) + COMPUTED (fallback) | aiTitle scan missing; prompt-prefix fallback missing |
| codex   | `thread_name` records + history.jsonl text | STORED (already done) + COMPUTED       | history.jsonl preview lookup missing                 |
| copilot | `workspace.yaml:name`                      | STORED                                 | entire alias scan missing                            |

**Key surprise:** the existing resolver already supports user-set aliases for two of three CLIs (`customTitle`, `thread_name`), but **neither field is what the TUI picker actually displays**. #158 is a "wrong field" gap, not a "missing feature" gap.

## Phase 2 — Resolution Semantics

**Scope: deliberate-label aliases.** After Phase 1 surfaced that two of the originally proposed forms are full message bodies (claude first-user-prompt, codex `history.jsonl` preview) — content rather than labels, multi-paragraph in some samples, never typeable from a shell — the scope was narrowed to four forms whose source-of-truth is a short deliberate label users can copy-paste from picker UX:

- claude `customTitle` (user-set via `claude --resume "<name>"`, already in resolver at lines 106–124)
- claude `aiTitle` (Claude-auto-generated short summary, the human-readable label shown in `claude --resume` picker for sessions that have accumulated enough conversation)
- codex `thread_name` (user-set, already in resolver at lines 199–214)
- copilot `workspace.yaml:name` (LLM-auto-generated short label, persisted at session start)

The two excluded forms (claude first-user-prompt, codex history.jsonl preview) have a natural workaround via `dotclaude handoff list --from <cli>` for sessions without a deliberate label, then resolve by UUID. This dissolves the exact-vs-prefix tension: every in-scope form is a short deliberate label, so exact-match is unambiguously the right semantics.

### Decision 1 — Match style: exact, case-insensitive (deliberate-label scope)

**Recommendation.** Use **exact match, case-insensitive** for all four in-scope alias forms: claude `customTitle`, claude `aiTitle`, codex `thread_name`, copilot `workspace.yaml:name`.

**Reasoning.** With computed-fallback forms (claude first-user-prompt, codex `history.jsonl` preview) removed from scope, every remaining alias is a short deliberate label — either user-set or LLM-generated-as-a-label — that users can copy-paste from picker UX without typing message bodies. Exact match removes intra-CLI ambiguity at the source: collisions become "two sessions have the literal same name" rather than prefix-overlap puzzles, eliminating a class of disambiguation bugs. The existing scans already use exact equality (`handoff-resolve.sh:113` `.customTitle == $name`, `handoff-resolve.sh:207` `.thread_name == $name`); keeping new scans exact preserves consistency with the two forms already shipped. Phase 1 samples confirm no CLI distinguishes labels by case alone — claude aiTitle "Upgrade dotclaude and configure globally", copilot names "Handoff Pull Validation" / "Pull Handoff Commit 342730dc" / "Validate Cross-Root Pull Behavior" (LLM Title Case throughout), codex thread_name kebab-case (`my-feature` style) — so case-insensitivity adds usability without losing disambiguation power. None of the 4 ai-title records or 3 copilot workspace.yaml samples surveyed differ only in case from any sibling.

**Open questions / risks.** None. The previous truncation/prefix wrinkle dissolves with the deliberate-label scope — every in-scope alias is short and shell-typeable.

### Decision 2 — Case sensitivity: case-insensitive (confirmed)

**Recommendation.** Match aliases case-insensitively across all four in-scope forms.

**Reasoning.** Case-insensitive matching was encoded in Decision 1's match style; Decision 2 confirms it as the explicit semantics so future readers can find the choice as a labeled concern rather than a buried clause. Phase 1 samples show no CLI uses case as a distinguisher — copilot's LLM-generated names are consistently Title Case, codex thread_names are kebab-case, claude aiTitles vary in capitalization but never collide on case alone. Implementation: lowercase both the input alias and each scanned label before equality check — in jq, `(.aiTitle | ascii_downcase) == ($name | ascii_downcase)` (and equivalent for `customTitle` / `thread_name`); for the copilot YAML scan, lowercase both sides in bash before the string comparison.

**Open questions / risks.** None — confirmed by Phase 1 evidence and follows directly from Decision 1.

### Decision 3 — Multi-match handling: extend ARCH-3's TSV-collision pattern to per-CLI alias scans

**Recommendation.** Both intra-CLI and cross-CLI alias collisions emit the existing ARCH-3 TSV pattern (`exit 2 + TSV candidates on stderr`). Per-CLI alias scans must collect ALL matches before emitting (no silent `head -1`); on `>1` hits they exit 2 with TSV in the same format `resolve_any` already uses. TTY-prompting stays in the JS wrapper consistent with existing behavior — but the wrapper requires coordinated changes (`resolveNarrowed` at `dotclaude-handoff.mjs:222–231` currently assumes per-CLI returns at most one hit, an assumption that breaks with deliberate-label aliases). The PR ships resolver + wrapper updates as one coordinated contract change.

**Reasoning — ARCH-3 reuse verification, grounded.**

ARCH-3 is canonical at `docs/specs/handoff-skill/spec/3-high-level-architecture.md:89–98`: "multiple match → TTY prompt | non-TTY exit 2 + TSV." The resolver implements only the non-TTY half (zero hits for `grep TTY|tty|prompt|interactive|isatty handoff-resolve.sh`); the TTY-prompt half lives at `dotclaude-handoff.mjs:205–206` (`promptCollisionChoice`, triggered by `process.stdin.isTTY`). The cross-CLI handler at `handoff-resolve.sh:271–289` emits 4-column TSV (`<cli>\t<sid>\t<path>\t<query>`, line 267); the wrapper's parser at `dotclaude-handoff.mjs:201` expects exactly that count. **Aliases produce hits in the identical shape** — a list of (path, sid) tuples narrowed by the alias scan — so the existing handler absorbs alias matches without a redesign. The TSV-emit-and-exit-2 pattern is the right tool.

**Two concrete code-level changes the alias scope forces:**

1. **Per-CLI scans collect all matches, not first.** `customTitle` (line 117) and `thread_name` (line 209) currently `head -1` silently — already non-strict-ARCH-3 for user-set aliases, latent because user discipline kept collisions rare. Deliberate-label scope adds two LLM-generated alias forms (claude `aiTitle`, copilot `name`) where collision is plausible enough to demand explicit handling. Implementation: each per-CLI alias scan accumulates matches into an array, dispatches to a shared `emit_collision_tsv` helper when `count > 1`.

2. **JS wrapper's `resolveNarrowed` (lines 222–231) and `resolveLocalForPull` (lines 245–265) need collision-aware plumbing.** Both currently route per-CLI non-zero exits to "no match." They must detect the resolver's `multiple sessions match` stderr signature (already used by `resolveAny` at line 191) and dispatch to `promptCollisionChoice` / stderr-dump the same way. Mostly copy-paste from `resolveAny`'s tail. The misleading line-216 comment (_"no collision handling because the per-CLI resolvers return at most one hit"_) must also be updated.

**Plausible collision scenarios per CLI (Phase 1 evidence).**

| CLI     | Scenario                                                                  | Plausibility                                                                                                                                 |
| ------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| copilot | LLM emits identical `name` for similar work on two days                   | real — `name` is auto-generated per session-start from first user input; verbatim prompt repeats produce verbatim name duplicates            |
| claude  | aiTitle summary collides on two debugging sessions for the same bug       | real — 4/24 sessions in local sample carry aiTitles; topical similarity yields convergent LLM summaries                                      |
| codex   | User reuses `thread_name` (e.g. `my-feature`) across two threads          | real — relies entirely on user discipline; resolver currently silently picks newer via `head -1`                                             |
| any     | claude `aiTitle` and copilot `name` both render "Handoff Pull Validation" | possible — convergent LLM labels across CLIs. **Deferred to Decision 5 (`--from` interaction).** Today: `resolve_any` aggregator handles it. |

**Error message template (committed wording).**

<!-- markdownlint-disable MD010 -->

```
handoff-resolve: multiple sessions match "<input>":
<cli>	<short-id>	<path>	<matched-value>	<matched-field>
<cli>	<short-id>	<path>	<matched-value>	<matched-field>
…
hint: pass --from <cli> to narrow, or use UUID/short-UUID prefix.
```

<!-- markdownlint-enable MD010 -->

Five tab-separated columns:

- `<cli>` — `claude` / `codex` / `copilot`
- `<short-id>` — 8-char UUID prefix
- `<path>` — full session file path (existing column)
- `<matched-value>` — actual stored alias content (e.g. `Handoff Pull Validation` — case as **stored**, not as input; lets the user see what they hit when case-folding obscures the form)
- `<matched-field>` — `aiTitle` / `customTitle` / `thread_name` / `name` / `short-uuid` / `uuid`

The redundant 4th input-echo column from the existing TSV is dropped — input is already in the header line and the user's shell history. Header keeps the existing `handoff-resolve: multiple sessions match` prefix verbatim so the wrapper's stderr-pattern detector at line 191 still fires. Trailing hint line is new — current resolver leaves the user without guidance after the TSV. **The 5-column TSV is a coordinated contract change** with `dotclaude-handoff.mjs:201`'s `parts.length === 4` check; both must update in the same PR or the wrapper silently drops every candidate. The 5th column lets `promptCollisionChoice` render `[1] (claude/aiTitle) Handoff Pull Validation  [2] (copilot/name) Handoff Pull Validation` — disambiguation users would otherwise have to infer from `cli` alone.

**Open questions / risks.**

- **Bats fixtures need pre-baked collision scenarios.** Today none exist (intra-CLI collision was silenced). Phase 3 cost adds ~3 new fixture cases (one per LLM-generated alias form) plus refactor of existing UUID-collision tests to assert the 5-column TSV and the new hint line.
- **Cross-CLI mode tagging the `matched-field`.** `resolve_any` builds TSV from per-CLI hits without knowing which field matched. To populate the 5th column in cross-CLI mode, per-CLI resolvers must surface the matched-field as part of the hit metadata. Mechanical but real plumbing.
- **Inversion case for Decision 4.** If the same input could match both a short-UUID and an alias within one CLI, the collision handler must emit both with respective `matched-field` values (`short-uuid` vs `thread_name`). Decision 4 (precedence) likely kills this at the source by making UUID wins exclusive — but the data model has to support it for whatever fall-through Decision 4 allows.

**Implementation note for Phase 3 PR description.** The existing `customTitle` (handoff-resolve.sh:117) and `thread_name` (handoff-resolve.sh:209) scans both `head -1` silently on multi-match, picking the newer match without warning. That's a latent ARCH-3 violation — user discipline kept it from manifesting (most users don't reuse aliases), but it's not strict-ARCH-3 conformance. The alias scope fix incidentally corrects this pre-existing gap. **Call out in Phase 3's PR description: "this PR also fixes a latent ARCH-3 violation in the existing customTitle/thread_name resolution paths."**

### Decision 4 — Disambiguation precedence: UUID > short-UUID > `latest` > alias (input-shape-driven)

**Recommendation.** Resolution dispatches by input shape with strict precedence:

1. Input matches `UUID_RE` (`[0-9a-f]{8}-…-[0-9a-f]{12}`) → full-UUID semantics. **No fall-through to alias on miss** — emit `no session matches: <input>`, exit 2.
2. Else input matches `SHORT_UUID_RE` (`[0-9a-f]{8}`) → short-UUID semantics. **No fall-through to alias on miss** (strict precedence).
3. Else input case-folded equals `"latest"` → newest-by-mtime semantics. The keyword preempts any alias case-folding to `latest`.
4. Else → alias scan only.

**Reasoning — verification against spec and current code.**

§5.2.1's grammar at line 191 lists forms in slash-separated reading order ("UUID / 8-hex short / `latest` / Claude customTitle / Codex thread_name") and §5.4's grammar table at line 332 lists the same forms in a Form column without ordering semantics. **Neither explicitly documents precedence.** Decision 4's spec amendment must add prose, not just additive rows: "When a query lexically matches multiple forms, precedence is UUID > short-UUID > `latest` > alias. UUID-shaped queries are not consulted as aliases (no fall-through)."

Current resolver behavior, verified per-CLI:

| CLI     | `latest` check | full-UUID miss                                       | short-UUID miss                        | Note                                            |
| ------- | -------------- | ---------------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| claude  | line 78        | die (line 90)                                        | fall through to customTitle (line 102) | full-UUID strict, short-UUID lenient            |
| copilot | line 134       | die (line 145)                                       | die (line 154)                         | strict throughout (no alias today)              |
| codex   | line 168       | fall through to alias (lines 184–186, _intentional_) | fall through to alias (line 196)       | comment justifies as "very unlikely, but cheap" |

Three CLIs, three different fall-through policies — the spec's silence on precedence has produced drift. Decision 4's strict-precedence recommendation **harmonizes all three to no-fallthrough on UUID-shape miss**, removing codex's intentional fall-through. The comment's "very unlikely, but cheap" cost-benefit was the right read at the time, but the deliberate-label scope removes the use case entirely: LLM-generated aliases (claude `aiTitle`, copilot `name`) are never UUID-shaped, and user-set aliases (`thread_name`, `customTitle`) shaped like UUIDs are an anti-pattern.

Short-UUID fall-through to alias (claude line 102) becomes irrelevant under strict precedence: input shape is a 1-bit regex decision, and once the regex matches, dispatch is committed. "I typed 8 hex but actually meant a thread_name" is not a real workflow.

**Codex fall-through removal — backward-compat verification.**

The risk ("no bats fixture asserts it ≠ no user relied on it") was concrete enough to verify before committing:

- **Bats fixture at `handoff-resolve.bats:161`** explicitly tests codex UUID-fall-through: `@test "resolve codex UUID-shaped miss falls through to alias scan and exits 2"`. The assertion only checks `status == 2` and `output` contains `"not found"`. Under strict precedence, codex full-UUID miss dies with "codex session not found for uuid: $id" — same "not found" substring, same exit code. **The assertion survives the change; only the test title misrepresents post-change behavior** and is renamed to e.g. `"exits 2 with not-found error on UUID-shaped miss"`. Mechanical doc-fix in same PR.
- **Real-world thread_name usage:** 0 of 5 codex rollouts on this machine carry any `thread_name` records (`grep -l '"thread_name"' rollout-*.jsonl` → 0 hits across `~/.codex/sessions`). The thread-rename feature is rarely used; the risk of any active thread*name being UUID-shaped is effectively zero. Sample is small but the \_complete absence* of thread_names across all 5 rollouts is signal: there is no realistic user base for the fall-through to break.

**Strict precedence ships in v1.3.0; the previous codex-only fall-through was an undocumented inconsistency removed in this release.** Document explicitly in v1.3.0 release notes:

> v1.3.0 harmonizes UUID-miss precedence across all three CLIs to strict no-fallthrough. The previous codex-only fall-through to thread_name on UUID-shape miss (handoff-resolve.sh lines 184–186) was undocumented behavior diverging from claude/copilot; it is removed for consistency and to support the new alias resolution form (#158). UUID-shaped thread_names — which would be the only workflow this affects — are not observed in real-world usage; the deliberate-label scope of the alias form precludes them by design.

**`latest` precedence over alias — explicit commit.**

If a user names a session, thread, or workspace `latest` (or any case-fold thereof), the literal keyword shadows it. Trade-off:

- The keyword is documented in §5.4 line 336 (`Literal "latest"`) and in the resolver's `--help`; users naming sessions `latest` work against documented behavior
- Decision 2's case-insensitive alias matching means `Latest` and `LATEST` aliases resolve against stored values that case-fold to `latest`. To keep this consistent, the `latest` keyword check must also case-fold: `[[ "${id,,}" == "latest" ]]` in bash. Otherwise `Latest` alias would resolve normally but lowercase `latest` alias would be shadowed — incoherent. With it, every case-fold of `latest` is shadowed by a single rule
- The shadow is one-way: a session truly named `latest` can still be reached by UUID or short-UUID; only the alias form is unreachable

**Open questions / risks.**

- **Codex full-UUID fall-through removal** is a documented behavior change (per release-note text above), not a silent break. Bats test title at line 161 needs rename; assertion holds.
- **Case-insensitive `latest` keyword** is net-new behavior (current is case-sensitive). Negligible blast radius — only a user whose alias is literally `Latest` / `LATEST` is affected, and they're already in self-inflicted-wound territory.
- **§5.4 precedence prose placement.** Forms-table at line 332 is form-only; precedence prose lands cleanest as a paragraph immediately _below_ the table (forms first, then resolution rules). Phase 3 spec amendment commits the placement.

**Memo observation — spec silence drives implementation drift.**

Decision 4's verification surfaced that the spec's silence on precedence allowed three CLIs to drift into three different fall-through policies. Pattern: **"spec doesn't say"** → **"implementation makes a local choice"** → **"different files make different local choices over time"** → undocumented-and-inconsistent. The codex line 184–186 comment ("very unlikely, but cheap") was a reasonable local decision at the time of writing but became inconsistent with the eventual whole-system behavior because no spec-level rule constrained it.

Going forward: when a spec leaves a question implicit and multiple files have to make a choice, either explicitly defer in the spec ("MAY fall through, see ARCH-N") or commit to a position. Implicit-and-let-implementation-choose produces drift that becomes visible only at the next feature boundary.

### Decision 5 — `--from <cli>` interaction: alias resolution narrows to `--from` when given, identical to UUID dispatch (no special handling)

**Recommendation.** Aliases follow the existing `--from` dispatch pattern unchanged: `--from <cli>` narrows alias scan to that CLI's resolver; without `--from`, `resolve_any` aggregates per-CLI hits and emits Decision 3's 5-column TSV on cross-CLI collision (TTY-prompt or stderr-dump per ARCH-3). No new resolver-side logic for `--from`.

**Reasoning.** `handoff-resolve.sh` already dispatches by first positional argument (lines 292–305): `any` → `resolve_any`, `claude` → `resolve_claude`, `copilot` → `resolve_copilot`, `codex` → `resolve_codex`. The JS wrapper's `resolveNarrowed` at `dotclaude-handoff.mjs:222–223` translates `--from <cli>` into the first positional arg via `runScript(RESOLVE_SH, [cli, id])`. Each per-CLI resolver is scoped to its own root and inherits `--from` narrowing for free — alias scans run only against the explicitly-targeted root, dropping the cross-CLI collision class entirely. Without `--from`, the wrapper falls back to `runScript(RESOLVE_SH, ["any", id])` and `resolve_any` aggregates per-CLI hits, dispatching to Decision 3's 5-column TSV path on `count > 1`.

The cross-CLI alias collision case from Decision 3's deferred open question resolves naturally:

- `--from` given → only one CLI's resolver runs → cross-CLI ambiguity impossible
- `--from` missing → `resolve_any` collects all per-CLI hits → Decision 3's collision handler fires with 5-column TSV showing both candidates and their `matched-field` values (e.g. `(claude/aiTitle) Handoff Pull Validation` vs. `(copilot/name) Handoff Pull Validation`) → TTY user picks or non-TTY exit 2

ARCH-3's `--from` priority order at `docs/specs/handoff-skill/spec/3-high-level-architecture.md:89–98` (lines 91–94: _"1. `--from <cli>` if explicitly passed (fastest path)"_) explicitly authorizes this dispatch shape; aliases simply inherit the priority that was always there for UUID forms.

**Open questions / risks.** None.

### Edge cases

- **Empty alias string (`""`):** existing resolver's regex chains all miss; falls through to `die_runtime "claude session not found for identifier:"` (or per-CLI equivalent). Acceptable. Bats can assert this explicitly if desired.
- **Alias longer than 256 chars:** §5.4's existing lexical limit on `customTitle`/`thread_name` aliases (`non-hex string ≤ 256 chars`). Apply the same limit to `aiTitle` and `name`. Implementation: bash `[[ ${#id} -le 256 ]]` guard at the top of each alias scan; on overflow, treat as no match (not as usage error — the input could legitimately be a long UUID prefix typo and we don't want to raise on input shape).
- **Alias value containing tab / newline / NUL:** TSV is tab-delimited; alias values that contain literal tabs would corrupt the TSV row. Phase 1 evidence shows no observed sample contains tabs (LLM-generated names are sentence-case ASCII; user-set thread_names are kebab-case). Defensive: strip / replace tabs in the `<matched-value>` column when emitting TSV, or (cheaper) document the constraint and rely on upstream sanitization. Phase 3 commits the policy.

## Phase 3 — Implementation Cost Estimate

### A. Implementation file list

**1. `plugins/dotclaude/scripts/handoff-resolve.sh`**

Per-CLI scan additions/refactors:

- Add `aiTitle` scan to `resolve_claude` (NEW; ~15 lines jq)
- Refactor existing `customTitle` scan to collect-all-matches not `head -1` (corrects latent ARCH-3 violation)
- Add `workspace.yaml:name` scan to `resolve_copilot` (NEW; bash YAML parse, ~20 lines)
- Refactor existing `thread_name` scan in `resolve_codex` to collect-all-matches not `head -1` (latent ARCH-3 violation)

Precedence harmonization (per Decision 4):

- Remove codex full-UUID-miss → alias fall-through (lines 184–186)
- Remove codex short-UUID-miss → alias fall-through (line 196)
- Remove claude short-UUID-miss → `customTitle` fall-through (line 102)
- Make `latest` keyword check case-insensitive at lines 78, 134, 168 (`[[ "${id,,}" == "latest" ]]`) per Decision 4's case-fold consistency rule

Collision plumbing:

- Factor `emit_collision_tsv` helper or inline 5-column TSV emit per per-CLI scan (`<cli>\t<short-id>\t<path>\t<matched-value>\t<matched-field>`)
- Surface `<matched-field>` from per-CLI hits into `resolve_any`'s tsv aggregation (line 267) so cross-CLI mode populates the 5th column
- Update misleading comments (line 184–186 codex justification, line 113/207 head-1 silent-pick)

**2. `plugins/dotclaude/bin/dotclaude-handoff.mjs`**

- `resolveNarrowed` (lines 222–231): collision-aware plumbing matching `resolveAny`'s pattern at line 191
- `resolveLocalForPull` (lines 245–265): same collision-aware plumbing
- TSV parser at line 201: `parts.length === 4 → parts.length === 5`
- `promptCollisionChoice` render extension (line 267+): display `<matched-field>` tag in disambiguation menu
- Update misleading comment at line 215–216 (_"no collision handling because the per-CLI resolvers return at most one hit"_)
- Update docstring at line 21 ("Claude customTitle, Codex thread_name") — extend with `aiTitle` and copilot `name` for ARCH-10 drift coverage
- Verify docstring at line 219 (`uuid | short-uuid | "latest" | alias`) still accurate

**3. `docs/specs/handoff-skill/spec/5-interfaces-apis.md`**

- §5.2.1 line 191: extend Notes cell to add `Claude aiTitle` and `Copilot name`
- §5.4 line 332 grammar table: 2 NEW rows (claude `aiTitle`, copilot `name`); update notes on 2 EXISTING rows (claude `customTitle`, codex `thread_name`) to reflect collect-all semantics
- §5.4 below table: new precedence-prose paragraph (Decision 4 wording: _"When a query lexically matches multiple forms, precedence is UUID > short-UUID > `latest` > alias. UUID-shaped queries are not consulted as aliases."_)
- §5.4 `latest` row Notes: case-insensitive keyword check
- §5.4 lines 343–344 DELETE (_"Copilot has **no** alias support; UUID / short / `latest` only"_) — replaced by new copilot row

**4. `docs/handoff-guide.md`** (ARCH-10 drift-tested with SKILL.md)

- Line 140 currently lists `Claude customTitle, or a Codex thread_name` — extend to include claude `aiTitle` and copilot `name`
- Sweep file for any other alias-form enumeration that drifts from §5.4

**5. `plugins/dotclaude/tests/bats/handoff-resolve.bats`**

- Rename test title at line 161 to `"exits 2 with not-found error on UUID-shaped codex miss"` (assertion stays — verified `status == 2` + `output` contains `"not found"` survives strict-precedence change)
- Add per-CLI alias resolution fixtures (~3 new tests: claude `aiTitle`, copilot `name`, codex `thread_name` post-refactor)
- Add intra-CLI collision fixtures (~3 new tests: copilot duplicate names, claude duplicate aiTitles, codex duplicate thread_names)
- Add cross-CLI collision fixtures (~2 new tests: claude `aiTitle` vs copilot `name`, `--from` narrowing)
- Add precedence fixtures (~3 new tests: UUID-shape input doesn't fall through, `latest` keyword preempts alias, case-folded `Latest` still keyword)
- ~11 new test cases total

**6. Existing bats files needing updates** (verified during Phase 3 prep)

- `handoff-resolve-any.bats:122` comment (`"each with 4 TSV fields"`) → 5 fields; substring assertions survive
- `dotclaude-handoff-five-form.bats:156` collision test substring assertions survive; verify after wrapper-parser change
- `handoff-integration.bats` cross-CLI flow: verify TSV parsing isn't column-count-coupled

**7. `plugins/dotclaude/tests/handoff-drift.test.mjs`** (path verified)

- Extend ARCH-10 drift test to assert resolver dispatch covers all four alias mechanisms (claude `aiTitle`/`customTitle`, codex `thread_name`, copilot `workspace.yaml:name`)
- New helper `extractAliasResolutionMechanisms` similar to existing `extractFromRule` pattern

**8. `skills/handoff/SKILL.md` + plugin template + manifest checksum (TWO-pin)**

- One bullet under Cross-cutting flags noting `<query>` accepts an alias form
- Brief example showing alias usage
- `.claude/skills-manifest.json` SHA256 update
- `plugins/dotclaude/templates/claude/skills/handoff/SKILL.md` regen via `node scripts/build-plugin.mjs` (per `feedback-skills-manifest-checksum.md` memory — pre-empt locally)

**9. `CHANGELOG.md` + PR description**

- `feat:` entry under v1.3.0 documenting the alias resolution form
- Bullet documenting the latent ARCH-3 violation correction (customTitle/thread_name silent `head -1`)
- Behavioral change note: codex full-UUID-miss + short-UUID-miss strict precedence (was: fall through to thread_name); case-insensitive `latest` keyword

### B. Effort estimate

- Resolver changes: ~2.5h (3 new scans + 2 collect-all refactors + 3 fall-through removals + case-insensitive latest + 5-column TSV emit helper + matched-field metadata wiring through `resolve_any`)
- Wrapper changes: ~2h (collision plumbing in 2 functions, parser update, render extension, docstrings)
- Spec amendments: ~30min (§5.2.1, §5.4 rows + prose, line 343–344 delete, handoff-guide.md sweep)
- Bats coverage: ~2h (~11 new tests, fixture setup, comment updates in 2 existing files)
- Drift test extension: ~30min
- SKILL.md + TWO-pin updates: ~30min
- CHANGELOG + PR description: ~30min
- CI cycles, reviews, fixups: variable

**Total: ~8–9 hours focused work**, single PR, ships as v1.3.0 (`feat:` for new resolution form). Original Phase 1 estimate (6–8h) and mid-Phase-2 estimate (4h) both pre-dated discovery of the wrapper coordination scope and the additional fall-through harmonization.

### C. Recommended PR shape

Single PR titled: `feat(handoff): support deliberate-label aliases in pull/fetch resolution`

**Single local commit recommended.** Per `feedback-squash-merge-discipline.md` and `feedback-squash-pr-title-convention.md` memories: feat:/fix: PRs squash-merge in this repo, the squash commit message inherits the PR title (local commit boundaries erased), and compound conventional-commit types in squash silently skip release-please bumps. So a single `feat:` commit:

- Survives squash-merge intact
- Triggers v1.3.0 minor bump via release-please
- The latent-ARCH-3-violation detail surfaces in the PR description / CHANGELOG body, not as a separate `fix:` commit
- Behavioral-change note (codex strict-precedence harmonization, case-insensitive `latest`) goes in the same CHANGELOG/PR body

Three local commits also work if richer git log preferred — release-please reads only the squashed message.

**Spec ID block in PR body:** `Spec ID: handoff-skill`

## Phase 4 — Verdict, Next-Session Outline

### A. Verdict

**Recommended path forward: PROCEED** with deliberate-label alias resolution. Single PR, v1.3.0 `feat:` scope, estimated 8–9 hours focused work.

**Confidence: high.** Phase 1 verified all three CLIs have stored or LLM-generated short-label aliases (deliberate-label scope captures the usable surface — four alias mechanisms across three CLIs). Phase 2 produced five grounded semantics decisions, each with file:line citations against current code and spec; no open blocking risks remain. Phase 3's file-level estimate covers all surfaces verified to need changes (resolver, wrapper, spec, guide, bats, drift test, SKILL.md TWO-pin). Implementation work is mechanical given the design decisions.

**Out of scope** (deferred or wontfix): computed-fallback forms — claude first-user-prompt and codex `history.jsonl` preview. Excluded mid-Phase-2 because their underlying source-of-truth is full message bodies, not short labels — exact-matching them from a shell isn't a usable workflow regardless of match-style choice. Workaround: `dotclaude handoff list --from <cli>` to surface UUIDs for sessions without deliberate labels, then resolve by UUID. Document as known limitation in §5.4 if amendment has space.

### B. Next-session outline (implementation)

**Setup:**

1. New worktree at `.claude/worktrees/v1.3.0-alias-resolver/`
2. Branch `feat/alias-resolver` from current `origin/main` (run `git fetch origin main` first)
3. Verify `git worktree list` for collisions before creating
4. Read this memo end-to-end before any edits — Phase 3's file list IS the implementation checklist

**Implementation order** (spec-first, since changes are spec-driven and code mirrors new spec text):

1. **Spec amendments** (`docs/specs/handoff-skill/spec/5-interfaces-apis.md`) — §5.2.1 grammar update, §5.4 row additions/updates, precedence prose paragraph, lines 343–344 deletion, `latest` row case-insensitivity note
2. **`handoff-resolve.sh`** — three new alias scans + two collect-all refactors + four fall-through removals + case-insensitive `latest` + 5-column TSV emit
3. **`dotclaude-handoff.mjs`** — coordinated 5-column TSV consumption, collision plumbing in `resolveNarrowed` + `resolveLocalForPull`, render extension in `promptCollisionChoice`
4. **Bats coverage** — ~11 new test cases + comment updates in 2 existing files + test-title rename at line 161
5. **Drift test extension** (`handoff-drift.test.mjs`) — `extractAliasResolutionMechanisms` helper + ARCH-10 assertion
6. **`docs/handoff-guide.md`** sweep — line 140 alias enumeration update + any other drift sources
7. **SKILL.md + TWO-pin** — pre-emptive validator sweep per `feedback-skills-manifest-checksum.md`
8. **CHANGELOG + PR description** drafted; single feat: commit; squash-merge

**Key checkpoints during implementation:**

- After step 2 (resolver): bats per-CLI fixtures pass; cross-CLI tests still pending wrapper update
- After step 3 (wrapper): 5-column TSV contract synchronized end-to-end; existing UUID/short-UUID flows unbroken; cross-CLI bats fixtures pass
- After step 5 (drift test): ARCH-10 asserts SKILL.md ↔ binary ↔ guide alignment for alias forms
- Pre-push (step 7): TWO-pin validator sweep clean (`sha256sum` + `node scripts/build-plugin.mjs` + `npm test` + full bats suite)

**Ship via release-please cycle:** PR squash-merged → release-please opens chore PR with v1.3.0 bump → merge chore PR → tag v1.3.0 → npm publish triggered.

### C. Closing remarks — banked discipline notes

Three observations from this investigation worth banking beyond #158:

1. **"Audit binary before spec amendments"** — applied during Phase 1 (read `handoff-resolve.sh` end-to-end before drafting Phase 2 semantics) and Phase 2 (verified ARCH-3 implementation in resolver + wrapper before recommending TSV-pattern reuse). Already in `feedback-audit-binary-before-spec.md` memory; reinforced this investigation.

2. **"Spec silence produces drift"** — surfaced during Decision 4 verification: §5.2.1 and §5.4 specified alias forms but did not specify precedence between forms. Three CLIs drifted into three different fall-through policies. Pattern: _"spec doesn't say"_ → _"implementation makes a local choice"_ → _"different files make different local choices over time"_ → undocumented inconsistency. **Process rule: when a spec leaves a question implicit and multiple implementation files have to make a choice, either explicitly defer in the spec ("MAY fall through, see ARCH-N") or commit to a position. Implicit-and-let-implementation-choose produces drift visible only at the next feature boundary.** Banked as `feedback-spec-silence-produces-drift.md`.

3. **"Coordinated contract changes need wrapper-parity check"** — surfaced during Decision 3 verification: extending TSV from 4 to 5 columns required synchronized changes across `handoff-resolve.sh` (emit), `dotclaude-handoff.mjs:201` (parse: hardcoded `parts.length === 4`), `promptCollisionChoice` (render), and bats fixture comments. A resolver-only-view ("just add a column") would have shipped a silently-broken wrapper. **Generalizes: any cross-component contract change needs an explicit consumer-side audit before committing to the contract shape, not after.** Banked as `feedback-coordinated-contract-changes.md`.
