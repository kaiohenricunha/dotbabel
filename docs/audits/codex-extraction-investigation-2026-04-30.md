# Codex Session Extraction Investigation

**Date:** 2026-04-30
**Trigger:** `dotclaude handoff pull 019ddf95 --from codex` returned `_(no assistant output captured)_`. Question: substrate bug, upstream format limitation, or something between?
**Scope:** `plugins/dotclaude/scripts/handoff-extract.sh` codex case (`turns_codex`) and the wrapper render path it feeds.
**Verdict:** No bug. The original output was a true negative.

---

## 1. Investigation Question

### Original observation

Pulling Codex session `019ddf95` produced a `<handoff>` block whose assistant-turns section was the literal placeholder `_(no assistant output captured)_`. The session had non-zero `response_item` records, so on its face the placeholder looked suspicious.

### Three hypotheses tested

- **(a) Substrate bug** in `handoff-extract.sh`'s codex jq filter — wrong field, wrong path, missing branch.
- **(b) Upstream format limitation** — Codex's `rollout-*.jsonl` genuinely doesn't carry assistant text the way Claude/Copilot sessions do.
- **(c) Something between** — assistant content present in the rollout but in a structure the filter doesn't recognize.

### Verdict

**None of the above.** The codex extractor is structurally correct; assistant content extraction works on every session that contains assistant content. The original observation reflected the truth: `019ddf95` was a shell-only session with zero AI turns. The placeholder rendered correctly.

---

## 2. Evidence Summary

### Phase 1 — Inventory

5 Codex rollouts on disk, spanning 13 days (Apr 17 → Apr 30 2026). All surfaced by `dotclaude handoff list --from codex`; no hidden older sessions. Diversity matrix:

| Short UUID | Date                      | Lines | Size   | Profile                                           |
| ---------- | ------------------------- | ----- | ------ | ------------------------------------------------- |
| `019d9dbf` | 2026-04-17 (oldest)       | 76    | 191 KB | Rich agent session (Copilot session-finding work) |
| `019dda3a` | 2026-04-29                | 19    | 63 KB  | Short interactive (binary testing)                |
| `019ddea6` | 2026-04-30 10:49          | 63    | 244 KB | Rich agent session, MCP-rich                      |
| `019ddf94` | 2026-04-30 15:09          | 5     | 23 KB  | Genuinely shell-only                              |
| `019ddf95` | 2026-04-30 15:10 (newest) | 17    | 40 KB  | Genuinely shell-only (the trigger)                |

### Phase 2 — Raw rollout structure

Format is **stable across all 5 sessions**. Top-level shape: `{payload, timestamp, type}`. `.type ∈ {session_meta, turn_context, response_item, event_msg}`. Session 019ddea6 additionally contains `mcp_tool_call_end` event_msgs (additive, not structural). No format drift across the 13-day span.

Assistant content lives in **two redundant locations**:

1. **`response_item` records** with `.payload.role == "assistant"`, content array `.payload.content[].text` where each block is `.type == "output_text"`.
2. **`event_msg` records** with `.payload.type == "agent_message"`, text directly at `.payload.message`.

User content mirrors:

- `response_item.payload.role == "user"` with `.payload.content[].text` (block type `input_text`)
- `event_msg.payload.type == "user_message"` with `.payload.message`

#### Per-session assistant census

| Short UUID | response_item assistant | event_msg agent_message | Profile              |
| ---------- | ----------------------- | ----------------------- | -------------------- |
| `019d9dbf` | 7                       | 7                       | Rich agent session   |
| `019dda3a` | 2                       | 2                       | Short interactive    |
| `019ddea6` | 6                       | 6                       | MCP-rich             |
| `019ddf94` | 0                       | 0                       | Genuinely shell-only |
| `019ddf95` | 0                       | 0                       | Genuinely shell-only |

`response_item` and `event_msg` mirrors are 1:1 in every session tested.

For the richest session (`019d9dbf`), `.payload.content[*].type` flattened across all 7 assistant records yielded `7 output_text` — i.e. each assistant turn has exactly one content block. `[0]`-only access is safe.

### Phase 3 — Extractor filter

`turns_codex` in `plugins/dotclaude/scripts/handoff-extract.sh`:

```bash
turns_codex() {
  local file="$1"
  local limit="${2:-20}"
  local tail_arg="$limit"
  [[ "$limit" == "0" ]] && tail_arg="+1"
  jq -c '
    select(.type == "response_item"
           and .payload.type == "message"
           and .payload.role == "assistant")
    | .payload.content[0].text // ""
    | select(length > 0)
  ' "$file" 2>/dev/null | tail -n "$tail_arg"
}
```

The filter reads exactly the path Phase 2 confirmed valid:

| Predicate                      | Phase 2 evidence                                                  | Match |
| ------------------------------ | ----------------------------------------------------------------- | ----- |
| `.type == "response_item"`     | Present in all 5 sessions (40/8/35/1/4 records)                   | ✓     |
| `.payload.type == "message"`   | Subset within response_item where role applies                    | ✓     |
| `.payload.role == "assistant"` | 7/2/6/0/0 records across the 5 sessions                           | ✓     |
| `.payload.content[0].text`     | Sample showed `{"type":"output_text","text":"…"}` at `content[0]` | ✓     |
| `select(length > 0)`           | Empty-string guard                                                | ✓     |

### Phase 4 — Layer comparison

For each session, two layers were tested independently:

- **Layer 1**: `bash handoff-extract.sh turns codex <rollout> 0` (extractor function direct, via the script's `main` dispatch)
- **Layer 2**: `dotclaude handoff pull <short> --from codex` (full extractor + render pipeline)

| Session    | Phase 2 expected | Layer 1 lines | Layer 2 rendered                           | Diagnosis               |
| ---------- | ---------------- | ------------- | ------------------------------------------ | ----------------------- |
| `019d9dbf` | 7                | 7             | 7 quoted assistant blocks                  | Works                   |
| `019dda3a` | 2                | 2             | 2 quoted assistant blocks                  | Works                   |
| `019ddea6` | 6                | 6             | 6 quoted assistant blocks (incl. MCP-rich) | Works                   |
| `019ddf94` | 0                | 0             | `_(no assistant output captured)_`         | Correct (true negative) |
| `019ddf95` | 0                | 0             | `_(no assistant output captured)_`         | Correct (true negative) |

**Layer 1 == Layer 2 == Phase 2 expected count, across every session.** No discrepancy at any layer.

---

## 3. Verdict

**Codex extractor is healthy.** No substrate bug, no upstream format limitation, no downstream pipeline drop.

The original observation that triggered this investigation (`019ddf95` returning the empty-assistant placeholder) was a true negative. Phase 2 confirmed that session genuinely has zero `response_item.role=="assistant"` and zero `event_msg.agent_message` records. The user typed shell commands without engaging the AI in that session. The placeholder rendered correctly.

The `turns_codex` filter in `handoff-extract.sh` correctly:

- Identifies assistant `response_item` records (3/5 sessions had them)
- Extracts `.payload.content[0].text` (safe — single-block invariant confirmed)
- Returns empty for sessions with no assistant content
- Surfaces both states accurately into the `<handoff>` block

---

## 4. Side Findings (separate from the verdict — none are bugs, each is worth banking)

### (a) Placeholder wording is ambiguous — P3

`_(no assistant output captured)_` reads as if extraction failed, when in fact it means "the session had no AI turns." Suggested clearer wording: `_(session contained no assistant turns)_` or similar.

- **Scope**: Single-line change in whichever wrapper renders the placeholder (likely a `handoff-render` or pull-formatter script — not in `handoff-extract.sh` itself).
- **Severity**: P3 (clarity; not behaviorally wrong).
- **Why bank, not silently fix**: Wording changes affect snapshot-style bats fixtures; should be explicit.

### (b) Format-drift coverage gap — P3

`plugins/dotclaude/tests/bats/handoff-extract.bats` does not assert against a Codex rollout fixture. If Codex evolves its rollout schema (e.g. renames `response_item` → `response_message`, restructures `payload.content`), the extractor fails silently across **all** sessions and the bats suite passes.

- **Recommendation**: Add a synthetic `rollout-*.jsonl` fixture (a few records: `session_meta`, one `response_item` user turn, one `response_item` assistant turn with `output_text` block, one `event_msg` agent_message). Assert `turns_codex` returns expected count and content; assert `prompts_codex` filters `<environment_context>`; assert `meta_codex` parses session id and cwd.
- **Severity**: P3 (preventative; format hasn't drifted as of Phase 2 evidence).
- **Why bank**: this is a real coverage hole, just not currently exploited.

### (c) Single-source extraction fragility — P4 (speculative)

The filter reads `response_item` only and ignores the `event_msg.agent_message` mirror. Phase 2 showed 1:1 correspondence in every tested session, so this is fine today. But if Codex ever desyncs them — streaming interruption, partial session writes, future schema change that drops one form — content would silently disappear from handoffs.

- **Recommendation**: Add a source comment above `turns_codex` in `handoff-extract.sh` documenting the chosen path and the mirror's existence. Optionally, hardening for v1.x: fallback chain `(response_item assistant turns) ?? (event_msg agent_message events)`.
- **Severity**: P4 (speculative; no observed divergence).
- **Why bank**: cheap to document; expensive to debug if it ever fires.

### (d) MCP tool calls not surfaced — bank for v2.x

Session `019ddea6` contained `mcp_tool_call_end` events the extractor doesn't read. Spec §4.1 defines handoff content as prompts + turns, not tool traces, so this is spec-compliant — but for MCP-rich Codex sessions, the handoff carries less context than for AI-turn-rich sessions.

- **Open design question (not a bug)**: should handoff blocks include tool-call summaries for richer cross-CLI context? Touches §4.1 definition.
- **Out of scope for v1.x.** Bank for v2.x design discussion.

---

## 5. Recommendations

1. **Close the original concern** — no fix is needed for the codex extractor.
2. **Side findings (a) and (b)** — file as small follow-up issues, bundle as v1.x docs/test improvements.
3. **Side findings (c) and (d)** — bank as design notes; don't file until they become actionable.

---

## 6. Validation Pattern (banked methodology)

Phase 1 → Phase 2 → Phase 3 → Phase 4 is a reusable debugging recipe for any future "extractor returned X, did it actually work?" question:

| Phase | Question                                   | Output                                                                             |
| ----- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1     | What's available?                          | Diverse-sample inventory across the input space                                    |
| 2     | What's the raw shape?                      | Top-level keys, payload paths, distinct discriminator values, content-block census |
| 3     | What does the extractor expect?            | Verbatim filter + path-by-path comparison vs. Phase 2 evidence                     |
| 4     | Does the pipeline produce the right thing? | Layer 1 (filter direct) vs. Layer 2 (full pipeline) vs. Phase 2 expectation        |

The key discipline: **separate "is the data there" from "does the filter find it" from "does the pipeline render it."** Conflating them produces shallow diagnoses.

Worth referencing in audit methodology docs (e.g., a future entry in `docs/audits/` or `skills/handoff/references/`) when similar extraction questions arise for Claude or Copilot sessions.
