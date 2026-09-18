# §1 — Problem / Motivation

> Why does this exist? What's broken? Why now?

**Settled.** All four subsections hold the owner's answers from 2026-09-17. The evidence pointers come from the model-selection audit ([DOC-1](../research/sources.md)) and the runtime capability investigation ([DOC-2](../research/sources.md)).

## The Question

"Given the work I'm doing and the AI runtime I have, which actual model and reasoning configuration should I use, and why?"

## Why

Dotbabel has no provider-neutral model intelligence layer.

Today, model choice is encoded as static, provider-specific metadata such as `opus`, `sonnet`, `haiku`, and `effort: max`. Dotbabel itself does not understand what those values mean, whether the target runtime supports them, whether they still refer to appropriate current models, or what concrete model/configuration should actually be used. The entire model system is a declaration with no resolver (DOC-1, Executive Summary, finding 1).

That architectural gap creates four failures:

1. **Metadata that is sometimes inert or interpreted differently depending on where it appears.** Claude Code applies `model:` on an agent to the subagent only, applies it on a command to the whole session, and ignores it on a skill. 36 skills declare it. Skill `effort:` has no observable effect on any runtime, measured against validated positive controls (DOC-2, strongest confirmed findings 1 and 2).
2. **Claude-specific vocabulary leaking into unrelated runtimes.** The only hard gate accepts `opus | sonnet | haiku | inherit` (`plugins/dotbabel/src/validate-skills-inventory.mjs:10`), and the fan-out carries that frontmatter to the other five runtimes. The effort set `low | medium | max` (`schemas/skill.schema.json:33-36`) matches no runtime (DOC-1, finding 4). 4 of the 11 Codex models do not support `max`, which 11 skills declare (DOC-2, finding 4; DOC-2 says 12, and a count of the `skills/*/SKILL.md` frontmatter on 2026-09-18 gives 11). Copilot reads `.claude/skills/` and `.agents/skills/` directly, so the frontmatter reaches it intact and bypasses the drop rules in `plugins/dotbabel/src/copilot-frontmatter.mjs:46-47,60-61` (DOC-2, finding 5).
3. **Model and effort knowledge becoming stale as providers and CLIs change.** The alias table in `docs/specs/dotbabel-agents/spec/5-interfaces-apis.md:29-31` still maps `opus` to `claude-opus-4-6` and `sonnet` to `claude-sonnet-4-6`, and no check reads it (DOC-1, Staleness Analysis). `agy` updated itself from 1.2.4 to 1.2.5 in under four hours during the investigation, while comments in `plugins/dotbabel/src/agents.mjs:156,272,279` pin observed facts to v1.2.4 (DOC-2, finding 11).
4. **No mechanism to discover available capabilities and recommend or resolve an appropriate concrete model/configuration for the current task.** A repo-wide search for `--model` returns zero hits (DOC-1, finding 1). The shipped CI review template runs on the default of the CLI (`plugins/dotbabel/templates/workflows/ai-review.yml:23-28`).

## What

Dotbabel expresses the stable intent of the work — for example, how much reasoning capability a task requires and where that compute requirement binds. It then resolves that intent against current runtime capabilities into an actual runtime-native model/configuration.

**Key outcome:** Dotbabel agents, workflows, and users get an appropriate real model/configuration without hardcoding today's AI model market into every artifact.

## Why Now

Dotbabel now supports six AI runtimes, but its model metadata still reflects the original Claude-centric design (`docs/specs/dotbabel-agents/spec/3-high-level-architecture.md:7`). That mismatch is no longer theoretical: provider and CLI capabilities are changing faster than Dotbabel releases can safely track, with Antigravity updating from 1.2.4 to 1.2.5 within hours during the investigation and existing model mappings already becoming stale (DOC-2, finding 11; DOC-1, Staleness Analysis). At the same time, runtime evolution is creating real cross-harness leaks, such as Copilot discovering Dotbabel's Antigravity skill tree with Claude-shaped `model:` metadata intact (DOC-2, finding 5).

The combination of broader runtime support, rapid capability churn, and already-observed integration drift means static model assumptions are now an active reliability and maintenance problem rather than future technical debt.
