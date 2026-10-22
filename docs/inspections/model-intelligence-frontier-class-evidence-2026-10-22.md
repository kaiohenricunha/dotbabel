# Frontier and Exceptional class evidence

Status: the design, the spec wording and the evidence values are **approved by the owner**
(2026-10-21 and 2026-10-22).

## Problem and root cause

A Haiku pin satisfied every Frontier floor, including the security floors. Two causes were
possible. Candidate one was a resolver defect in floor composition. `compose.mjs` takes the
strongest minimum, and the user-floor test still passes, so the evidence is against this cause.
Candidate two was a policy that cannot separate models. `satisfies()` (`resolver/candidates.mjs`)
checked only `reasoning`, `tool_call` and the number of distinct effort levels. Every current Claude
model has reasoning, tool calls and five effort levels, so the release snapshot gave Haiku
Frontier and Exceptional. This evidence confirms candidate two.

## Decisions

1. **Rule (all runtimes).** Frontier and Exceptional also need a reviewed `class_support` fact that
   names the class. Capability flags and model names never imply it. A model without the fact is
   `unknown`. Codex and the other runtimes have no such evidence today, so their Frontier and
   Exceptional requests preserve the native configuration.
2. **Evidence values.** Opus 5.5: Frontier. Fable 5.1: Frontier and Exceptional. Haiku 5.5 and
   Sonnet 5.5: none, recorded as an empty list. That is a reviewed negative, so a pin to those
   models against a Frontier floor is `unsatisfied`, not only `unknown`.
3. **`workflow-orchestrator`.** Its DOC-1 class was Exceptional with native `opus`. Opus has no
   Exceptional evidence, so the release build refused it. The owner chose a Frontier floor; the
   agent keeps native `opus`.

## Reviewed sources (read 2026-10-22)

[Models overview](https://platform.claude.com/docs/en/models/overview):

- "If you're unsure which model to use, start with Claude Opus 5.5 for most workloads. Use Claude
  Fable 5.1 for demanding reasoning and long-horizon agentic work, or when your evals on Claude
  Opus 5.5 at higher effort still fall short."
- Fable 5.1: "For demanding reasoning and long-horizon agentic work". Opus 5.5: "For long-running
  agentic coding and knowledge work". Sonnet 5.5: "The best combination of speed and
  intelligence". Haiku 5.5: "For high-volume, latency-sensitive tasks such as classification,
  extraction, and routing".
- "All current models support text and image input, text output, multilingual capabilities,
  vision, and tool use."

[Model configuration](https://code.claude.com/docs/en/model-config):

- Aliases: `fable` "for your hardest and longest-running tasks"; `opus` "for complex reasoning
  tasks"; `sonnet` "for daily coding tasks"; `haiku` "for simple tasks".
- Effort levels: Fable 5.1 and the three 5.5 models support `low`, `medium`, `high`, `xhigh`, `max`.
- Default effort: "`high` on every model that supports effort, except that Opus 5.5, Sonnet 5.5,
  and Haiku 5.5 default to `medium`". So Fable 5.1 defaults to `high`.

## Measured selectors

The isolated, credential-free adapter observed eight selectors on Claude Code 2.1.307 with zero
turns. `haiku`, `sonnet`, `opus` and `fable` resolve to `claude-haiku-5-5`, `claude-sonnet-5-5`,
`claude-opus-5-5` and `claude-fable-5-1`. The sanitized recording is in
`plugins/dotbabel/tests/fixtures/model-intelligence/release-source-proof.json`.

The runtime binding contract keeps its 2.1.302 provenance, because nobody re-measured it.
Fable 5.1 has no Models API context window: the recorded API fixture predates it, and no API
credential is available here. The schema does not require that field.

## Effects and limits

- The release snapshot identity changes, so the generated projection hashes and the golden test
  bytes change. No projected model changes.
- The REL-4 sentence "Reviewed `classSupport` facts follow the same release scope" extends the
  release-documentation bullet from PR #532. It lands after #532 merges.
- The Models API source in the snapshot expires on 2026-10-25 05:18 UTC under the 7-day gate.
  This unit does not renew it.
- PR #532 accepts Claude Code 2.1.302 and 2.1.304 only. The installed release is now 2.1.307, so
  its launcher stops with `routing_unverified` until 2.1.307 passes its acceptance steps.
