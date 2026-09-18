# Research Sources

> Indexed documents feeding into this spec. Each tagged with which sections it informs.

<!-- Format:
- **DOC-N**: {title} — {one-line description}. Feeds: §N, §N.
-->

- **DOC-1**: [Model Selection Audit](../../../audits/model-selection-audit.md) — read-only audit (2026-09-17) of every place Dotbabel selects, hardcodes, recommends, or assumes a model, an effort, or a provider capability: 68 artifacts, 9 independent enum declarations, migration classes A–F. Feeds: §1, §2, §4, §6, §8.
- **DOC-2**: [Model Runtime Capability Investigation](../../../audits/model-runtime-capability-investigation.md) — controlled empirical investigation (2026-09-17) of how the six runtimes handle model selection, effort, artifact frontmatter, and model discovery. It carries 20 confirmed design constraints and 12 corrections to DOC-1; where the two disagree, DOC-2 governs. Feeds: §1, §3, §4, §5, §7, §8.
- **DOC-3**: [Phase 0 Findings](phase-0-findings.md) — evidence of 2026-09-18 for RQ-1, RQ-3, and RQ-4: the Models.dev contract, the credential gate of the official model APIs, the Copilot custom-agent schema, and the skill frontmatter loaders of Codex, OpenCode, and Antigravity. Feeds: §4 (KD-4), §5 (`Source Adapter Contract`), §6.1 Phase 0, §8 (R-4, R-6).

## Open Research Items

Questions that the evidence base does not answer yet. Each one names the decision that waits for it.

- **RQ-1**: Shape, stability, authentication, and limits of the official model/catalog APIs and of Models.dev. Neither DOC-1 nor DOC-2 measured them. Blocks: the knowledge-source adapter contracts in §5 (§3, `External APIs / Dependencies`). **Status, 2026-09-18:** closed for Models.dev and for the availability and documented shape of the Anthropic and Gemini APIs; the OpenAI response shape and the Models.dev license stay open (DOC-3).
- **RQ-2**: Whether each of the six runtimes accepts a nested mapping key such as `dotbabel:` in artifact frontmatter. No artifact uses one today, and the DOC-2 probes used flat keys only. KD-5 (§4) changed this from a correctness gate to an optimization/compatibility item: the materializer strips the key, so no decision waits for the answer. A positive result only lets an adapter opt in to keep the key for diagnostics. **Status, 2026-09-18:** answered for Codex and OpenCode, which ignore unknown keys without a warning; Copilot custom agents warn (DOC-3).
- **RQ-3**: Copilot binding surfaces (§4, KD-4), set by the owner on 2026-09-17: **Status, 2026-09-18:** steps 2, 3, and 5 closed; step 1 closed for the schema and blocked for run-time binding by authentication; step 4 stays conditional on a Tier 3 integration test (DOC-3).
  1. Empirically test Copilot CLI custom-agent `model` and `models` binding.
  2. Determine where Dotbabel currently installs/fans out custom agents for Copilot. First finding: no source file under `plugins/dotbabel/src/` writes `.github/agents` or an `.agent.md` file, so today it installs none.
  3. Re-test whether `.prompt.md` is actually consumed by Copilot CLI 1.0.83+; current official documentation describes prompt files as IDE-only.
  4. If custom-agent binding is confirmed, allow Model Intelligence to project a resolved model into generated Copilot agent files.
  5. Keep Copilot skill/instructions compute metadata omitted.
- **RQ-4**: Skill-level binding on Codex, Antigravity, and OpenCode. DOC-2 left them LIKELY NOT_PARSED, UNCERTAIN, and BLOCKED. Blocks: any change to their rows in KD-4. **Status, 2026-09-18:** closed for Codex and OpenCode as `unsupported`; closed as LIKELY `unsupported` for Antigravity, with the live test blocked (DOC-3).

## Deferred Follow-Ups

- **Deferred: cross-runtime agent fan-out.** Evaluate native Dotbabel agent projection for runtimes with verified agent binding, beginning with Copilot, OpenCode, and Antigravity after Tier 3 binding tests. This requires its own scope/compatibility decision and does not block Model Intelligence. Decided by the owner on 2026-09-18 (§2, `Out of Scope`; DOC-3).

## Measurement Disposition

Phase 3 content check: each measurement in DOC-1 and DOC-2 either became a §7 constraint or is dropped here with a reason.

| Measurement                                                                                | Source                                                               | Disposition                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agy` moved from 1.2.4 to 1.2.5 in under four hours                                        | DOC-2, finding 11                                                    | REL-4 (runtime discovery is stale after 6 hours and expired after 24 hours) and OPS-1 (release evidence at most 7 days old).                                |
| `opencode models` returns exit 0 with no output                                            | DOC-2, "`opencode models` Grammar and Stability"                     | REL-2, with a named Tier 2 test under TEST-4.                                                                                                               |
| "`model:` resolution adds no measurable latency"                                           | `docs/specs/dotbabel-agents/spec/7-non-functional-requirements.md:9` | PERF-1 replaces the claim with p95 <= 10 ms.                                                                                                                |
| 4 of the 11 Codex models do not support `max`; 11 skills declare it                        | DOC-2, finding 4                                                     | Dropped from §7: it is an architectural invariant, not a threshold. ARCH-1 and the per-axis adapter contract of §5 carry it.                                |
| 3 of 14 `agy models` identifiers break the `-<effort>` suffix pattern                      | DOC-2, "`agy models` Grammar and Stability"                          | Dropped from §7: an invariant. ARCH-17 forbids parsing identifier spelling.                                                                                 |
| `thinkingTokens` separates session and agent effort and shows nothing for skill effort     | DOC-2, finding 2                                                     | Dropped: it was the investigation's measurement instrument. Model Intelligence makes no claim about effort outcomes; KD-2 and ARCH-37 carry the conclusion. |
| 68 artifacts, 67 `model:`, 18 `effort:`; migration classes A=6, B=2, C=57, D=14, E=8, F=13 | DOC-1, Executive Summary and "Migration Classification"              | Dropped from §7: they size the work. P-19 batches and the IMPL-7 gate for the 13 class-F entries carry them.                                                |
| 9 independent declarations of the model enum                                               | DOC-1, Executive Summary                                             | Dropped from §7: ARCH-58 forbids a model table outside `model-intelligence/`.                                                                               |
| `codex debug models` gives an identical sha256 across three runs                           | DOC-2, "Discovery Suitability"                                       | Dropped from §7: it justifies Codex as a first adapter (§6.1 Phase 2) and the P-7 Tier 2 test.                                                              |
