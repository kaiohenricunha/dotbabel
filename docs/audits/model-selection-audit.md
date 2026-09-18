# Dotbabel Model Selection Audit

| Field            | Value                                                                             |
| ---------------- | --------------------------------------------------------------------------------- |
| Audit date       | 2026-09-17                                                                        |
| Repository       | `kaiohenricunha/dotbabel`                                                         |
| Commit audited   | `0db0221` (`main`), package version `3.4.0`                                       |
| Scope            | Read-only inventory of model / effort / execution-mode configuration              |
| Deliverable      | This file only. No implementation, config, agent, skill, or template was changed. |
| Evidence classes | `CONFIRMED` (read in repo or observed from a CLI), `LIKELY`, `UNCERTAIN`          |

**Method.** Every claim below is grounded in a repository read or a read-only CLI
probe. Repository facts cite `path:Lnn`. Runtime observations are labelled
**RUNTIME** and name the CLI and version. Anything not traceable is labelled
`UNCERTAIN` and listed in [Unknowns and Questions](#unknowns-and-questions).
Six read-only probes were run (`--version`, `--help`, `agy models`,
`opencode models`). No configuration was written, no provider was
authenticated, nothing was installed.

---

## Executive Summary

### Counts

| Metric                                                              | Count | Evidence                                                                                                                                                                                              |
| ------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authored agents (`agents/*.md`)                                     |    24 | `index/artifacts.json` type roll-up; `agents/` listing                                                                                                                                                |
| First-class subagent artifacts                                      |     0 | No `subagent` value in `facets.schema.json:58-61`                                                                                                                                                     |
| Components that **dispatch** subagents at runtime                   |     6 | `audit-and-fix`, `review-prs`, `veracity-audit`, `post-pr-review`, `pr-conductor`, `dependabot-sweep`                                                                                                 |
| Authored skills (`skills/*/SKILL.md`)                               |    37 | `index/artifacts.json` type roll-up                                                                                                                                                                   |
| Authored commands (`commands/*.md`)                                 |     7 | `index/artifacts.json` type roll-up                                                                                                                                                                   |
| Total authored artifacts                                            |    68 | `index/artifacts.json` — 24 agent + 37 skill + 7 command                                                                                                                                              |
| Artifacts with an **explicit** `model:`                             |    67 | `skills/local-attest/SKILL.md` is the only artifact without one                                                                                                                                       |
| Artifacts that **inherit** their model                              |     1 | `skills/local-attest/SKILL.md`                                                                                                                                                                        |
| Artifacts with an explicit `effort:`                                |    18 | all skills; no agent and no command carries `effort:`                                                                                                                                                 |
| Non-artifact model-aware components                                 |    37 | full list in [Part A](#part-a--non-artifact-components): 4 validator sites, 5 schemas, 2 mapper tables, 2 fan-out paths, 2 generators, 6 extractor paths, 1 CI template, 1 config, 14 docs/spec sites |
| `^model:` frontmatter lines, whole repo (tracked)                   |   174 | 67 authored + 67 shipped template mirror + 14 fan-out + 25 test + 1 spec                                                                                                                              |
| `^effort:` frontmatter lines, whole repo (tracked)                  |    37 | 18 authored + 18 shipped template mirror + 1 test                                                                                                                                                     |
| Independent declarations of the 4-value model enum                  |     9 | 3 schemas, 1 validator `Set`, 2 validator strings, 2 docs, 1 spec                                                                                                                                     |
| Independent declarations of the effort enum                         |     1 | `schemas/skill.schema.json:33-36` only — **not** validated in code                                                                                                                                    |
| Model-alias literal occurrences (`opus`/`sonnet`/`haiku`/`inherit`) |   427 | 129 / 180 / 67 / 51                                                                                                                                                                                   |
| Duplicated model-knowledge clusters                                 |     8 | see [Duplication Analysis](#duplication-analysis)                                                                                                                                                     |
| Concrete provider model IDs anywhere in the repo                    |     8 | 3 in a stale spec table, 5 in handoff test fixtures                                                                                                                                                   |
| `--model` CLI flags passed by Dotbabel                              |     0 | repo-wide grep for `--model` returns nothing                                                                                                                                                          |
| High-risk findings                                                  |     5 | 4 rated HIGH + 1 MEDIUM-HIGH in [Risk Analysis](#risk-analysis)                                                                                                                                       |
| Unsupported / unknown cases (cannot be resolved from the repo)      |    13 | see [Unknowns and Questions](#unknowns-and-questions)                                                                                                                                                 |

### The ten findings that matter

1. **Dotbabel never selects a model at runtime — and for Claude Code that was a
   deliberate design decision, not an oversight.** `CONFIRMED` — a repo-wide grep
   for `--model` returns zero hits, and no code path reads a `model` value out of
   frontmatter for any purpose other than validating it against a four-value enum
   (`plugins/dotbabel/src/validate-skills-inventory.mjs:10`). The entire model
   system is a _declaration_ with no _resolver_. The spec says so on purpose:
   `docs/specs/dotbabel-agents/spec/3-high-level-architecture.md:7` — "Model
   routing (`model:` frontmatter) is a convention read natively by Claude Code —
   **no new runtime tooling required**", reinforced by PERF-3
   (`…/7-non-functional-requirements.md:9`): "`model:` frontmatter resolution
   adds no measurable latency — Claude Code reads it natively at agent load
   time." **The design is internally coherent for one harness and was never
   revisited for the other five.** That reframes the whole problem: this is not
   accumulated debt to clean up, it is a single-harness assumption that five
   later integrations silently inherited.

2. **The `model:` enum is Anthropic-only and is fanned out verbatim to five
   non-Anthropic harnesses.** `CONFIRMED` — `.dotbabel.json:6` fans out to
   `codex, gemini, antigravity, opencode, copilot`. Skills reach those trees as
   symlinks into `.claude/skills` (`.cli/skills/security-review ->
../../.claude/skills/security-review`), and the seven commands are copied as
   real files carrying `model: haiku` / `model: sonnet` into both `.cli/skills/`
   and `.agents/skills/` (14 checked-in copies). Only the Copilot path is honest
   about it: `plugins/dotbabel/src/copilot-frontmatter.mjs:46,60` drops `model`
   and `effort` with a warning. Codex, Gemini, Antigravity, and OpenCode receive
   `model: opus` with no translation and no warning.

3. **Every CLI Dotbabel supports accepts `--model`, and four accept an effort
   flag — Dotbabel uses none of it.** **RUNTIME**, all six installed:
   `codex-cli 0.154.0` (`-m/--model`), `gemini 0.59.0` (`-m/--model`),
   `agy 1.2.4` (`--model`, `--effort low|medium|high`, `agy models`),
   `GitHub Copilot CLI 1.0.83` (`--model`, `--effort/--reasoning-effort
none|minimal|low|medium|high|xhigh|max`, `--model auto`),
   `opencode v2.0.5` (`opencode models`), `claude 2.1.274`
   (`--model`, `--effort low|medium|high|xhigh|max`, `--fallback-model`).
   Two of the six can already enumerate their own models. The discovery surface
   exists; Dotbabel has never touched it.

4. **Dotbabel's effort enum matches no harness.** `CONFIRMED` +
   **RUNTIME** — `schemas/skill.schema.json:33-36` allows `low | medium | max`.
   Claude Code accepts `low, medium, high, xhigh, max`; Copilot accepts seven
   values including `none` and `minimal`; Antigravity accepts only
   `low|medium|high` — so the 11 skills carrying `effort: max` name a level
   Antigravity cannot accept. The enum is also **never enforced in code**: no
   `effort` check exists in `validate-skills-inventory.mjs`, so the JSON-Schema
   enum degrades to a warning (`build-index.mjs:474-481`, "Phase 1 is
   non-blocking: all schema errors become warnings").

5. **Antigravity fuses model and effort into one identifier, which falsifies
   Dotbabel's two-field model.** **RUNTIME** — `agy models` returns
   `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`,
   `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. A future system cannot
   assume `(model, effort)` are orthogonal across harnesses. The same listing
   also proves **harness ≠ provider**: Antigravity, a Google CLI, routes
   Anthropic and OpenAI-OSS models.

6. **The generated discovery index silently drops `model` and `effort`.**
   `CONFIRMED` — `index/artifacts.json` entries carry only
   `id, type, path, name, description, facets, version, owner, related`
   (verified by key union over all 68 entries), and `schemas/index-entry.schema.json:9-43`
   declares no `model` property. `dotbabel list`, `search`, `show`, and
   `.claude/skills-manifest.json` therefore cannot answer "which agents use
   opus". The alias survives only as English prose inside the `description`
   string ("Uses opus — …", 22 entries).

7. **`agents-search` is a skill that hardcodes a model-tier taxonomy as
   behaviour, and its rationale contradicts finding 6.** `CONFIRMED` —
   `skills/agents-search/SKILL.md:83-87` groups by `opus` / `sonnet` / `haiku` /
   `inherit`, and line 225 states "**Tier order is fixed.** `list` always outputs
   opus → sonnet → haiku → inherit. Never reorder". It parses `model:` out of
   `~/.claude/agents/*.md` directly (line 43-48) because the index it could have
   used does not carry the field. A new tier (`fable`) falls into `inherit`
   silently.

8. **A cost heuristic in `post-pr-review` depends on agent model tiers it does
   not own.** `CONFIRMED` — `skills/post-pr-review/SKILL.md:112-113`: "Three of
   the four agents in the full set run on `opus`, so dispatching all four at
   every diff size is the single most expensive thing this skill does." The
   claim is currently true (`architect-reviewer`, `security-auditor`,
   `compliance-auditor` are `opus`; `documentation-writer` is `haiku`) but
   nothing links the prose to the four agent files. Retier any one agent and the
   sentence becomes false with no test failing. The prose is duplicated in two
   further generated copies.

9. **The spec's alias→model mapping table is already stale, and it is the only
   place in the repo that names a concrete Claude model ID.** `CONFIRMED` —
   `docs/specs/dotbabel-agents/spec/5-interfaces-apis.md:29-31` maps
   `opus → claude-opus-4-6`, `sonnet → claude-sonnet-4-6`,
   `haiku → claude-haiku-4-5`. The current Claude family is Opus 5 / Sonnet 5 /
   Haiku 4.5 / Fable 5.1, so two of the three rows are out of date and `fable`
   has no row at all. Nothing checks this table. It is the exact staleness mode
   the future system must eliminate.

10. **The one place Dotbabel _observes_ a model, it observes it wrong for two of
    four harnesses, and covers only four of six.** `CONFIRMED` —
    `plugins/dotbabel/scripts/handoff-extract.sh` reads a `model` field into the
    handoff digest. Claude's is **hardcoded to `null`** (line 84). Codex's is
    populated from `.model_provider` (line 275) — the _provider_, not the model.
    Copilot (line 229) and Gemini (line 346) are correct. Antigravity and
    OpenCode have no extractor at all (`--help` at lines 9-11 lists only
    `claude | copilot | codex | gemini`). Tests assert Copilot's and Gemini's
    model values (`handoff-extract.bats:126,146`) and assert nothing for
    Claude's or Codex's.

---

## Current Dotbabel Taxonomy

### The concepts, as the repository actually names them

Dotbabel has **two orthogonal axes** that its own vocabulary keeps colliding:

- **Axis 1 — the _agent CLI_** (what the code calls a `Runtime`, the docs call a
  _harness_, and configuration calls a _cli_). Six of these: Claude Code, Codex
  CLI, Gemini CLI, Antigravity CLI, GitHub Copilot CLI, OpenCode.
- **Axis 2 — the _artifact_** that gets authored once and fanned out to Axis 1.
  Five types: `agent`, `skill`, `command`, `hook`, `template`
  (`schemas/facets.schema.json:58-61`).

Model and effort live on Axis 2 artifacts but are only meaningful on Axis 1
runtimes. That mismatch is the root of most findings in this audit.

### Terminology inconsistency — `CONFIRMED`

Three live names for the same Axis-1 concept:

| Name      | Where it is the canonical term                                                                             | Files using it |
| --------- | ---------------------------------------------------------------------------------------------------------- | -------------: |
| `runtime` | `plugins/dotbabel/src/agents.mjs:96` (`export const RUNTIMES`)                                             |            128 |
| `harness` | docs and prose (`docs/cli-reference.md`, `docs/quickstart.md`)                                             |            146 |
| `cli`     | configuration (`.dotbabel.json:6,8` — `fan_out`, `gate_on_cli_presence`); code (`cliSet`, `projectFanOut`) |   7 (`cliSet`) |

A fourth collision is worse: **"agent"** means three different things.

1. A Claude Code subagent definition (`agents/*.md`, `type: agent`).
2. An agent CLI generally — `AGENTS.md`, `.agents/skills/` (Antigravity's
   project fan-out dir, `plugins/dotbabel/src/agents.mjs:174`), and the neutral
   substitution key `agents` for a file three runtimes read
   (`agents.mjs:260-268`).
3. The module `plugins/dotbabel/src/agents.mjs`, which contains **no** Claude
   subagent logic at all — it is the runtime registry.

A fifth: **"provider"** in Dotbabel prose almost always means a _cloud_ provider
(AWS/Azure/GCP) or a _Terraform_ provider, e.g.
`skills/rollback-prod/SKILL.md` "Provider References". It never means a _model_
provider. A future model system must not reuse the word.

### Concept table

| Concept                         | Canonical implementation                                             | Config format                    | Owns                                  | Can set model?                      | Can set effort?                       | Inherits from                       | Provider-specific?                     |
| ------------------------------- | -------------------------------------------------------------------- | -------------------------------- | ------------------------------------- | ----------------------------------- | ------------------------------------- | ----------------------------------- | -------------------------------------- |
| Harness / agent CLI (`Runtime`) | `plugins/dotbabel/src/agents.mjs:96-241`                             | frozen JS object literal         | detection, config root, fan-out shape | **no** — no `model` field exists    | **no**                                | —                                   | neutral by design; per-runtime data    |
| Provider (model vendor)         | **does not exist**                                                   | —                                | —                                     | —                                   | —                                     | —                                   | n/a                                    |
| Model                           | a free-text `model:` YAML key, enum-checked in one place             | YAML frontmatter scalar          | nothing — pure declaration            | yes (alias only)                    | n/a                                   | Claude Code session, when `inherit` | **yes** — Anthropic tier names         |
| Effort                          | a free-text `effort:` YAML key, **never** enum-checked in code       | YAML frontmatter scalar          | nothing                               | n/a                                 | yes (`low`/`medium`/`max`)            | harness session default             | **yes** — value set matches no harness |
| Agent (subagent definition)     | `agents/*.md` → `plugins/dotbabel/templates/claude/agents/*.md`      | YAML frontmatter + markdown body | one Claude Code subagent              | **yes, required** (validator)       | **no** — not in `agent.schema.json`   | no                                  | Claude-only; never fanned out          |
| Subagent (runtime instance)     | not an artifact; spawned by `Task`/`Agent` tool from a skill body    | prose instruction                | one delegated run                     | indirectly, via the named agent     | no                                    | the named agent's `model:`          | Claude-only tooling                    |
| Skill                           | `skills/<id>/SKILL.md`                                               | YAML frontmatter + body          | one workflow                          | yes                                 | yes                                   | session default when absent         | authored Claude-shaped, fanned to 6    |
| Command                         | `commands/<name>.md`                                                 | YAML frontmatter + body          | one prompt template                   | yes                                 | **no** — not in `command.schema.json` | session default                     | authored Claude-shaped, fanned to 6    |
| Plugin                          | `plugins/dotbabel/` (npm `@dotbabel/dotbabel`) + `.claude-plugin/`   | `package.json`, `plugin.json`    | shipped CLI + templates               | no                                  | no                                    | —                                   | neutral                                |
| Hook                            | `plugins/dotbabel/hooks/*.sh`, `.claude/settings.json`               | shell + settings JSON            | turn/tool gating                      | **no** (zero model refs)            | no                                    | —                                   | Claude settings shape                  |
| Workflow (CI)                   | `plugins/dotbabel/templates/workflows/*.yml`                         | GitHub Actions YAML              | CI automation                         | **implicitly** — see row below      | no                                    | harness CLI default                 | `ai-review.yml` is Anthropic-only      |
| Template                        | `plugins/dotbabel/templates/**`                                      | mirrored markdown / YAML         | what consumers install                | carries whatever it mirrors         | same                                  | generated from authored source      | `templates/claude/**` is Claude-shaped |
| Generated instruction file      | `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`          | markdown + marker block          | rule floor per runtime                | no (prose only)                     | no                                    | `CLAUDE.md` rule floor              | one file per runtime set               |
| Generated project fan-out       | `.cli/skills/`, `.agents/skills/`, `.github/{prompts,instructions}/` | symlinks / copies / `.md`        | per-runtime discovery                 | **leaks the alias** (see finding 2) | same                                  | authored artifact                   | Copilot strips; the rest do not        |
| Discovery index                 | `index/artifacts.json` (built by `src/build-index.mjs`)              | JSON                             | search / list / show                  | **drops it**                        | **drops it**                          | authored frontmatter                | neutral                                |
| Quality policy                  | `plugins/dotbabel/src/quality/**`, `.dotbabel.json:11-47`            | JSON config + frozen defaults    | code-quality gates                    | no                                  | no                                    | shipped defaults ← project config   | neutral — best abstraction in the repo |

---

## Model Configuration Architecture Today

### What exists

```
                       ┌───────────────────────────────────────┐
                       │  AUTHORED SOURCE (the only truth)     │
                       │  agents/*.md     model: <alias>        │
                       │  skills/*/SKILL.md model: + effort:    │
                       │  commands/*.md   model: <alias>        │
                       └──────────────┬────────────────────────┘
                                      │
        ┌─────────────────────────────┼──────────────────────────────┐
        │                             │                              │
        ▼                             ▼                              ▼
┌───────────────┐        ┌──────────────────────┐      ┌─────────────────────────┐
│ VALIDATION    │        │ SHIPPED TEMPLATES     │      │ DISCOVERY INDEX          │
│ validate-     │        │ scripts/build-plugin  │      │ src/build-index.mjs      │
│ skills-       │        │  strips owner/created │      │                          │
│ inventory.mjs │        │  /updated ONLY        │      │  model:  DROPPED         │
│  model ∈ 4    │        │  model/effort kept    │      │  effort: DROPPED         │
│  effort: none │        │  verbatim             │      │  → index/artifacts.json  │
└───────────────┘        └──────────┬───────────┘      └─────────────────────────┘
                                    │
                                    ▼
                        ┌───────────────────────────┐
                        │ PROJECT FAN-OUT           │
                        │ src/project-sync.mjs      │
                        └────────┬──────────────────┘
          ┌──────────────────────┼─────────────────────────┐
          ▼                      ▼                         ▼
  .cli/skills/**         .agents/skills/**       .github/{prompts,instructions}/
  (codex, gemini,        (antigravity)            (copilot)
   opencode via
   symlinked dirs)
          │                      │                         │
  model: KEPT verbatim   model: KEPT verbatim      model: DROPPED + warned
  effort: KEPT verbatim  effort: KEPT verbatim     effort: DROPPED + warned
          │                      │                         │
          ▼                      ▼                         ▼
  ┌───────────────────────────────────────────────────────────────┐
  │ HARNESS RUNTIME — the value is interpreted here, or ignored.   │
  │ Dotbabel passes no --model and no --effort to ANY CLI.         │
  │ What the harness does with an unknown `model: opus` key is     │
  │ outside Dotbabel's knowledge and is nowhere asserted.          │
  └───────────────────────────────────────────────────────────────┘
```

### Source-of-truth tree

```
model / effort
└── SOURCE OF TRUTH: the artifact's own YAML frontmatter
    ├── overridable by: nothing inside Dotbabel
    │   ├── no CLI flag           (grep --model → 0 hits)
    │   ├── no environment var    (grep *_MODEL → 0 hits)
    │   ├── no .dotbabel.json key (no `model` or `effort` key exists)
    │   └── no global default     (no shipped fallback alias anywhere)
    ├── overridable by: the USER, outside Dotbabel
    │   ├── editing ~/.claude/agents/<id>.md after bootstrap symlinks it
    │   ├── `claude --model X` / `--effort Y` for the whole session
    │   └── `/model` inside a Claude Code session
    └── effective value: DECIDED BY THE HARNESS, unobserved by Dotbabel

runtime detection  (the one axis Dotbabel does resolve)
└── SOURCE OF TRUTH: RUNTIMES registry, agents.mjs:96-241
    ├── presence:  anyRuntimePresent() → commandExists() PATH probe   (agents.mjs:396-400)
    ├── config root: envVar → $XDG_CONFIG_HOME/<subdir> → $HOME/<baseDir>  (agents.mjs:414-424)
    └── overridable by: .dotbabel.json `fan_out`, `gate_on_cli_presence`  (.dotbabel.json:6,8)

quality policy  (the pattern a model system should copy)
└── SOURCE OF TRUTH: SHIPPED_QUALITY_DEFAULTS + QUALITY_RULES  (quality/policy.mjs:28-70)
    ├── overridden by: .dotbabel.json `quality` key                    (.dotbabel.json:11-47)
    ├── overridden by: --profile / --path / --all / --base flags
    └── states unknowns explicitly: unsupported | not_configured | unavailable  (quality/types.mjs:14-22)
```

**The load-bearing asymmetry.** Dotbabel has a _working, tested, extensible
resolver_ for runtime detection and for quality policy, and **no resolver at all**
for model or effort. Model configuration is the only Axis-2 field in the project
that is declared, mirrored, fanned out, and never resolved.

---

## Complete Model-Aware Component Inventory

### Part A — non-artifact components

These are the code, schema, doc, and CI components that define, transform,
validate, drop, or document model/effort knowledge. Every row is independently
configurable.

| Component                                                | Type                | Harness                                 | Provider           | Source file                                                                                                               | Lines                                                  | Model configuration                                                                                                                                                             | Effort configuration                                         | Execution mode              | Hardcoded?           | Inherited?              | Runtime configurable?        | User override?                     | Generated?                                                        | Tests covering it                                                                                                                                                                     | Risk     | Notes                                                                                                                                                                                   |
| -------------------------------------------------------- | ------------------- | --------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------- | -------------------- | ----------------------- | ---------------------------- | ---------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent model validator (`VALID_MODELS`)                   | config/code         | Claude                                  | Anthropic          | `plugins/dotbabel/src/validate-skills-inventory.mjs`                                                                      | L10                                                    | `Set(["opus","sonnet","haiku","inherit"])`; **required field**, hard error `AGENT_INVALID_MODEL`                                                                                | none — `effort` never checked                                | serial                      | **yes**              | no                      | no                           | no                                 | no                                                                | `tests/validate-skills-inventory.test.mjs:226-257` (rejects `turbo`, accepts all 4)                                                                                                   | **high** | The only hard gate on any model value in the project. A new alias fails CI until this `Set` changes.                                                                                    |
| Agent validator field list                               | config/code         | Claude                                  | Anthropic          | same                                                                                                                      | L271                                                   | `["name","description","tools","model"]` — model is mandatory                                                                                                                   | —                                                            | serial                      | yes                  | no                      | no                           | no                                 | no                                                                | `…test.mjs:161-177` (missing `model:`)                                                                                                                                                | medium   | Makes `inherit`-by-omission impossible for agents.                                                                                                                                      |
| `agent.schema.json` model enum                           | config              | Claude                                  | Anthropic          | `schemas/agent.schema.json`                                                                                               | L20-23                                                 | same 4-value enum                                                                                                                                                               | **absent** — no `effort` property                            | —                           | yes                  | no                      | no                           | no                                 | no                                                                | `tests/build-index.test.mjs:411-440` (compiles); no enum-rejection test                                                                                                               | medium   | Warning-only (`build-index.mjs:474-481`). Duplicate of the validator `Set`.                                                                                                             |
| `skill.schema.json` model + effort enums                 | config              | Claude                                  | Anthropic          | `schemas/skill.schema.json`                                                                                               | L29-37                                                 | same 4-value enum                                                                                                                                                               | `enum ["low","medium","max"]`                                | —                           | yes                  | no                      | no                           | no                                 | no                                                                | `tests/build-index.test.mjs:441-487` (valid example + one invalid enum)                                                                                                               | **high** | The effort enum matches no harness (finding 4) and is enforced nowhere in code.                                                                                                         |
| `command.schema.json` model enum                         | config              | Claude                                  | Anthropic          | `schemas/command.schema.json`                                                                                             | L12-15                                                 | same 4-value enum                                                                                                                                                               | **absent**                                                   | —                           | yes                  | no                      | no                           | no                                 | no                                                                | `tests/build-index.test.mjs:524-589`                                                                                                                                                  | medium   | Third independent copy of the same enum.                                                                                                                                                |
| Copilot frontmatter mapper — `PROMPT_MD_KEY_RULES`       | adapter             | Copilot                                 | routed             | `plugins/dotbabel/src/copilot-frontmatter.mjs`                                                                            | L42-49                                                 | `model: warnOnDrop` — dropped, warned                                                                                                                                           | `effort: warnOnDrop`; `disable-model-invocation: warnOnDrop` | serial                      | partially            | no                      | no                           | no                                 | no                                                                | `tests/copilot-frontmatter.test.mjs:88-102, 222-260`                                                                                                                                  | low      | **The only harness adapter that acknowledges the mismatch.** The reuse candidate for a future translation layer.                                                                        |
| Copilot frontmatter mapper — `INSTRUCTIONS_MD_KEY_RULES` | adapter             | Copilot                                 | routed             | same                                                                                                                      | L55-63                                                 | `model: warnOnDrop`                                                                                                                                                             | `effort: warnOnDrop`                                         | serial                      | partially            | no                      | no                           | no                                 | no                                                                | same                                                                                                                                                                                  | low      | Same rules for skills.                                                                                                                                                                  |
| Project fan-out (skills)                                 | adapter             | Codex / Gemini / Antigravity / OpenCode | unknown            | `plugins/dotbabel/src/project-sync.mjs`; observable as `.cli/skills/<id> -> ../../.claude/skills/<id>`                    | dir symlinks                                           | **passes the alias through untouched** — `project-sync.mjs` contains **zero** occurrences of `model` or `effort`, so the pass-through is by omission, not by a decision in code | same                                                         | serial                      | no (pass-through)    | from the authored skill | no                           | user can replace the symlink       | yes                                                               | `tests/project-sync.test.mjs:409-433` tests **only** the Copilot drop path; nothing asserts what the four skills-dir runtimes receive                                                 | **high** | Ships `model: opus` into four non-Anthropic harnesses with no warning (finding 2).                                                                                                      |
| Project fan-out (commands)                               | adapter             | Codex / Gemini / Antigravity / OpenCode | unknown            | `.cli/skills/{changelog,dependabot-sweep,markdown,merge-pr,pr-tldr,pre-pr,tldr}/SKILL.md` and the `.agents/skills/` twins | L15-17 of each                                         | **14 checked-in copies of `model: haiku` / `model: sonnet`**                                                                                                                    | —                                                            | serial                      | yes (copied literal) | from `commands/*.md`    | no                           | user edits the copy                | yes                                                               | none assert the copied model                                                                                                                                                          | **high** | Unlike skills, these are real files — the Anthropic alias is physically committed into the Codex/Gemini/Antigravity/OpenCode trees.                                                     |
| `build-plugin` template mirror                           | template/build      | Claude                                  | Anthropic          | `scripts/build-plugin.mjs`                                                                                                | L43 (`AUTHORING_FIELDS`), L269-282                     | strips only `owner`,`created`,`updated`; **`model` preserved verbatim**                                                                                                         | `effort` preserved verbatim                                  | serial                      | no                   | mirrors source          | no                           | no                                 | yes                                                               | **`tests/build-plugin.test.mjs:372`** asserts the mirrored agent still matches `/^model:/m` (fixture `model: "sonnet"` at L49); `--check` gated in `.github/workflows/dogfood.yml:42` | medium   | Doubles every model literal (67 → 134). The mirror is the reason the authored `agents/` dir is validated only transitively.                                                             |
| Discovery index builder                                  | adapter             | shared                                  | n/a                | `plugins/dotbabel/src/build-index.mjs`                                                                                    | L401-432 (entry shape), L474-501 (`validateArtifacts`) | **drops `model`** from every entry                                                                                                                                              | **drops `effort`**                                           | serial                      | no                   | n/a                     | no                           | no                                 | yes → `index/artifacts.json`                                      | `tests/build-index.test.mjs:307-330, 488-523`                                                                                                                                         | **high** | Finding 6. Schema violations are warnings only, so a bad model value never fails the index build.                                                                                       |
| `index-entry.schema.json`                                | config              | shared                                  | n/a                | `schemas/index-entry.schema.json`                                                                                         | L9-43                                                  | no `model` property                                                                                                                                                             | no `effort` property                                         | —                           | n/a                  | n/a                     | no                           | no                                 | no                                                                | `tests/build-index.test.mjs:488-523`                                                                                                                                                  | medium   | Codifies the drop. `additionalProperties: true` means adding the field later is non-breaking.                                                                                           |
| `facets.schema.json` `task` enum                         | config              | shared                                  | n/a                | `schemas/facets.schema.json`                                                                                              | L39-53                                                 | —                                                                                                                                                                               | —                                                            | —                           | yes                  | n/a                     | no                           | no                                 | no                                                                | `tests/build-index.test.mjs:411-440`                                                                                                                                                  | low      | Task **kind** (`review`, `debugging`, …). **No complexity axis exists** — the central policy gap.                                                                                       |
| `skills-manifest.json`                                   | config              | Claude                                  | n/a                | `.claude/skills-manifest.json` (+ template twin)                                                                          | whole file                                             | no model field (`grep -c model` → 0)                                                                                                                                            | none                                                         | serial                      | n/a                  | n/a                     | no                           | no                                 | yes                                                               | `tests/validate-skills-inventory.test.mjs`                                                                                                                                            | low      | Carries `name, path, checksum, dependencies, lastValidated`. A checksum pipeline a model catalog could reuse.                                                                           |
| Handoff meta extractor — Claude                          | adapter             | Claude                                  | Anthropic          | `plugins/dotbabel/scripts/handoff-extract.sh`                                                                             | L84                                                    | **`model: null` hardcoded**                                                                                                                                                     | —                                                            | serial                      | **yes**              | —                       | no                           | no                                 | no                                                                | `tests/bats/handoff-extract.bats:113-120` — asserts `cwd`/`session_id`, **not model**                                                                                                 | **high** | The one component that could observe a live Claude model and deliberately does not.                                                                                                     |
| Handoff meta extractor — Codex                           | adapter             | Codex                                   | OpenAI             | same                                                                                                                      | L275                                                   | `model: nn(.model_provider)` — **records the provider in the model field**                                                                                                      | —                                                            | serial                      | yes                  | —                       | no                           | no                                 | no                                                                | `…bats:131-137` — asserts `cwd`/`session_id`, **not model**                                                                                                                           | **high** | Provider/model conflation baked into the digest schema.                                                                                                                                 |
| Handoff meta extractor — Copilot                         | adapter             | Copilot                                 | routed             | same                                                                                                                      | L209, L229                                             | `session.start.data.model`, `workspace.yaml` fallback                                                                                                                           | —                                                            | serial                      | no                   | —                       | reads live value             | n/a                                | no                                                                | `…bats:126` asserts `"model":"gpt-5"`                                                                                                                                                 | low      | Correct. The template for the other three.                                                                                                                                              |
| Handoff meta extractor — Gemini                          | adapter             | Gemini                                  | Google             | same                                                                                                                      | L346, L367                                             | first `gemini` record's `.model`                                                                                                                                                | —                                                            | serial                      | no                   | —                       | reads live value             | n/a                                | no                                                                | `…bats:146` asserts `"model":"gemini-2.5-pro"`                                                                                                                                        | low      | Correct.                                                                                                                                                                                |
| Handoff extractor CLI coverage                           | adapter             | 4 of 6                                  | mixed              | same                                                                                                                      | L9-11 (`cli: claude \| copilot \| codex \| gemini`)    | **no Antigravity, no OpenCode path**                                                                                                                                            | —                                                            | serial                      | yes                  | —                       | no                           | no                                 | no                                                                | `tests/bats/dotbabel-handoff-five-form.bats`                                                                                                                                          | medium   | Two supported runtimes cannot be read at all.                                                                                                                                           |
| Handoff digest schema                                    | docs                | shared                                  | mixed              | `skills/handoff/references/digest-schema.md`                                                                              | L11, L15                                               | `cli:` enum lists 4; `model: <model-id-or-list>`                                                                                                                                | —                                                            | —                           | yes                  | —                       | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | medium   | `<model-id-or-list>` is the repo's only acknowledgement that a session may span several models (`references/copilot.md:136-137`).                                                       |
| `ai-review.yml` CI template                              | workflow/template   | Claude                                  | **Anthropic only** | `plugins/dotbabel/templates/workflows/ai-review.yml`                                                                      | L23-28                                                 | **no `--model`** → whatever `@anthropic-ai/claude-code` defaults to                                                                                                             | none                                                         | headless, `--max-turns 40`  | **implicitly**       | harness default         | no                           | consumer edits the copied workflow | yes → `examples/minimal-consumer/.github/workflows/ai-review.yml` | none                                                                                                                                                                                  | **high** | A shipped always-on production PR-review path whose model is entirely unspecified and whose provider is hard-wired (`ANTHROPIC_API_KEY`, L8, L25).                                      |
| `.dotbabel.json` fan-out config                          | config              | all 6                                   | n/a                | `.dotbabel.json`                                                                                                          | L6-8                                                   | no model key                                                                                                                                                                    | no effort key                                                | shared symlink layout       | n/a                  | n/a                     | yes (per repo)               | yes                                | no                                                                | `tests/project-sync.test.mjs`                                                                                                                                                         | low      | The natural home for future model policy, currently model-free.                                                                                                                         |
| Copilot project instructions preamble                    | docs (hand-written) | Copilot                                 | Anthropic          | `.github/copilot-instructions.md`                                                                                         | L106-111                                               | documents `model` required, `opus \| sonnet \| haiku \| inherit`                                                                                                                | —                                                            | —                           | yes                  | no                      | —                            | —                                  | **no** — outside the rule-floor markers (L126-339)                | `dotbabel-check-instruction-parity`                                                                                                                                                   | medium   | The enum is documented **only** to Copilot. `AGENTS.md` and `GEMINI.md` carry no equivalent (verified: zero model hits in either).                                                      |
| Copilot review instructions                              | docs (hand-written) | Copilot                                 | Anthropic          | `.github/copilot-review-instructions.md`                                                                                  | L102-104                                               | same enum, as a review rule                                                                                                                                                     | —                                                            | —                           | yes                  | no                      | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | medium   | Fifth independent copy of the enum.                                                                                                                                                     |
| Agent spec — model routing table                         | docs/spec           | Claude                                  | Anthropic          | `docs/specs/dotbabel-agents/spec/5-interfaces-apis.md`                                                                    | L16, L25-45                                            | alias→ID table + 8-agent tier table                                                                                                                                             | —                                                            | —                           | yes                  | no                      | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | **high** | Finding 9. The only concrete Claude model IDs in the repo, and two of three are stale.                                                                                                  |
| Agent spec — implementation plan                         | docs/spec           | Claude                                  | Anthropic          | `docs/specs/dotbabel-agents/spec/6-implementation-plan.md`                                                                | L25, L48, L62-64, L86, L138                            | restates the enum 3× and a tier assignment list                                                                                                                                 | —                                                            | —                           | yes                  | no                      | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | medium   | `L62` assigns `opus` to `security-review, spec, validate-spec, create-audit, audit-and-fix, ground-first`; `validate-spec` is now `sonnet` — already drifted from the shipped artifact. |
| Agent spec — architecture decision                       | docs/spec           | Claude                                  | Anthropic          | `docs/specs/dotbabel-agents/spec/3-high-level-architecture.md`                                                            | L7, L22                                                | "Model routing (`model:` frontmatter) is a convention read natively by Claude Code — **no new runtime tooling required**"; "→ respects model: frontmatter per agent"            | —                                                            | —                           | n/a                  | —                       | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | **high** | **The load-bearing decision behind every other finding.** It is correct for Claude Code and was never re-examined when Codex, Gemini, Antigravity, OpenCode, and Copilot were added.    |
| Agent spec — PERF-3                                      | docs/spec           | Claude                                  | Anthropic          | `docs/specs/dotbabel-agents/spec/7-non-functional-requirements.md`                                                        | L9                                                     | "`model:` frontmatter resolution adds no measurable latency — Claude Code reads it natively at agent load time"                                                                 | —                                                            | —                           | n/a                  | —                       | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | medium   | A non-functional requirement that _assumes_ the harness resolves the field. True for Claude, unverified for the other five.                                                             |
| Agent spec — scope + motivation                          | docs/spec           | Claude                                  | Anthropic          | `…/1-problem-motivation.md:7,11`; `…/2-scope.md:9`; `…/4-data-flow-components.md:7,28,64`; `README.md:23`                 | as cited                                               | "`model:` frontmatter routing … (opus/sonnet/haiku/inherit)"; "Routes each agent/skill to the appropriate **Claude tier**"; "model cost optimization" named as a goal           | —                                                            | —                           | yes                  | —                       | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | medium   | Six more restatements. `4-data-flow-components.md:28` is explicit that the tier ladder is **Claude's**, which is the honest framing the rest of the repo drops.                         |
| Agent spec — risk register                               | docs/spec           | Claude                                  | Anthropic          | `docs/specs/dotbabel-agents/spec/8-risks-alternatives.md`                                                                 | L11                                                    | R-3: "`model: opus` agents surprise users with higher token costs … Default borderline agents to `sonnet`, not `opus`"                                                          | —                                                            | —                           | yes                  | —                       | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | low      | The only written cost policy in the project. It is advice, not a gate.                                                                                                                  |
| Copilot frontmatter mapping doc                          | docs                | Copilot                                 | routed             | `docs/copilot-frontmatter-mapping.md`                                                                                     | L31-33, L52-54, L83-84                                 | "Claude's `model` is a tier enum … Copilot's is a free-form model identifier (e.g. `GPT-4o`). No safe crosswalk exists."                                                        | `effort` — "No Copilot equivalent"                           | —                           | partially            | —                       | —                            | —                                  | no                                                                | `tests/copilot-frontmatter.test.mjs`                                                                                                                                                  | low      | **The clearest statement of the core problem anywhere in the repo.** Cites `GPT-4o`, itself now dated.                                                                                  |
| Quickstart / CLI reference                               | docs                | Copilot                                 | routed             | `docs/quickstart.md:149-161`; `docs/cli-reference.md:458-468`                                                             | same drop list, twice                                  | same                                                                                                                                                                            | —                                                            | partially                   | —                    | —                       | —                            | —                                  | no                                                                | `docs:stamp-check` (version stamps only)                                                                                                                                              | low      | Two more copies of the drop rule.                                                                                                                                                       |
| `CLAUDE.md` rule floor — frontmatter guidance            | docs                | all 6                                   | n/a                | `CLAUDE.md`                                                                                                               | L251                                                   | names `model`, `effort` as skill-frontmatter concerns                                                                                                                           | same                                                         | —                           | no literal values    | —                       | —                            | —                                  | source of the generated rule floor                                | `dotbabel-check-instruction-drift`                                                                                                                                                    | low      | Fans out to `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md` — so the _concept_ reaches every runtime while the _enum_ does not.                                             |
| `CONTRIBUTING.md` authoring rules                        | docs                | Claude                                  | Anthropic          | `CONTRIBUTING.md`                                                                                                         | L97-99                                                 | lists `model`, `effort` as optional skill keys                                                                                                                                  | same                                                         | —                           | no                   | —                       | —                            | —                                  | no                                                                | none                                                                                                                                                                                  | low      | Requires `disable-model-invocation: true` for side-effectful skills.                                                                                                                    |
| Quality policy resolver                                  | config/code         | shared                                  | n/a                | `plugins/dotbabel/src/quality/policy.mjs`                                                                                 | L28-70                                                 | **no model knowledge**                                                                                                                                                          | no                                                           | profiles `fast`/`pr`/`deep` | n/a                  | shipped ← project       | yes                          | yes                                | no                                                                | `tests/` quality suite                                                                                                                                                                | low      | **Best reuse candidate.** See [Existing Reusable Abstractions](#existing-reusable-abstractions).                                                                                        |
| Quality adapter registry                                 | adapter             | shared                                  | n/a                | `plugins/dotbabel/src/quality/adapters/registry.mjs`                                                                      | L7-12                                                  | no model knowledge                                                                                                                                                              | no                                                           | per-capability plans        | n/a                  | n/a                     | via `.dotbabel.json` `tools` | yes                                | no                                                                | `tests/` quality suite                                                                                                                                                                | low      | Second-best reuse candidate.                                                                                                                                                            |
| Runtime registry                                         | adapter             | all 6                                   | n/a                | `plugins/dotbabel/src/agents.mjs`                                                                                         | L96-241, L396-464                                      | **no `model` field in the `Runtime` typedef** (L77-86)                                                                                                                          | no                                                           | n/a                         | n/a                  | n/a                     | env vars per runtime         | yes                                | no                                                                | `tests/agents.test.mjs` (extensive)                                                                                                                                                   | low      | **The obvious place to hang per-harness model capability metadata.**                                                                                                                    |

### Part B — authored artifacts (roll-up)

Fields invariant across **all 68** artifact rows, stated once so the per-artifact
tables below stay readable:

| Column                | Value for every artifact                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Harness (authoring)   | Claude Code (Claude-shaped frontmatter is the authoring format)                                                              |
| Harness (delivery)    | agents → Claude only. Skills/commands → all six (`.dotbabel.json:6`).                                                        |
| Provider              | **Anthropic-implied, never declared.** No artifact names a provider.                                                         |
| Execution mode        | serial, except the six subagent dispatchers noted per row                                                                    |
| Hardcoded?            | yes — a literal alias in YAML                                                                                                |
| Inherited?            | no, except `skills/local-attest/SKILL.md` (no `model:` → session default)                                                    |
| Runtime configurable? | **no** — nothing reads the value back                                                                                        |
| User override?        | yes, indirectly — edit the bootstrapped file, or `claude --model` / `--effort` / `/model` for the session                    |
| Generated?            | authored source. Each is mirrored 1:1 into `plugins/dotbabel/templates/claude/…` by `scripts/build-plugin.mjs`.              |
| Tests                 | agents: `tests/validate-skills-inventory.test.mjs:375-384` (the mirror only). **Skills and commands: no model test at all.** |

---

## Agents and Subagents

**No agent declares `effort`** — `agent.schema.json` has no such property, and
`grep '^effort:' agents/` returns nothing. Every agent's effort is `Unknown /
inherited from the session`.

**No agent declares a subagent capability.** Spawn ability is a _tool grant_
plus prose. Only `workflow-orchestrator` is described as an orchestrator, and its
`tools: Read, Bash, Glob, Grep` (`agents/workflow-orchestrator.md:19`) contains
**no `Task` or `Agent` tool** — so its stated purpose ("dispatch subagents") is
not backed by a grant. `LIKELY` a real gap; whether Claude Code treats the agent
`tools:` list as restrictive for `Task` is `UNCERTAIN`.

|   # | Agent                   | Purpose                               | Harness / provider | Model          | Effort | Model explicit? | Effort explicit? | Spawns subagents?                                                                         | Expected complexity                      | Documented rationale                                                                        | Deliberate or incidental?                                                                                                                                        | Future semantic requirement | Future effort semantic |
| --: | ----------------------- | ------------------------------------- | ------------------ | -------------- | ------ | --------------- | ---------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------- |
|   1 | `architect-reviewer`    | system design / anti-pattern review   | Claude / Anthropic | `opus` (L20)   | —      | explicit        | inherited        | no (Read, Grep, Glob)                                                                     | cross-cutting, whole-repo                | "cross-cutting architectural analysis requires deep reasoning across large codebases" (L18) | **deliberate** — also in the spec tier table (`5-interfaces-apis.md:39`)                                                                                         | Frontier Reasoning          | Deep                   |
|   2 | `aws-engineer`          | AWS design / debug                    | Claude / Anthropic | `opus` (L20)   | —      | explicit        | inherited        | no                                                                                        | multi-service, IAM trust                 | "IAM trust, multi-service interactions, and compliance tradeoffs" (L18)                     | deliberate (prose)                                                                                                                                               | Deep Reasoning              | Standard               |
|   3 | `azure-engineer`        | Azure design / debug                  | Claude / Anthropic | `opus` (L21)   | —      | explicit        | inherited        | no                                                                                        | identity + networking                    | "identity, networking, and multi-subscription governance" (L19)                             | deliberate (prose)                                                                                                                                               | Deep Reasoning              | Standard               |
|   4 | `backend-developer`     | server-side implementation            | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | routine feature work                     | "balanced capability and throughput" (L18)                                                  | **deliberate** — spec `5-interfaces-apis.md:41`                                                                                                                  | Routine Engineering         | Standard               |
|   5 | `changelog-assistant`   | changelog / release notes             | Claude / Anthropic | `haiku` (L20)  | —      | explicit        | inherited        | no                                                                                        | mechanical git-log summarization         | "formulaic and lightweight; fast output benefits release flow" (L18)                        | **deliberate** — spec `:45`                                                                                                                                      | Mechanical                  | Light                  |
|   6 | `compliance-auditor`    | declared-vs-enforced gate coverage    | Claude / Anthropic | `opus` (L21)   | —      | explicit        | inherited        | no (read-only)                                                                            | cross-reference config ↔ code            | **none** — description has no "Uses …" clause                                               | **incidental** — one of only two agents with no rationale; `source:` is an external catalogue (L23)                                                              | Deep Reasoning              | Deep                   |
|   7 | `container-engineer`    | image / build optimization            | Claude / Anthropic | `sonnet` (L19) | —      | explicit        | inherited        | no                                                                                        | structured, pattern-driven               | "structured and pattern-driven; sonnet provides the right depth without excess cost" (L17)  | deliberate (prose)                                                                                                                                               | Routine Engineering         | Standard               |
|   8 | `crossplane-engineer`   | XRD / Composition authoring           | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | well-specified authoring                 | "Crossplane Composition authoring is well-specified" (L18)                                  | deliberate (prose)                                                                                                                                               | Routine Engineering         | Standard               |
|   9 | `data-scientist`        | scoring-formula / config-drift audit  | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no (read-only)                                                                            | boundary conditions, formula correctness | **none**                                                                                    | **incidental** — no rationale; external `source:` (L21). Sits _below_ `compliance-auditor`, its sibling in the same `veracity-audit` fleet, with no explanation. | Deep Reasoning              | Deep                   |
|  10 | `deployment-engineer`   | release / traffic-shift strategy      | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | structured execution                     | "structured; sonnet handles the reasoning without over-provisioning cost" (L18)             | deliberate (prose)                                                                                                                                               | Routine Engineering         | Standard               |
|  11 | `devops-engineer`       | CI/CD pipelines                       | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | structured, iterative                    | "structured and iterative" (L18)                                                            | deliberate (prose)                                                                                                                                               | Routine Engineering         | Standard               |
|  12 | `docker-engineer`       | Compose design + runtime ops          | Claude / Anthropic | `sonnet` (L22) | —      | explicit        | inherited        | no                                                                                        | structured ops                           | "Compose design and runtime ops are structured" (L20)                                       | deliberate (prose)                                                                                                                                               | Routine Engineering         | Standard               |
|  13 | `documentation-writer`  | docs / READMEs / docstrings           | Claude / Anthropic | `haiku` (L20)  | —      | explicit        | inherited        | no                                                                                        | templated writing                        | "templated and fast-turnaround; throughput matters more than deep reasoning" (L18)          | **deliberate** — spec `:44`                                                                                                                                      | Mechanical                  | Light                  |
|  14 | `frontend-developer`    | client-side implementation            | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | routine feature work                     | "balanced capability and response speed" (L18)                                              | **deliberate** — spec `:42`                                                                                                                                      | Routine Engineering         | Standard               |
|  15 | `gcp-engineer`          | GCP design / debug                    | Claude / Anthropic | `opus` (L21)   | —      | explicit        | inherited        | no                                                                                        | Workload Identity, IAM hierarchies       | "requires deep reasoning to avoid security gaps" (L19)                                      | deliberate (prose)                                                                                                                                               | Deep Reasoning              | Deep                   |
|  16 | `iac-engineer`          | Terraform / Pulumi modules            | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | structured authoring                     | "structured and pattern-driven" (L18)                                                       | deliberate (prose)                                                                                                                                               | Routine Engineering         | Standard               |
|  17 | `kubernetes-specialist` | cluster debug / workload review       | Claude / Anthropic | `opus` (L19)   | —      | explicit        | inherited        | no                                                                                        | scheduler + network-policy semantics     | "deep reasoning prevents misdiagnosis" (L17)                                                | deliberate (prose)                                                                                                                                               | Deep Reasoning              | Deep                   |
|  18 | `platform-engineer`     | IDP / golden paths                    | Claude / Anthropic | `opus` (L20)   | —      | explicit        | inherited        | no                                                                                        | long-horizon design                      | "decisions compound over time" (L18)                                                        | deliberate (prose)                                                                                                                                               | Frontier Reasoning          | Deep                   |
|  19 | `pulumi-engineer`       | Pulumi stacks / Automation API        | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | code-first, structured                   | "code-first and structured" (L18)                                                           | deliberate (prose)                                                                                                                                               | Routine Engineering         | Standard               |
|  20 | `security-auditor`      | vulnerability / secrets audit         | Claude / Anthropic | `opus` (L20)   | —      | explicit        | inherited        | no (read-only, SEC-2 enforced)                                                            | adversarial analysis                     | "false negatives have high downstream cost" (L18)                                           | **deliberate** — spec `:38`; appears in **every** `post-pr-review` profile                                                                                       | Frontier Reasoning          | Very Deep              |
|  21 | `security-engineer`     | infra hardening / RBAC / supply chain | Claude / Anthropic | `opus` (L20)   | —      | explicit        | inherited        | no                                                                                        | privilege-escalation analysis            | "a missed vector has high downstream cost" (L18)                                            | deliberate (prose)                                                                                                                                               | Frontier Reasoning          | Very Deep              |
|  22 | `terragrunt-engineer`   | Terragrunt DRY hierarchies            | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | well-specified patterns                  | "well-specified" (L18)                                                                      | deliberate (prose)                                                                                                                                               | Routine Engineering         | Standard               |
|  23 | `test-engineer`         | test authoring / flake fixing         | Claude / Anthropic | `sonnet` (L20) | —      | explicit        | inherited        | no                                                                                        | edge-case reasoning                      | "reasoning about edge cases and failure modes" (L18)                                        | **deliberate** — spec `:43` ("structured but not cheap")                                                                                                         | Routine Engineering         | Standard               |
|  24 | `workflow-orchestrator` | multi-agent decomposition             | Claude / Anthropic | `opus` (L20)   | —      | explicit        | inherited        | **stated yes, not granted** — `tools: Read, Bash, Glob, Grep` (L19) has no `Task`/`Agent` | decomposition quality compounds          | "poor decomposition cascades into downstream failures" (L18)                                | **deliberate** — spec `:40`                                                                                                                                      | Exceptional Reasoning       | Deep                   |

**Tier distribution:** 11 `opus`, 11 `sonnet`, 2 `haiku`, 0 `inherit`, 0 `fable`.
Nothing in the repo uses `inherit` on an agent, even though it is the only
value in the enum that is provider-neutral.

### Runtime subagent dispatchers

These are the components that actually create subagents. Each one picks a fleet,
and therefore picks a model set indirectly.

| Dispatcher         | Source                                   | Fleet                                                                                                         | Concurrency cap    | Dispatch tool granted?                         | Effective model                                              |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------- | ------------------------------------------------------------ |
| `post-pr-review`   | `skills/post-pr-review/SKILL.md:107-160` | diff-size profile over `architect-reviewer`, `security-auditor`, `compliance-auditor`, `documentation-writer` | not capped; 4 max  | **yes** — `tools: … Task` (L23)                | each agent's own `model:` (3× `opus`, 1× `haiku`)            |
| `review-prs`       | `skills/review-prs/SKILL.md:86-95`       | `subagent_type: "general-purpose"`, 1 per PR                                                                  | 6 per round (L86)  | **no** — `tools: Bash, Read, Grep` (L18)       | `general-purpose` default, **not** the skill's `model: opus` |
| `audit-and-fix`    | `skills/audit-and-fix/SKILL.md:56-62`    | `subagent_type: "general-purpose"`, 1 per cluster                                                             | 6 concurrent (L78) | **no** — `tools: Read, Grep, Glob, Bash` (L17) | `general-purpose` default                                    |
| `veracity-audit`   | `skills/veracity-audit/SKILL.md:81-202`  | `data-scientist` (`sonnet`), `compliance-auditor` (`opus`), `data-engineer` (**does not exist in `agents/`**) | 3 parallel         | **yes** — `allowed-tools: … Agent` (L26)       | per named agent; one name unresolvable                       |
| `dependabot-sweep` | `commands/dependabot-sweep.md:41-79`     | `subagent_type: "general-purpose"`, 1 per PR                                                                  | 6 concurrent (L77) | **no `tools:` key at all**                     | `general-purpose` default                                    |
| `pr-conductor`     | `skills/pr-conductor/SKILL.md:105`       | invokes `post-pr-review` once, transitively the fleet above                                                   | inherits           | n/a                                            | inherits                                                     |

`veracity-audit` naming a non-existent `data-engineer` agent is `CONFIRMED`
(`grep -l data-engineer agents/` → no match; `index/artifacts.json` has no such
id). Its model is therefore undefined.

---

## Skills

The audit asked for four cases to be distinguished. All four exist.

### Case 1 — skill that only provides instructions (model is a self-declaration)

31 of 37 skills. They carry `model:` (and sometimes `effort:`), give the harness
instructions, and never reference a model again.

### Case 2 — skill that directly selects a model

**One: `agents-search`.** `skills/agents-search/SKILL.md:44-48, 83-87, 225` —
it parses `model:` out of `~/.claude/agents/*.md`, defaults a missing value to
`inherit` (L47), groups results into a fixed four-tier order, and forbids
reordering. It is also the skill that _writes_ agent files (L123 —
`Write` to `~/.claude/agents/<name>.md` from a remote catalogue), so it can
install an agent carrying any model string the upstream catalogue used, bypassing
`VALID_MODELS` until the next `dotbabel-validate-skills` run.

### Case 3 — skill that delegates to an agent with its own model

Four: `post-pr-review`, `veracity-audit` (named agents), `review-prs`,
`audit-and-fix` (`general-purpose`). See the dispatcher table above.
`post-pr-review` is the only one whose body **reasons about the delegated
models' cost** (`SKILL.md:112-113`).

### Case 4 — skill whose generated instructions tell the harness or user which model to use

Three clusters, all via the Copilot `.github/instructions/` fan-out:

- `.github/instructions/agents-search.instructions.md:65-80, 214-215` — the full
  tier taxonomy reaches Copilot as instructions, even though
  `copilot-frontmatter.mjs:60` stripped the skill's own `model:` key from the
  same file's frontmatter. **The body leaks what the frontmatter mapper
  removed.**
- `.github/instructions/post-pr-review.instructions.md:101` — the `opus`
  fleet-cost sentence reaches Copilot.
- `skills/spec/SKILL.md:291` and `skills/spec/references/cc-prompt-templates.md:81-82`
  recommend `/think` and `/ultraplan` as effort escalations. Neither exists as a
  Dotbabel command or skill (`grep` over `commands/` and `skills/` → no match),
  so these are **dangling effort recommendations**, fanned out to Copilot at
  `.github/instructions/spec.instructions.md:280`.

### Skill inventory

| Skill                   | Model                 |   L | Effort   |   L | `disable-model-invocation` |           Case | Dispatches?             | Future semantic requirement       | Future effort semantic |
| ----------------------- | --------------------- | --: | -------- | --: | -------------------------- | -------------: | ----------------------- | --------------------------------- | ---------------------- |
| `agents-search`         | `sonnet`              |  20 | `medium` |  19 | —                          |          **2** | no                      | Mechanical (file parsing)         | Light                  |
| `audit-and-fix`         | `opus`                |  18 | —        |   — | —                          |          **3** | yes, general-purpose ×6 | Frontier Reasoning                | Very Deep              |
| `aws-specialist`        | `opus`                |  23 | `max`    |  22 | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `azure-specialist`      | `opus`                |  23 | `max`    |  22 | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `code-simplifier`       | `sonnet`              |  20 | —        |   — | —                          |              1 | no                      | Routine Engineering               | Standard               |
| `create-assessment`     | `opus`                |  19 | —        |   — | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `create-audit`          | `opus`                |  19 | —        |   — | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `create-experiment`     | `sonnet`              |  19 | —        |   — | —                          |              1 | no                      | Routine Engineering               | Standard               |
| `create-inspection`     | `opus`                |  19 | —        |   — | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `crossplane-specialist` | `opus`                |  24 | `max`    |  23 | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `deploy-status`         | `sonnet`              |  21 | `medium` |  22 | `false` (23)               |              1 | no                      | Routine Engineering               | Standard               |
| `detect-flaky`          | `sonnet`              |  19 | —        |   — | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `fix-with-evidence`     | `sonnet`              |  18 | —        |   — | —                          |              1 | no                      | Routine Engineering               | Standard               |
| `flyctl`                | `sonnet`              |  24 | `medium` |  25 | `true` (26)                |              1 | no                      | Routine Engineering               | Standard               |
| `gcp-specialist`        | `opus`                |  23 | `max`    |  22 | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `git`                   | `sonnet`              |  18 | —        |   — | —                          |              1 | no                      | Routine Engineering               | Standard               |
| `ground-first`          | `opus`                |  19 | —        |   — | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `handoff`               | `sonnet`              |  30 | `medium` |  29 | —                          |              1 | no                      | Routine Engineering               | Standard               |
| `kubernetes-specialist` | `opus`                |  23 | `max`    |  22 | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `local-attest`          | **absent — inherits** |   — | —        |   — | `true` (25)                |              1 | no                      | Unknown                           | Unknown                |
| `plan-grader`           | `opus`                |  19 | —        |   — | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `post-pr-review`        | `sonnet`              |  24 | `medium` |  25 | —                          |      **3 + 4** | yes, named agents       | Routine Engineering (coordinator) | Standard               |
| `pr-conductor`          | `sonnet`              |  22 | —        |   — | `true` (24)                | 3 (transitive) | via `post-pr-review`    | Routine Engineering               | Standard               |
| `project-sync`          | `sonnet`              |  27 | `low`    |  26 | —                          |              1 | no                      | Mechanical                        | Minimal                |
| `pulumi-specialist`     | `opus`                |  23 | `max`    |  22 | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `quality-review`        | `sonnet`              |  18 | —        |   — | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `release-conductor`     | `sonnet`              |  21 | —        |   — | `true` (23)                |              1 | no                      | Routine Engineering               | Standard               |
| `reproduce-bug`         | `sonnet`              |  20 | —        |   — | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `review-pr`             | `sonnet`              |  18 | —        |   — | —                          |              1 | no                      | Routine Engineering               | Standard               |
| `review-prs`            | `opus`                |  19 | —        |   — | —                          |          **3** | yes, general-purpose ×6 | Routine Engineering (coordinator) | Standard               |
| `rollback-prod`         | `sonnet`              |  19 | `medium` |  20 | `true` (21)                |              1 | no                      | Routine Engineering               | Standard               |
| `security-review`       | `opus`                |  19 | —        |   — | —                          |              1 | no                      | Frontier Reasoning                | Very Deep              |
| `spec`                  | `opus`                |  21 | `max`    |  20 | —                          |          **4** | no                      | Frontier Reasoning                | Maximum                |
| `terraform-specialist`  | `opus`                |  23 | `max`    |  22 | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `terragrunt-specialist` | `opus`                |  23 | `max`    |  22 | —                          |              1 | no                      | Deep Reasoning                    | Deep                   |
| `validate-spec`         | `sonnet`              |  24 | `max`    |  23 | —                          |              1 | no                      | Deep Reasoning                    | Very Deep              |
| `veracity-audit`        | `opus`                |  24 | `max`    |  23 | —                          |          **3** | yes, 3 named agents     | Frontier Reasoning                | Very Deep              |

Two internal inconsistencies worth naming:

- **`validate-spec` is the only artifact with `model: sonnet` + `effort: max`.**
  Every other `effort: max` skill is `opus`. `LIKELY` deliberate (deep work on a
  mid-tier model) but undocumented, and `6-implementation-plan.md:62` says it
  should be `opus` — so implementation and spec disagree.
- **`code-simplifier`, `quality-review`, `security-review`, `review-pr` all
  review code, and carry three different models with no `effort:`.** No stated
  policy separates them.

### Commands

| Command            | Model    |   L | Effort                                   | Notes                                                   |
| ------------------ | -------- | --: | ---------------------------------------- | ------------------------------------------------------- |
| `changelog`        | `haiku`  |  16 | — (no `effort` in `command.schema.json`) | matches agent `changelog-assistant`                     |
| `dependabot-sweep` | `sonnet` |  15 | —                                        | dispatches 6 general-purpose subagents; no `tools:` key |
| `markdown`         | `haiku`  |  16 | —                                        | mechanical                                              |
| `merge-pr`         | `sonnet` |  16 | —                                        | gated merge                                             |
| `pr-tldr`          | `haiku`  |  16 | —                                        | summarization                                           |
| `pre-pr`           | `sonnet` |  17 | —                                        | `headless_safe: false` (L18)                            |
| `tldr`             | `haiku`  |  16 | —                                        | summarization                                           |

All seven are the artifacts whose `model:` is **physically copied** into
`.cli/skills/<id>/SKILL.md` and `.agents/skills/<id>/SKILL.md` (14 committed
copies).

---

## Harness Analysis

Runtime facts below come from probes run on 2026-09-17 on this machine. All six
CLIs are installed.

| CLI                | Version observed    | `--model`?                   | Effort flag?                                                               | Model listing?                              |
| ------------------ | ------------------- | ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Claude Code        | `2.1.274`           | yes, + `--fallback-model`    | `--effort low\|medium\|high\|xhigh\|max`                                   | not in `--help`                             |
| Codex CLI          | `codex-cli 0.154.0` | `-m/--model`, `-c model="…"` | not in `--help`                                                            | no                                          |
| Gemini CLI         | `0.59.0`            | `-m/--model`                 | not in `--help`                                                            | no (`gemini gemma` routes local Gemma only) |
| Antigravity CLI    | `1.2.4`             | `--model`                    | `--effort low\|medium\|high`                                               | **`agy models`**                            |
| GitHub Copilot CLI | `1.0.83`            | `--model`, incl. `auto`      | `--effort/--reasoning-effort none\|minimal\|low\|medium\|high\|xhigh\|max` | `copilot providers` (BYOK)                  |
| OpenCode           | `v2.0.5`            | not in `--help` top level    | not in `--help`                                                            | **`opencode models`**                       |

### Claude Code

- **Detection.** `RUNTIMES.claude`, `agents.mjs:99-107`. Every field is `null`
  and there is an explicit comment: "Claude Code is the tool dotbabel
  configures, not a fan-out destination. It is never gated on presence."
- **Config location.** `~/.claude/` via `bootstrap.sh` symlinks. In this repo
  `.claude/commands -> ../commands` and `.claude/skills -> ../skills`.
- **Does Dotbabel know about its models?** Only as a four-value alias enum
  (`validate-skills-inventory.mjs:10`) with no mapping to anything. The alias
  list omits `fable`, which `--help` confirms is a current Claude alias family.
- **Does Dotbabel know about effort?** It writes `low|medium|max` and validates
  none of it. The real set is `low, medium, high, xhigh, max` — so `high` and
  `xhigh` are unreachable through Dotbabel and `medium`/`max` happen to be
  valid by coincidence.
- **User overrides through Dotbabel?** No mechanism. The user overrides _around_
  Dotbabel by editing the symlinked file or using the session flag.
- **Model selection:** **static and inert.** A literal is written; nothing reads it.
- **Provider assumptions:** the enum _is_ the assumption. Also
  `templates/workflows/ai-review.yml:8,25` hard-wires `ANTHROPIC_API_KEY`.
- **Duplication:** 24 authored + 24 mirrored + 5 enum declarations.
- **Reusable abstraction:** `RUNTIMES.claude` exists as an entry with all-null
  capability fields — the natural slot for a `models` / `effortLevels`
  capability block.

### Codex CLI

- **Detection.** `detect: ["codex"]`, `agents.mjs:108-120`.
- **Config.** `CODEX_HOME` → `~/.codex`; user instruction `~/.codex/AGENTS.md`;
  project fan-out `.codex/skills` (observed as a symlink to `.cli/skills`).
- **Models?** No. Codex receives `model: opus` verbatim through the shared
  `.cli/skills` tree, and 7 real files under `.cli/skills/*/SKILL.md` carry
  `model: haiku`/`sonnet`.
- **Effort?** No. `codex --help` shows no effort flag; whether reasoning effort
  exists as a `config.toml` key at 0.154.0 is `UNCERTAIN` (not probed, and
  `--help` only documents the generic `-c key=value` form with the example
  `-c model="o3"`).
- **Overrides through Dotbabel?** No.
- **Model selection:** **absent.**
- **Provider assumptions:** one, and it is inverted — `handoff-extract.sh:275`
  stores `.model_provider` in the digest's `model` field.
- **Duplication:** 7 command copies in `.cli/skills/`.
- **Reusable:** `RUNTIMES.codex`; `handoff-extract.sh`'s `meta_codex`.

### Gemini CLI

- **Detection.** `detect: ["gemini"]`, `agents.mjs:121-133`.
- **Config.** `GEMINI_HOME` → `~/.gemini`; `~/.gemini/GEMINI.md`;
  `.gemini/skills -> ../.cli/skills`. Project artifact `GEMINI.md` is shared
  with Antigravity (`INSTRUCTION_ARTIFACTS.gemini`, `agents.mjs:290-295`).
- **Models?** No, except in the handoff extractor, which reads the _live_ model
  correctly from a transcript (`handoff-extract.sh:346`) and is tested
  (`handoff-extract.bats:146` asserts `gemini-2.5-pro`). That is the only
  correct model observation in the project besides Copilot's.
- **Effort?** No.
- **Overrides:** no.
- **Model selection:** **absent** in configuration; **read-only observation** in
  handoff.
- **Provider assumptions:** none encoded.
- **Duplication:** shares the 7 command copies via the `.cli/skills` symlink.
- **Reusable:** `meta_gemini` is a working per-harness model reader.

### Antigravity CLI

- **Detection.** `detect: ["agy"]`, `agents.mjs:147-177`. First runtime whose
  executable name differs from its id, which is why gates resolve through
  `detect`.
- **Config.** `ANTIGRAVITY_CONFIG_HOME` → `~/.gemini/config`; skills at
  `<root>/skills`; project fan-out `.agents/skills`, `shareable: false`
  (`agents.mjs:172-176`) — so it gets its own byte-identical copy of the tree.
- **Models?** No. And this is the harness where the gap is sharpest.
  **RUNTIME:** `agy models` returns identifiers that **fuse model and effort**
  (`gemini-3.8-flash-high`, `gemini-3.8-flash-medium`,
  `gemini-3.8-flash-low`, `gemini-3.1-pro-high`, `gemini-3.1-pro-low`) and
  include cross-provider entries (`claude-sonnet-4-6`,
  `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`).
- **Effort?** No. **RUNTIME:** `agy --effort` accepts only `low|medium|high`.
  The 11 skills carrying `effort: max` therefore name a level this harness
  rejects, and they are physically copied into `.agents/skills/`.
- **Overrides:** no.
- **Model selection:** **absent**, and the two-field `(model, effort)` shape
  Dotbabel uses does not map onto this harness at all.
- **Provider assumptions:** Dotbabel implicitly treats "harness" as a proxy for
  "provider". `agy models` disproves it.
- **Duplication:** a second full copy of the 7 command files, in
  `.agents/skills/` — 7 more committed `model:` literals.
- **Reusable:** `agy models` is a ready-made discovery source and the strongest
  argument for treating effort as harness-specific metadata rather than a shared
  enum.

### GitHub Copilot CLI

- **Detection.** `detect: ["copilot"]`, `agents.mjs:229-240`.
- **Config.** `~/.github/copilot-instructions.md` at user scope; project fan-out
  is `kind: "copilot-files"` → `.github/prompts/*.prompt.md` (7) and
  `.github/instructions/*.instructions.md` (37).
- **Models?** **This is the only harness Dotbabel reasons about correctly.**
  `copilot-frontmatter.mjs:46,60` drops `model`, `effort`, and
  `disable-model-invocation` with a warning, and
  `docs/copilot-frontmatter-mapping.md:31` explains why: "Claude's `model` is a
  tier enum … Copilot's is a free-form model identifier (e.g. `GPT-4o`). No safe
  crosswalk exists." Verified in the output: `.github/prompts/tldr.prompt.md`
  has no `model:` even though `commands/tldr.md:16` does.
- **Effort?** Dropped and warned. **RUNTIME:** Copilot's real set is the widest
  of all six (`none, minimal, low, medium, high, xhigh, max`) — a superset of
  Dotbabel's three.
- **Overrides:** `--model auto` exists (**RUNTIME**), and `copilot providers`
  manages BYOK model providers. Dotbabel has no concept of either.
- **Model selection:** **deliberately absent, and documented as such.** This is
  the correct behaviour under the current design.
- **Provider assumptions:** none — the docs explicitly call it routed/free-form.
- **Duplication:** the _bodies_ leak what the frontmatter mapper strips —
  `.github/instructions/agents-search.instructions.md:65-80,214-215` and
  `post-pr-review.instructions.md:101`.
- **Reusable:** `PROMPT_MD_KEY_RULES` / `INSTRUCTIONS_MD_KEY_RULES` are the
  prototype for a per-harness translation table. Today they express only
  "drop + warn"; they could express "translate".

### OpenCode

- **Detection.** `detect: ["opencode"]`, `agents.mjs:207-225`. Baseline v2.0.5,
  documented in the module comment as proven with `opencode debug paths`.
- **Config.** `OPENCODE_CONFIG_DIR` → `$XDG_CONFIG_HOME/opencode` →
  `~/.config/opencode`. Only runtime using `relativeTo: "configDir"` for its
  instruction file. Project fan-out `.opencode/skills`, `shareable: true`
  (observed as a symlink to `.cli/skills`). Reads the shared project `AGENTS.md`
  (`INSTRUCTION_ARTIFACTS.agents.runtimes`, `agents.mjs:267`).
- **Models?** No. **RUNTIME:** `opencode models` returns
  **provider-prefixed** ids — `local-qwen/qwen3-coder-30b-a3b`,
  `opencode/big-pickle`, `opencode/nemotron-3-ultra-free`,
  `opencode/union-alpha`, and six others. The list is account- and
  config-dependent: a local Ollama-style provider (`local-qwen/`) sits beside
  hosted ones.
- **Effort?** No flag in `--help`; `UNCERTAIN` whether per-model effort exists.
- **Overrides:** no.
- **Model selection:** **absent.**
- **Provider assumptions:** OpenCode is the harness where "provider" is a
  **first-class part of the model identifier**, which nothing in Dotbabel can
  represent.
- **Duplication:** shares the 7 command copies via the `.cli/skills` symlink.
- **Reusable:** `opencode models` is the second ready-made discovery source, and
  the one that proves the future schema needs `provider` and `model` as separate
  fields.

---

## Hardcoded Model and Effort References

Grouped as requested. Classification uses: **intentional pin**, **sensible
default**, **compatibility requirement**, **historical residue**, **duplicated
configuration**, **likely technical debt**, **unclear**. Being hardcoded is not
itself a defect; each entry says why.

### 1. Production behaviour

| Ref                                 | Location                                                                                                    | Value                                                                                                           | Classification                                                | Why                                                                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALID_MODELS`                      | `validate-skills-inventory.mjs:10`                                                                          | `opus, sonnet, haiku, inherit`                                                                                  | **compatibility requirement** _and_ **likely technical debt** | It is a real contract with Claude Code's frontmatter parser, so it must exist. It is debt because it is the _fifth_ copy of the same list and because it omits `fable`, so a currently-valid Claude alias fails CI.                |
| Required-field list                 | `validate-skills-inventory.mjs:271`                                                                         | `model` mandatory on agents                                                                                     | **unclear**                                                   | Making `model` required forbids `inherit`-by-omission — the most provider-neutral option. No document explains the choice.                                                                                                         |
| Error message strings               | `validate-skills-inventory.mjs:307-309`                                                                     | `"opus\|sonnet\|haiku\|inherit"` ×2                                                                             | **duplicated configuration**                                  | Hand-written, not derived from `VALID_MODELS`. Diverges silently.                                                                                                                                                                  |
| `model: null` for Claude            | `handoff-extract.sh:84`                                                                                     | literal `null`                                                                                                  | **likely technical debt**                                     | Claude transcripts are the one source Dotbabel reads most; hard-nulling the field is the only reason a Claude handoff digest cannot state its model. No comment explains it.                                                       |
| `.model_provider` → `model`         | `handoff-extract.sh:275`                                                                                    | provider stored as model                                                                                        | **likely technical debt**                                     | A semantic error, not a pin. The digest schema has one field and Codex supplies two concepts.                                                                                                                                      |
| Supported-CLI list                  | `handoff-extract.sh:9-11`                                                                                   | `claude \| copilot \| codex \| gemini`                                                                          | **historical residue**                                        | Predates Antigravity (#356) and OpenCode. The `RUNTIMES` registry knows six; this script knows four.                                                                                                                               |
| `ai-review.yml` model               | `templates/workflows/ai-review.yml:27`                                                                      | **no `--model`**                                                                                                | **unclear**                                                   | An always-on production review path with an unspecified model. Possibly intentional ("follow the CLI default"), but nothing says so, and the surrounding comment (L3-6) discusses provider choice without mentioning model choice. |
| `ANTHROPIC_API_KEY`                 | `templates/workflows/ai-review.yml:8,25`                                                                    | provider pin                                                                                                    | **intentional pin**                                           | The comment at L4-6 explicitly chose Claude-headless over Vercel Agent for portability reasons, and names the swap path. Deliberate and documented.                                                                                |
| `--max-turns 40`                    | `templates/workflows/ai-review.yml:28`                                                                      | budget                                                                                                          | **sensible default**                                          | An execution budget, not a model choice.                                                                                                                                                                                           |
| Tier order rule                     | `skills/agents-search/SKILL.md:225`                                                                         | "Tier order is fixed … Never reorder"                                                                           | **likely technical debt**                                     | Freezing a provider's tier ladder as behaviour is exactly what a provider-neutral system must undo.                                                                                                                                |
| Opus fleet-cost claim               | `skills/post-pr-review/SKILL.md:112-113`                                                                    | "Three of the four agents … run on `opus`"                                                                      | **duplicated configuration**                                  | True today, unlinked to the four agent files, untested.                                                                                                                                                                            |
| `security-auditor` in every profile | `skills/post-pr-review/SKILL.md:125-134`                                                                    | always dispatched                                                                                               | **intentional pin**                                           | Explicitly justified at L128-134: callers narrow their own security step assuming this one runs. A safety invariant, not a model preference.                                                                                       |
| `rollback-prod` bypass ban          | `.github/instructions/rollback-prod.instructions.md:51-52`                                                  | "No `--yes`, environment variable, autonomous mode, or **model routing decision** may bypass this confirmation" | **intentional pin**                                           | The only place the repo anticipates model routing and fences it off from a destructive path. Preserve verbatim.                                                                                                                    |
| Criteria verdict ban                | `docs/specs/qa-verification-harness/spec/7-non-functional-requirements.md:66`; `8-risks-alternatives.md:42` | "No text written by a model sets a criterion status"; A-8 rejected because "Model output varies between runs"   | **intentional pin**                                           | A deliberate rejection of model-derived verdicts. Directly constrains any future advisory system.                                                                                                                                  |

### 2. Agent definitions

| Ref                                          |                                                                           Count | Classification                                | Why                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------: | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model: opus`                                |                                                                              11 | **sensible default** for 9, **unclear** for 2 | Nine carry a written rationale in `description`. `compliance-auditor` and `data-scientist` carry none and came from an external catalogue (`source:` line) — their tiers are **incidental**. |
| `model: sonnet`                              |                                                                              11 | **sensible default**                          | Every one has a rationale clause.                                                                                                                                                            |
| `model: haiku`                               |                                                                               2 | **sensible default**                          | Both justified as formulaic.                                                                                                                                                                 |
| `model: inherit`                             |                                                                               0 | **unclear**                                   | The one provider-neutral value is unused everywhere.                                                                                                                                         |
| "Uses opus/sonnet/haiku — …" rationale prose | 22 in `agents/`, 22 in templates, 22 inside `index/artifacts.json` descriptions | **duplicated configuration**                  | The rationale is welded to the alias inside a user-facing description string. Retiering an agent requires editing prose in three places, one of which is generated JSON.                     |

### 3. Skill definitions

| Ref                        |                                                           Count | Classification                         | Why                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------: | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model: opus`              |                                                              17 | mixed                                  | **sensible default** for audit/review/spec skills; **unclear** for `review-prs` and `audit-and-fix`, whose own reasoning is coordination while the real work runs on `general-purpose` subagents — so the `opus` applies to the cheap half of the job. |
| `model: sonnet`            |                                                              19 | **sensible default**                   | Broadly consistent.                                                                                                                                                                                                                                    |
| no `model:`                |                                              1 (`local-attest`) | **sensible default**                   | Inheriting is correct for a thin CLI wrapper. It is also the only artifact that already does what category E would prescribe.                                                                                                                          |
| `effort: max`              |                                                              12 | **likely technical debt**              | Not a valid Antigravity level; not enforced anywhere; `max` is applied uniformly to every cloud specialist with no differentiation.                                                                                                                    |
| `effort: medium`           |                                                               5 | **sensible default**                   | Plausible and harness-valid.                                                                                                                                                                                                                           |
| `effort: low`              |                                              1 (`project-sync`) | **sensible default**                   | Matches the work.                                                                                                                                                                                                                                      |
| no `effort:`               |                                19 skills, 24 agents, 7 commands | **unclear**                            | Absence is indistinguishable from "deliberately inherit". No `inherit`/`adaptive` sentinel exists for effort.                                                                                                                                          |
| `disable-model-invocation` |                                                               6 | **intentional pin**                    | Required by `CONTRIBUTING.md:98-99` for side-effectful skills. This is auto-routing control, **not** model selection — keep the two separate in any future schema.                                                                                     |
| `headless_safe: false`     | 4 (`pre-pr`, `pr-conductor`, `release-conductor`, `review-prs`) | **intentional pin**, with a schema gap | Declared in `command.schema.json:25` only; three of the four uses are on **skills**, where `skill.schema.json` does not declare it (it passes via `additionalProperties: true`).                                                                       |

### 4. Templates and generated files

| Ref                                                                      |                  Count | Classification                                   | Why                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ---------------------: | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugins/dotbabel/templates/claude/{agents,skills,commands}/**` `model:` |                     67 | **duplicated configuration** — but **necessary** | `scripts/build-plugin.mjs` strips only `owner/created/updated` (L43). The mirror is what consumers install, so the values must be there. CI enforces the mirror (`dogfood.yml:42`), so it is not drift-prone. It does double every literal. |
| `templates/claude/skills/**` `effort:`                                   |                     18 | same                                             | same                                                                                                                                                                                                                                        |
| `.cli/skills/{7 commands}/SKILL.md` `model:`                             |                      7 | **likely technical debt**                        | Anthropic tier aliases committed into the Codex/Gemini/OpenCode tree.                                                                                                                                                                       |
| `.agents/skills/{7 commands}/SKILL.md` `model:`                          |                      7 | **likely technical debt**                        | The same seven again, for Antigravity.                                                                                                                                                                                                      |
| `.github/prompts/*.prompt.md`, `.github/instructions/*.instructions.md`  |             0 `model:` | **correct**                                      | The Copilot mapper stripped them. Verified.                                                                                                                                                                                                 |
| `.github/instructions/agents-search.instructions.md:65-80,214-215`       | tier taxonomy in prose | **likely technical debt**                        | Body leaks what frontmatter stripping removed.                                                                                                                                                                                              |
| `.github/instructions/post-pr-review.instructions.md:101`                |        opus cost claim | **duplicated configuration**                     | Third copy.                                                                                                                                                                                                                                 |
| `.github/instructions/spec.instructions.md:280`                          | `/think`, `/ultraplan` | **historical residue**                           | Neither command exists in this repo.                                                                                                                                                                                                        |
| `index/artifacts.json` 22 "Uses …" descriptions                          |                     22 | **duplicated configuration**                     | Generated, so self-healing on rebuild — but it means the alias is published in the search index as prose while the structured field is dropped.                                                                                             |

### 5. Tests and fixtures

| Ref                                                               | Location                                                   | Classification                   | Why                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model: turbo` rejection                                          | `tests/validate-skills-inventory.test.mjs:232-241`         | **compatibility requirement**    | Correctly proves unknown aliases are rejected. Uses a fictitious name, so it will not break when real aliases change. Good design.                                                                |
| Four-value loop                                                   | `tests/validate-skills-inventory.test.mjs:244-257`         | **duplicated configuration**     | A sixth literal copy of the enum.                                                                                                                                                                 |
| `model: gpt-5`                                                    | `tests/bats/handoff-extract.bats:53`, asserted at L126     | **sensible default** (a fixture) | Realistic Copilot fixture. Will look dated but tests only extraction plumbing.                                                                                                                    |
| `model: gpt-4o`                                                   | `tests/bats/dotbabel-handoff-five-form.bats:37`            | **historical residue**           | An older fixture value than the sibling file's `gpt-5`; nothing keeps them aligned.                                                                                                               |
| `model: gemini-2.5-pro`                                           | `tests/bats/handoff-extract.bats:96-101`, asserted at L146 | **sensible default** (a fixture) | Same reasoning.                                                                                                                                                                                   |
| `model = "gpt-4"`                                                 | `tests/fixtures/handoff-sessions.mjs:63`                   | **historical residue**           | Third, oldest fixture generation of the same concept.                                                                                                                                             |
| `model: opus` + `effort: high` + `disable-model-invocation: true` | `tests/copilot-frontmatter.test.mjs:212-214`               | **compatibility requirement**    | **Note:** `effort: high` is not in `skill.schema.json`'s `low\|medium\|max` enum. The test is right about the real world and wrong about Dotbabel's own schema — evidence the enum is too narrow. |
| `model: inherit / sonnet / haiku`                                 | `tests/build-index.test.mjs:56,87,101`                     | **compatibility requirement**    | Index-building fixtures.                                                                                                                                                                          |
| No test asserts the Claude or Codex digest `model`                | `tests/bats/handoff-extract.bats:113-137`                  | **likely technical debt**        | The two broken extractors are the two with no model assertion.                                                                                                                                    |

### 6. Documentation and examples

| Ref                            | Location                                                                                    | Classification                                       | Why                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Alias → concrete ID table      | `docs/specs/dotbabel-agents/spec/5-interfaces-apis.md:29-31`                                | **historical residue**                               | `claude-opus-4-6` / `claude-sonnet-4-6` / `claude-haiku-4-5`. Stale, unchecked, and the repo's only concrete Claude IDs. |
| Starter tier table             | `…/5-interfaces-apis.md:36-45`                                                              | **duplicated configuration**                         | Duplicates 8 agents' `model:` values.                                                                                    |
| Implementation-plan tier list  | `…/6-implementation-plan.md:62-64`                                                          | **duplicated configuration**, already drifted        | Assigns `validate-spec` to `opus`; the shipped skill is `sonnet`.                                                        |
| Enum restatements              | `…/6-implementation-plan.md:25,48,86,138`                                                   | **duplicated configuration**                         | Four more copies.                                                                                                        |
| R-3 cost risk                  | `…/8-risks-alternatives.md:11`                                                              | **sensible default** (as policy)                     | The only written cost guidance. Advice, not a gate.                                                                      |
| `GPT-4o` example               | `docs/copilot-frontmatter-mapping.md:31`                                                    | **historical residue**                               | Illustrative and now dated, but the surrounding claim is the best analysis in the repo.                                  |
| Drop lists                     | `docs/quickstart.md:149-161`, `docs/cli-reference.md:458-468`                               | **duplicated configuration**                         | Two more copies of the Copilot drop rule.                                                                                |
| Copilot-only enum docs         | `.github/copilot-instructions.md:106-111`; `.github/copilot-review-instructions.md:102-104` | **duplicated configuration** + **unclear asymmetry** | The enum is documented to Copilot and to no other runtime.                                                               |
| "model-agnostic" rebrand claim | `docs/upgrade-guide.md:43`                                                                  | **the project's own stated goal**                    | "Strategic rebrand to position the toolkit as model-agnostic." The rename happened; the model layer did not follow.      |

### 7. Installation, bootstrap, and update logic

| Component                                                                                                             |                                     Model/effort refs | Classification                                                              |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------: | --------------------------------------------------------------------------- |
| `bootstrap.sh`                                                                                                        |                                                     0 | **correct** — grep for `model\|effort\|opus\|sonnet\|haiku` returns nothing |
| `install.sh`                                                                                                          |                                                     0 | **correct**                                                                 |
| `sync.sh`                                                                                                             |                                                     0 | **correct**                                                                 |
| `src/bootstrap-global.mjs`, `sync-global.mjs`, `init-harness-scaffold.mjs`, `project-init-scaffold.mjs`               |                                                     0 | **correct**                                                                 |
| `src/detect-drift.mjs`, `check-instruction-drift.mjs`, `check-instructions-fresh.mjs`, `check-instruction-parity.mjs` |                                                     0 | **gap, not debt** — no drift detector covers model or effort                |
| `plugins/dotbabel/hooks/*.sh`, `.claude/hooks/*.sh`                                                                   | 0 (only the word "model" meaning the LLM in comments) | **correct**                                                                 |
| `examples/minimal-consumer/**`                                                                                        |            0 in frontmatter; inherits `ai-review.yml` | see the CI-template row                                                     |

**Net:** bootstrap, sync, install, and hook layers are entirely model-free. Every
hardcoded reference lives in artifact frontmatter, one validator, three schemas,
one shell extractor, one CI template, and documentation.

---

## Configuration Inheritance

### Hierarchy 1 — an agent's effective model

```
1. agents/<id>.md            model: opus          ← SOURCE OF TRUTH
2. build-plugin mirror        model: opus          (byte-identical; owner/created/updated stripped)
3. bootstrap.sh symlink       ~/.claude/agents/<id>.md
4. USER edits that file       model: sonnet        ← can override; Dotbabel never notices
5. Claude Code session        `claude --model X` / `/model` / `--effort Y`
6. EFFECTIVE MODEL            decided at 4–5, INVISIBLE to Dotbabel
```

1. **Source of truth:** the authored `agents/<id>.md` frontmatter.
2. **Can override:** the user at step 4 or 5. Nothing inside Dotbabel.
3. **Which wins:** the harness. `LIKELY` step 4 beats step 1 (it is the same
   file) and step 5's interaction with a subagent's `model:` is `UNCERTAIN` from
   repository evidence alone.
4. **Tested?** No. `validate-skills-inventory.test.mjs:375-384` asserts the
   mirror validates; nothing tests what any consumer resolves.
5. **Could effective ≠ apparent?** **Yes, always.** Steps 4–6 are outside
   Dotbabel's observation entirely, and `handoff-extract.sh:84` deliberately
   discards the one signal that could close the loop.

### Hierarchy 2 — a skill's effective model across six harnesses

```
skills/<id>/SKILL.md   model: opus   effort: max
        │
        ├── Claude Code ────────── ~/.claude/skills/<id>  (symlink) → alias honoured?  UNCERTAIN
        ├── Codex ──────────────── .codex/skills → .cli/skills → .claude/skills        alias PASSED THROUGH, meaning UNKNOWN
        ├── Gemini ─────────────── .gemini/skills → .cli/skills → .claude/skills       alias PASSED THROUGH
        ├── OpenCode ───────────── .opencode/skills → .cli/skills → .claude/skills     alias PASSED THROUGH
        ├── Antigravity ────────── .agents/skills (separate copy, shareable: false)     alias PASSED THROUGH; `effort: max` INVALID for agy
        └── Copilot ────────────── .github/instructions/<id>.instructions.md            model + effort DROPPED, warned
```

1. **Source of truth:** the authored `SKILL.md`.
2. **Can override:** only Copilot's mapper, and only by deleting.
3. **Which wins:** unknown per harness. Five of six get an uninterpreted key.
4. **Tested?** `copilot-frontmatter.test.mjs:88-102` tests the drop. **Nothing
   tests the pass-through.** No test asserts what `.cli/skills` or
   `.agents/skills` receive for `model`/`effort`.
5. **Could effective ≠ apparent?** **Yes — for five of six harnesses the
   apparent value is not even in the right vocabulary.**

### Hierarchy 3 — runtime detection (the one that works)

```
RUNTIMES registry  (agents.mjs:96)            ← SOURCE OF TRUTH
        │
        ├── config root      envVar → $XDG_BASE/<subdir> → $HOME/<baseDir>   (agents.mjs:414-424)
        ├── presence         detect[] → commandExists()                      (agents.mjs:396-400)
        └── fan-out          .dotbabel.json fan_out / fan_out_layout /
                             gate_on_cli_presence                            (.dotbabel.json:6-8)
```

1. **Source of truth:** the frozen `RUNTIMES` literal.
2. **Can override:** per-runtime env vars; `.dotbabel.json` for the fan-out set.
3. **Which wins:** documented precedence, resolved in exactly one function.
4. **Tested?** Heavily — `tests/agents.test.mjs`, `tests/bootstrap-global.test.mjs:417`,
   `tests/dotbabel-doctor.test.mjs:149-176`, `tests/project-sync.test.mjs:299`.
5. **Could effective ≠ apparent?** No — `resolveGlobalConfigDir` is the single
   resolver, which is why the module comment insists on it.

### Hierarchy 4 — quality policy (the pattern to copy)

```
SHIPPED_QUALITY_DEFAULTS + QUALITY_RULES  (quality/policy.mjs:28-70)   ← SOURCE OF TRUTH
        └── .dotbabel.json `quality` key                               (.dotbabel.json:11-47)
              └── CLI flags: --profile / --path / --all / --base
                    └── measurement STATE is reported explicitly:
                        checked | unsupported | not_configured |
                        not_triggered | unavailable | not_applicable | skipped
                                                          (quality/types.mjs:14-22)
```

1. **Source of truth:** shipped frozen defaults.
2. **Can override:** project config, then flags.
3. **Which wins:** flags > project > shipped, and `dotbabel quality explain`
   prints the resolution.
4. **Tested?** Yes, across the quality suite.
5. **Could effective ≠ apparent?** No — and when a measurement _cannot_ be
   made, the system says so instead of guessing. **This is the property the
   model layer lacks completely.**

### Hierarchy 5 — the one that does not exist

```
model recommendation
└── (nothing)
    ├── no global default
    ├── no per-harness default
    ├── no task→strength policy
    ├── no escalation rule
    └── no way to ask "what model am I running on"
```

---

## Duplication Analysis

| Knowledge duplicated                                              | Locations                                                                                                                                                                                                                                                                                                                                                           |                    Count | Consequence                                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 4-value model enum `opus \| sonnet \| haiku \| inherit`       | `validate-skills-inventory.mjs:10`; `:307`; `:308`; `schemas/agent.schema.json:22`; `schemas/skill.schema.json:31`; `schemas/command.schema.json:14`; `.github/copilot-instructions.md:109`; `.github/copilot-review-instructions.md:104`; `docs/specs/dotbabel-agents/spec/6-implementation-plan.md:25,48,138`; `tests/validate-skills-inventory.test.mjs:240,245` |    **9 files, 13 sites** | Adding `fable` (or any new alias) means 13 coordinated edits. Only one site is executable, so the other 12 can be wrong without any test failing. The two error-message strings are hand-copied from the `Set` three lines above them. |
| Per-artifact `model:` literal                                     | authored 67 + template mirror 67 + fan-out copies 14                                                                                                                                                                                                                                                                                                                |    **148 literal sites** | CI (`dogfood.yml:42`) keeps authored ↔ template in sync, so the mirror is safe. The 14 fan-out copies are the leak: Anthropic aliases committed into four non-Anthropic harness trees.                                                 |
| Per-artifact `effort:` literal                                    | authored 18 + template mirror 18                                                                                                                                                                                                                                                                                                                                    |             **36 sites** | Same mirroring. No validation at all, so a typo ships silently.                                                                                                                                                                        |
| The model rationale prose "Uses opus — …"                         | `agents/*.md` (22) + `templates/claude/agents/*.md` (22) + `index/artifacts.json` descriptions (22)                                                                                                                                                                                                                                                                 |             **66 sites** | Retiering an agent requires rewriting its user-facing description too, in a generated JSON file and two markdown copies. The alias is welded to the justification.                                                                     |
| The agent tier assignments                                        | `agents/*.md` frontmatter (24) + `docs/specs/…/5-interfaces-apis.md:36-45` (8) + `…/6-implementation-plan.md:62-64` (list)                                                                                                                                                                                                                                          | **3 independent tables** | **Already drifted:** `6-implementation-plan.md:62` puts `validate-spec` on `opus`; `skills/validate-spec/SKILL.md:24` says `sonnet`. Nothing detects it.                                                                               |
| The "Claude Code resolves it natively, no tooling needed" premise | `docs/specs/dotbabel-agents/spec/3-high-level-architecture.md:7,22`; `…/4-data-flow-components.md:28,64`; `…/7-non-functional-requirements.md:9` (PERF-3)                                                                                                                                                                                                           |      **5 sites, 1 spec** | Stated five times for one harness, then inherited by five more without restatement or re-verification. The premise, not the literals, is the thing that needs migrating.                                                               |
| The `agents-search` tier taxonomy                                 | `skills/agents-search/SKILL.md:83-87,225`; `templates/claude/skills/agents-search/SKILL.md`; `.github/instructions/agents-search.instructions.md:72-77,214-215`                                                                                                                                                                                                     |              **3 files** | The tier ladder is behaviour in a skill body, fanned out to Copilot, and separate from the enum in `VALID_MODELS`. Two places can disagree about what a tier is.                                                                       |
| The `opus` fleet-cost claim                                       | `skills/post-pr-review/SKILL.md:112-113`; `templates/claude/skills/post-pr-review/SKILL.md`; `.github/instructions/post-pr-review.instructions.md:101`                                                                                                                                                                                                              |              **3 files** | Asserts a fact about four other files. Retier any of the four and all three copies become wrong. No test links them.                                                                                                                   |
| The Copilot drop rule                                             | `copilot-frontmatter.mjs:46-48,60-62`; `docs/copilot-frontmatter-mapping.md:31-33,52-54,83-84`; `docs/quickstart.md:149-161`; `docs/cli-reference.md:458-468`                                                                                                                                                                                                       |              **4 files** | Behaviour plus three prose copies. The behaviour is tested; the prose is not.                                                                                                                                                          |
| Handoff model fixtures                                            | `tests/bats/handoff-extract.bats:53` (`gpt-5`); `tests/bats/dotbabel-handoff-five-form.bats:37` (`gpt-4o`); `tests/fixtures/handoff-sessions.mjs:63` (`gpt-4`)                                                                                                                                                                                                      |        **3 generations** | Three different vintages of the same fixture concept. Harmless today; a signal there is no single fixture source.                                                                                                                      |

---

## Staleness Analysis

| Current assumption                                                                                                         | Failure mode                                                                                                                                                                                                                                                                                                                   | Detection today                                                                                                                                                         | Likely impact                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The harness resolves `model:` natively, so no tooling is required" (`3-high-level-architecture.md:7`, PERF-3)             | True for Claude Code, asserted for nothing else. Five harnesses now receive a key whose handling was never verified. Every finding below is downstream of this one.                                                                                                                                                            | **None.** No test, no doctor check, no drift detector asks whether a harness understands the field.                                                                     | **High.** The assumption is invisible because it reads as settled architecture rather than as an open question.                                                   |
| A provider's tier ladder has exactly 3 rungs + `inherit`                                                                   | A new alias (`fable`) is a hard validation error. `validate-skills-inventory.mjs:10` rejects it, so `dotbabel-validate-skills` fails in `dogfood.yml:28` and `npm run dogfood`.                                                                                                                                                | **Yes — but as a false failure.** CI blocks the correct value.                                                                                                          | **High.** The gate inverts: it protects against typos by forbidding new reality. Already live — `fable` is a current Claude alias and the enum has no row for it. |
| `opus`/`sonnet`/`haiku` map to `claude-opus-4-6` / `claude-sonnet-4-6` / `claude-haiku-4-5` (`5-interfaces-apis.md:29-31`) | The alias moved; the doc did not. Readers plan against retired IDs.                                                                                                                                                                                                                                                            | **None.** No test, no stamp check, no drift detector reads this table.                                                                                                  | **High.** Already stale: 2 of 3 rows name a superseded generation, and the current top tier has no row.                                                           |
| A moving alias is a stable pin                                                                                             | `sonnet` silently points at a newer, differently-priced, differently-behaved model. Every agent's effective behaviour changes with no repo diff.                                                                                                                                                                               | **None.** No effective-model observation anywhere; `handoff-extract.sh:84` nulls the one signal.                                                                        | **High.** Invisible behaviour drift across all 67 artifacts, including `security-auditor`.                                                                        |
| A model is deprecated / withdrawn                                                                                          | The alias resolves to a fallback or errors. `--fallback-model` exists in Claude Code but Dotbabel never sets it.                                                                                                                                                                                                               | **None.**                                                                                                                                                               | **Medium.** A run degrades or fails; Dotbabel cannot attribute the cause.                                                                                         |
| Effort has 3 levels (`low`, `medium`, `max`)                                                                               | Real sets are 5 (Claude), 7 (Copilot), 3-but-different (Antigravity `low\|medium\|high`). `high`, `xhigh`, `none`, `minimal` are unreachable; `max` is invalid for Antigravity.                                                                                                                                                | **None in code.** JSON-Schema warns only (`build-index.mjs:474-481`). `tests/copilot-frontmatter.test.mjs:213` already uses out-of-enum `effort: high` without failing. | **High.** 11 skills carry `effort: max` and are copied into `.agents/skills/` where the level does not exist.                                                     |
| A level is added or removed by a provider                                                                                  | Dotbabel's enum silently diverges further.                                                                                                                                                                                                                                                                                     | **None.**                                                                                                                                                               | **Medium.** Growing mismatch; no signal.                                                                                                                          |
| Effort semantics are comparable across harnesses                                                                           | `medium` on Claude, Copilot, and Antigravity are three different vendors' scales; Antigravity encodes effort **in the model id** (`gemini-3.8-flash-medium`).                                                                                                                                                                  | **None.**                                                                                                                                                               | **Medium.** A shared enum implies a shared meaning that does not exist.                                                                                           |
| Each harness exposes models the same way                                                                                   | **RUNTIME:** `agy models` → tab-separated `id<TAB>label`; `opencode models` → newline `provider/model`; Codex/Gemini → no list subcommand at all.                                                                                                                                                                              | **None** — Dotbabel calls neither, so a syntax change cannot break it _and_ cannot be noticed.                                                                          | **Medium** once discovery is built; **zero** today.                                                                                                               |
| A harness has no Auto/Adaptive mode                                                                                        | **RUNTIME:** `copilot --model auto` exists ("use 'auto' to let Copilot pick automatically").                                                                                                                                                                                                                                   | **None.** No representation for "the harness chooses".                                                                                                                  | **Medium.** A recommendation layer would fight a router that is already doing the job.                                                                            |
| Model and effort are orthogonal fields                                                                                     | **RUNTIME:** Antigravity fuses them (`gemini-3.1-pro-high`).                                                                                                                                                                                                                                                                   | **None.**                                                                                                                                                               | **High** for schema design. The two-field shape cannot round-trip Antigravity.                                                                                    |
| A harness maps to one provider                                                                                             | **RUNTIME:** `agy models` lists `claude-sonnet-4-6` and `gpt-oss-120b-medium`; `opencode models` lists `local-qwen/…` beside hosted ids.                                                                                                                                                                                       | **None.** Dotbabel has no `provider` concept at all.                                                                                                                    | **High.** Any provider inference from harness identity is wrong.                                                                                                  |
| OpenCode's provider set is fixed                                                                                           | **RUNTIME:** ids are `provider/model`; the observed list includes a local provider (`local-qwen/`) and nine `opencode/` hosted models. Adding a provider changes the id space.                                                                                                                                                 | **None.**                                                                                                                                                               | **Medium.**                                                                                                                                                       |
| Copilot's router behaviour is stable                                                                                       | Its model list is account/subscription-scoped; `copilot providers` manages BYOK.                                                                                                                                                                                                                                               | **None.** `docs/copilot-frontmatter-mapping.md:31` cites `GPT-4o` as the example — already dated.                                                                       | **Low** today (Dotbabel drops the field), **medium** if translation is ever added.                                                                                |
| Model availability is uniform across accounts                                                                              | `agy models` prints "Fetching available models…" — the list is fetched, therefore account-scoped. `opencode models` reflects local config.                                                                                                                                                                                     | **None.**                                                                                                                                                               | **Medium.** A recommendation valid for one user is invalid for another.                                                                                           |
| The handoff digest's `model` is one value                                                                                  | `references/copilot.md:136-137` already notes "Copilot sessions can span multiple model changes in one transcript; the digest should note the model(s) used, not just the first one" — and the extractor takes the first (`handoff-extract.sh:229`). `digest-schema.md:15` says `<model-id-or-list>` but nothing emits a list. | **Documented, not implemented, not tested.**                                                                                                                            | **Low.** Digest fidelity only.                                                                                                                                    |
| Four harnesses is the full set for handoff                                                                                 | `handoff-extract.sh:9-11` lists 4; `RUNTIMES` has 6.                                                                                                                                                                                                                                                                           | **None** — no test asserts extractor coverage matches the registry.                                                                                                     | **Medium.** Antigravity and OpenCode sessions cannot be read.                                                                                                     |
| `post-pr-review`'s fleet is 3× opus + 1× haiku                                                                             | Retiering any of the four agents falsifies the prose in 3 files.                                                                                                                                                                                                                                                               | **None.**                                                                                                                                                               | **Medium.** A cost heuristic quietly stops matching reality.                                                                                                      |
| `/think` and `/ultraplan` are available escalations                                                                        | Neither exists in `commands/` or `skills/`.                                                                                                                                                                                                                                                                                    | **None.**                                                                                                                                                               | **Low.** Dangling advice, fanned out to Copilot.                                                                                                                  |

---

## Existing Reusable Abstractions

Ranked by how directly each could carry model/effort knowledge.

### 1. `RUNTIMES` registry — `plugins/dotbabel/src/agents.mjs:96-241`

The single best fit. It is already "pure data plus resolvers … reads no files
and runs no project commands" (module header, L24-26), already keyed by the six
harnesses, and already versions its facts against observed CLI behaviour
("baseline: v2.0.5", "agy v1.2.4"). The `Runtime` typedef (L77-86) has slots for
`detect`, `configDir`, `globalInstruction`, `globalSkills`, `projectFanOut` —
and **no model or effort field**, which is exactly where per-harness capability
metadata would go (supported effort levels, whether effort is fused into the
model id, whether a model-list subcommand exists and its argv).

Its resolver functions are the shape a model resolver needs:
`resolveGlobalConfigDir` (L414-424) demonstrates documented multi-source
precedence in one place; `anyRuntimePresent` (L396-400) demonstrates a pure
detection predicate kept separate from caller policy — the module comment at
L385-391 explains why force-mode was deliberately _not_ folded in. That
separation is the same one a future system needs between "what is available" and
"what policy wants".

### 2. Quality policy + adapter layer — `plugins/dotbabel/src/quality/**`

Structurally the closest existing analogue to a model-recommendation system.

- `quality/types.mjs:14-22` — `QUALITY_STATES` = `checked, unsupported,
not_configured, not_triggered, unavailable, not_applicable, skipped`. This is
  the **vocabulary for unknown models and unsupported effort levels**, already
  shipped and already tested. The rule floor even forbids misreporting it
  ("Report unsupported, unavailable, and not-configured measurements. Never
  claim that an unsupported metric passed").
- `quality/policy.mjs:28-55` — `QUALITY_RULES`, each with `class`, `scope`,
  `profiles`, `default_level`, `on_unavailable`, and optional
  `threshold`/`unit`/`direction`. A per-task model policy has the same shape: an
  id, a class, a default, and an explicit behaviour when the resource is absent.
- `quality/policy.mjs:6` + `types.mjs:2` — `QUALITY_PROFILES = fast | pr | deep`.
  A stable, named, harness-independent intensity ladder that already exists and
  is already the thing users name on the command line. It is the precedent for
  semantic effort levels that are **not** a provider's enum.
- `quality/adapters/registry.mjs:7-12` — an explicit frozen registry with a
  `getQualityAdapter(language)` lookup and the comment "Repository code cannot
  extend it". Each adapter exposes `discover()` and `plan()`
  (`adapters/go.mjs`, `javascript.mjs`). A per-harness model adapter with
  `discoverModels()` and `planInvocation()` is the same contract.
- `availability: "available" | "candidate" | "not_configured"` and
  `source: "project" | "built-in" | "configured" | "repository-script"` on every
  plan (`adapters/go.mjs`, `make-tools.mjs`) — provenance tracking per resolved
  value, which is what a model recommendation needs to be auditable.
- `quality/discovery.mjs:6-8` — the composition point where registry, capability
  rules, and trust meet.
- `trust-allowlist.mjs` / `criteria/trust-check.mjs` — per-realpath trust before
  executing a project command. Probing a harness CLI for its model list is
  exactly such an execution.

### 3. Copilot frontmatter mapper — `plugins/dotbabel/src/copilot-frontmatter.mjs`

The only existing **per-harness translation table** for frontmatter.
`PROMPT_MD_KEY_RULES` (L42-49) and `INSTRUCTIONS_MD_KEY_RULES` (L55-63) are
`{key: {to?, warnOnDrop?}}` maps applied by one generic function
`applyKeyRules` (L78-88). Today the rules for `model`/`effort` say only
"drop and warn"; the same table shape extends to `{translate: fn}`. The module
is "pure and I/O-free" (L4-6) and fully tested
(`tests/copilot-frontmatter.test.mjs:88-102`). Its header even flags its own
staleness risk: "GitHub's schema (public preview, may drift — re-verify before
relying on this table long-term)" — the right instinct, applied to the wrong
half of the problem.

### 4. Index + schema pipeline — `plugins/dotbabel/src/build-index.mjs`, `schemas/**`

- `compileSchemas` (L441-472) loads eight schemas into one Ajv instance and
  compiles per-type validators. Adding a `model-capability.schema.json` is a
  one-line change to the `files` array (L444-453).
- `validateArtifacts` (L482-502) is explicitly non-blocking ("Phase 1 …
  all schema errors become warnings, never hard errors"). That escalation path —
  warn first, enforce later — is the migration mechanism a new model schema
  needs.
- `isIndexStale` (L514-…) plus `dotbabel-index --check` gives a freshness gate
  that "ignores the `generatedAt` field", i.e. content-addressed staleness. A
  cached model catalogue needs exactly this.
- `schemas/index-entry.schema.json:7` is `additionalProperties: true`, so adding
  `model` and `effort` to index entries is backward-compatible.

### 5. Handoff extractor — `plugins/dotbabel/scripts/handoff-extract.sh`

The only code in the project that **observes** a live model. `meta_copilot`
(L203-240) and `meta_gemini` (L339-371) are working per-harness readers with
passing assertions (`handoff-extract.bats:126,146`). The dispatch shape —
`meta <cli> <file>` with one function per CLI — is a ready-made per-harness
introspection interface. It needs two fixes (Claude's hard `null`, Codex's
provider/model conflation) and two additions (Antigravity, OpenCode) to become a
general "what model is this session on" probe.

### 6. `commandExists` — `plugins/dotbabel/src/lib/symlink.mjs:117`

The only CLI probe in the project. Presence-only: no version, no capability. A
model system needs version-aware probing, but this is where it plugs in, and
`agents.mjs:30` already imports it.

### 7. Instruction-drift checkers — `src/check-instruction-drift.mjs`, `check-instructions-fresh.mjs`, `check-instruction-parity.mjs`, `check-repo-facts-keys.mjs`

A working "generated artefact must match its source, and the fact list must be
documented everywhere it is claimed" invariant, enforced in CI
(`package.json` `dogfood` script). The same machinery could assert
"every model literal traces to one declared policy" — the fix for the ten
duplication clusters listed under Duplication Analysis.

### 8. `scripts/build-plugin.mjs`

`AUTHORING_FIELDS` (L43) is the existing per-field policy for what crosses the
authored → shipped boundary. It currently holds three fields; a model-policy
layer would add its own entries there rather than inventing a second mechanism.

### 9. `.dotbabel.json` config + `dotbabel.config.schema.json`

The per-repo override surface. Already carries the `quality` key with nested
rules, thresholds, and per-component tool overrides — a demonstrated home for a
future `models` key with the same precedence discipline.

---

## Gaps

### Discovery

| Gap                                                                              | Evidence                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dotbabel cannot enumerate models for any harness.                                | No code calls any model-list command. `agy models` and `opencode models` both work (**RUNTIME**) and neither is referenced anywhere in the repo.                                                                                                                 |
| Dotbabel cannot determine supported effort modes.                                | No code reads `--help` or any capability source. The three-value enum in `schemas/skill.schema.json:33-36` was written, not discovered, and matches no harness.                                                                                                  |
| Dotbabel cannot detect installed CLI **capabilities** — only presence.           | `commandExists` (`lib/symlink.mjs:117`) returns a boolean. `anyRuntimePresent` (`agents.mjs:396-400`) is the only consumer. No `--version` is read for any of the six CLIs, even though every one reports it.                                                    |
| Dotbabel cannot detect a harness's **version**, so it cannot gate on capability. | `RUNTIMES` pins observed baselines in _comments_ ("baseline: v2.0.5", "agy v1.2.4") with no runtime check.                                                                                                                                                       |
| Dotbabel cannot observe the model a session is actually using.                   | `handoff-extract.sh:84` hardcodes Claude's to `null`; Codex's is the provider (L275); Antigravity and OpenCode have no extractor.                                                                                                                                |
| No caching layer for a model catalogue.                                          | `agy models` prints "Fetching available models…", so discovery is a network call. The nearest cache pattern is `~/.claude/cache/agents-catalog.md` with a 12 h TTL, and it lives **inside a skill body** (`skills/agents-search/SKILL.md:182-194`), not in code. |

### Schema

| Gap                                                                            | Evidence                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `provider` concept anywhere.                                                | `grep` for a model-provider field returns nothing. `provider` in this repo means a cloud or Terraform provider.                                                                                                                              |
| Effort is a closed 3-value enum.                                               | `schemas/skill.schema.json:33-36`. Real sets: 5 / 7 / 3-different.                                                                                                                                                                           |
| Effort is not declarable on agents or commands.                                | `agent.schema.json` and `command.schema.json` have no `effort` property; only `skill.schema.json` does.                                                                                                                                      |
| No representation for an unknown or new model.                                 | `VALID_MODELS` (`validate-skills-inventory.mjs:10`) is a closed `Set` producing a hard error. There is no `unknown` / `unsupported` state for a model, although `quality/types.mjs:14-22` already defines exactly that vocabulary for tools. |
| No capability metadata on the `Runtime` typedef.                               | `agents.mjs:77-86`.                                                                                                                                                                                                                          |
| Model and effort are assumed orthogonal.                                       | Antigravity fuses them (**RUNTIME**). Two independent scalar fields cannot express `gemini-3.8-flash-high`.                                                                                                                                  |
| No sentinel distinguishing "deliberately inherit" from "forgot".               | For `model`, `inherit` exists but is used **zero** times. For `effort`, no such value exists — 50 artifacts simply omit the key.                                                                                                             |
| `model`/`effort` are absent from the index entry shape.                        | `schemas/index-entry.schema.json:9-43`; verified by key union over all 68 entries.                                                                                                                                                           |
| `headless_safe` is schema-declared for commands only but used on three skills. | `command.schema.json:25` vs `skills/{pr-conductor,release-conductor,review-prs}`. Passes only because of `additionalProperties: true`.                                                                                                       |
| `invocation: passive \| explicit` is declared and never used.                  | `agent.schema.json:24-27`; `grep '^invocation:'` → no match. A dead execution-mode field that a future design should either use or remove.                                                                                                   |

### Policy

| Gap                                                                                | Evidence                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No task-complexity abstraction.                                                    | `facets.schema.json:39-53` gives task **kind** (`review`, `debugging`, `provisioning`, …). Nothing expresses required reasoning depth. Tier choice is made per artifact, in prose, 67 times.                                  |
| No escalation or de-escalation semantics.                                          | The only escalation hints in the repo are `/think` and `/ultraplan` (`skills/spec/SKILL.md:291`), and neither command exists.                                                                                                 |
| Model strength and parallelism are conflated in reasoning, separated in mechanism. | `post-pr-review` sizes its **fleet** to control cost because three members are `opus` (`SKILL.md:112-113`) — a parallelism decision driven by a model fact, with no shared vocabulary linking the two.                        |
| No cost policy beyond one advisory sentence.                                       | `docs/specs/dotbabel-agents/spec/8-risks-alternatives.md:11` (R-3): "Default borderline agents to `sonnet`, not `opus`." Not encoded, not checked.                                                                            |
| No policy connecting agent tier to its tool grant or read-only status.             | `SEC-2` (`validate-skills-inventory.mjs:157-176`) enforces read-only tools for `*-auditor`/`*-reviewer`/`*-inspector` names. Nothing enforces anything about those agents' models, though these are the highest-stakes roles. |
| No way to express "this harness routes automatically, do not recommend".           | `copilot --model auto` (**RUNTIME**) has no representation.                                                                                                                                                                   |
| Effort policy is applied uniformly, not derived.                                   | All 7 cloud/k8s specialist skills carry `effort: max` with no differentiation; `validate-spec` is the lone `sonnet` + `max` combination, unexplained.                                                                         |

### Runtime

| Gap                                                | Evidence                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent cannot determine its own active model.    | No mechanism exists. The nearest signal is deliberately discarded (`handoff-extract.sh:84`).                                                                  |
| A user override cannot be detected.                | Overrides happen by editing the bootstrapped file or via a session flag; neither is read back. `dotbabel doctor` reports runtime presence, never model state. |
| A recommendation would not know the current model. | Direct consequence of the two above.                                                                                                                          |
| No drift detection for model or effort.            | `check-instruction-drift`, `check-instructions-fresh`, `check-instruction-parity`, `detect-drift`, `check-repo-facts-keys` — none reads `model` or `effort`.  |
| No fallback configuration.                         | `claude --fallback-model` exists (**RUNTIME**); Dotbabel never sets it, so a withdrawn model produces an unattributable failure.                              |
| The CI review path has no declared model.          | `templates/workflows/ai-review.yml:27` calls `npx @anthropic-ai/claude-code -p` with no `--model`.                                                            |

### Testing

| Gap                                                                              | Evidence                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No test asserts any skill's or command's model value.**                        | Only `validateAgents` is tested (`tests/validate-skills-inventory.test.mjs:149-384`). `grep` for model assertions over the skills/commands suites returns nothing.                                                                                                        |
| `validateAgents` runs against the **generated mirror**, not the authored source. | `bin/dotbabel-validate-skills.mjs:95` resolves `plugins/dotbabel/templates/claude`; the test at `…test.mjs:377-379` does the same. `agents/` is covered only transitively via `build-plugin --check`.                                                                     |
| Effort values are untested and unenforced.                                       | No `effort` check in any validator. `tests/copilot-frontmatter.test.mjs:213` uses `effort: high`, outside Dotbabel's own enum, and passes.                                                                                                                                |
| Fan-out **pass-through** is untested, though the Copilot **drop** is tested.     | `tests/project-sync.test.mjs:409-433` asserts the Copilot path warns by name on `"model"`, `"effort"`, and `"disable-model-invocation"` — good coverage. Nothing asserts what `.cli/skills/` or `.agents/skills/` receive. The 14 committed command copies are unguarded. |
| Mirror preserves `model`, but not `effort`.                                      | `tests/build-plugin.test.mjs:372` asserts `/^model:/m` survives the mirror; no equivalent assertion exists for `effort:`.                                                                                                                                                 |
| The two broken handoff extractors are the two with no model assertion.           | `handoff-extract.bats:113-120` (Claude) and `:131-137` (Codex) assert `cwd`/`session_id` only. Copilot and Gemini — the two correct ones — are asserted.                                                                                                                  |
| No test ties `post-pr-review`'s cost prose to the four agents' tiers.            | `skills/post-pr-review/SKILL.md:112-113` is prose with no fixture.                                                                                                                                                                                                        |
| No test ties the spec tier tables to the artifacts.                              | `5-interfaces-apis.md:36-45` and `6-implementation-plan.md:62-64` are unchecked, and one has already drifted.                                                                                                                                                             |
| Unknown-model handling is tested only as rejection.                              | `…test.mjs:232-241` asserts `turbo` fails. There is no test for graceful handling of a **valid-but-new** alias, because the design has no such path.                                                                                                                      |
| Generated configs are not validated for model content.                           | `validateArtifacts` warns, never fails (`build-index.mjs:474-481`).                                                                                                                                                                                                       |
| No extractor-coverage test against `RUNTIMES`.                                   | `handoff-extract.sh` knows 4 CLIs, the registry knows 6, and nothing compares the two lists.                                                                                                                                                                              |

### Documentation

| Gap                                                                          | Evidence                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The alias→ID table is stale and unstamped.                                   | `5-interfaces-apis.md:29-31`. `docs:stamp-check` (`package.json`) checks only version stamps on `docs/*.md` — this file is under `docs/specs/` and names no models under version control. |
| The model enum is documented to Copilot and to no other runtime.             | `.github/copilot-instructions.md:106-111` sits **outside** the rule-floor markers (L126-339); `AGENTS.md` and `GEMINI.md` contain zero model references.                                  |
| No document states what each harness does with an unrecognised `model:` key. | Only the Copilot case is analysed (`docs/copilot-frontmatter-mapping.md:83-84`).                                                                                                          |
| No document explains why `inherit` is never used.                            | 0 uses across 67 artifacts, unexplained.                                                                                                                                                  |
| No document explains the effort ladder's meaning.                            | `low`/`medium`/`max` appear in a schema enum with no prose definition anywhere.                                                                                                           |
| The stated goal and the implementation disagree.                             | `docs/upgrade-guide.md:43` claims a rebrand to be "model-agnostic"; the model layer remained Anthropic-shaped.                                                                            |
| Dangling effort recommendations.                                             | `/think`, `/ultraplan` (`skills/spec/SKILL.md:291`, `references/cc-prompt-templates.md:81-82`) exist in neither `commands/` nor `skills/`, and are fanned out to Copilot.                 |

### Migration

| Gap                                                                                                 | Evidence                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 67 artifacts carry an Anthropic alias; 148 literal sites exist across the repo.                     | The mirror is CI-enforced, so the real edit surface is 67 authored + 14 fan-out = **81 sites**, but the mirror must be rebuilt for each.                                                       |
| 13 enum sites in 9 files must change together.                                                      | See the Duplication table. Only 1 of 13 is executable.                                                                                                                                         |
| 66 rationale-prose sites are welded to their alias.                                                 | Retiering an agent requires rewriting user-facing `description` text in three places, one generated.                                                                                           |
| `VALID_MODELS` is a hard error, so any migration is a **breaking change** for consumers mid-flight. | An installed consumer running an older `dotbabel-validate-skills` against newly authored agents fails; the reverse also fails. No compatibility window exists.                                 |
| Three independent tier tables must be reconciled, and one has already drifted.                      | `agents/` frontmatter vs `5-interfaces-apis.md:36-45` vs `6-implementation-plan.md:62-64` (`validate-spec`: `opus` vs `sonnet`).                                                               |
| `agents-search` can **install** third-party agents with arbitrary model strings.                    | `skills/agents-search/SKILL.md:123,159` writes files fetched from `raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents`. Migration must handle agents Dotbabel did not author.   |
| Two agents' tiers cannot be migrated on documented intent, because there is none.                   | `compliance-auditor` and `data-scientist` have no rationale and an external `source:`.                                                                                                         |
| `effort: max` on 11 skills must be re-expressed before Antigravity can honour it.                   | `agy --effort` accepts `low\|medium\|high` only (**RUNTIME**).                                                                                                                                 |
| No feature flag or dual-read path.                                                                  | Nothing in `.dotbabel.json` or the schemas allows old and new model expressions to coexist. `build-index.mjs`'s warn-then-enforce pattern is the only precedent, and it is not wired to model. |

---

## Migration Classification

Categories: **A** keep pinned · **B** stable provider alias · **C** semantic
requirement · **D** resolve dynamically · **E** inherit from parent/default ·
**F** unknown, needs a decision.

Aliases such as `opus` are _already_ moving provider aliases, so category B is
mostly **not** applicable to artifact frontmatter — it applies to the one place
that pinned a concrete version.

### Totals

| Category                        | Entries | Share |
| ------------------------------- | ------: | ----: |
| A — keep pinned                 |       6 |    6% |
| B — stable provider alias       |       2 |    2% |
| C — semantic requirement        |      57 |   57% |
| D — resolve dynamically         |      14 |   14% |
| E — inherit from parent/default |       8 |    8% |
| F — unknown / requires decision |      13 |   13% |
| **Total**                       | **100** |       |

Category **C** dominates because most model choices in this repo already carry a
_semantic_ justification in prose ("requires deep reasoning", "formulaic and
lightweight") — the intent is recoverable for 57 of 100 entries. The single most
important row is the one **F** entry at the top of the infrastructure table: the
architectural premise. Everything else is downstream of it.

### Agents (24)

| Component               | Current model / effort | Category | Reason                                                                                                                                                                                                                        | Confidence                |
| ----------------------- | ---------------------- | :------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `architect-reviewer`    | `opus` / inherited     |  **C**   | Rationale is already semantic: "cross-cutting architectural analysis requires deep reasoning" (L18). → Frontier Reasoning.                                                                                                    | High                      |
| `aws-engineer`          | `opus` / inherited     |  **C**   | Documented as multi-service + IAM trust depth. → Deep Reasoning.                                                                                                                                                              | High                      |
| `azure-engineer`        | `opus` / inherited     |  **C**   | Same shape.                                                                                                                                                                                                                   | High                      |
| `gcp-engineer`          | `opus` / inherited     |  **C**   | Same shape.                                                                                                                                                                                                                   | High                      |
| `kubernetes-specialist` | `opus` / inherited     |  **C**   | "deep reasoning prevents misdiagnosis".                                                                                                                                                                                       | High                      |
| `platform-engineer`     | `opus` / inherited     |  **C**   | "decisions compound over time" → Frontier Reasoning.                                                                                                                                                                          | High                      |
| `workflow-orchestrator` | `opus` / inherited     |  **C**   | "poor decomposition cascades" → Exceptional Reasoning. Also needs an execution-mode decision (its `tools:` lacks `Task`).                                                                                                     | Medium                    |
| `security-auditor`      | `opus` / inherited     |  **A**   | See [Risk Analysis](#risk-analysis). Pin until a recommender can prove non-inferiority on adversarial review. The repo already treats it as a floor (`post-pr-review` dispatches it in every profile, justified at L128-134). | High                      |
| `security-engineer`     | `opus` / inherited     |  **A**   | Same reasoning: "a missed vector has high downstream cost".                                                                                                                                                                   | High                      |
| `compliance-auditor`    | `opus` / inherited     |  **F**   | No rationale; external `source:`. Its sibling in the same fleet is `sonnet` with equally no rationale. Intent is unrecoverable from the repo.                                                                                 | High (that it is unknown) |
| `data-scientist`        | `sonnet` / inherited   |  **F**   | Same. Audits formula correctness and boundary conditions — plausibly under-tiered relative to `compliance-auditor`, but nothing says so.                                                                                      | High (that it is unknown) |
| `backend-developer`     | `sonnet` / inherited   |  **C**   | Spec-documented as everyday implementation (`5-interfaces-apis.md:41`). → Routine Engineering.                                                                                                                                | High                      |
| `frontend-developer`    | `sonnet` / inherited   |  **C**   | Same (`:42`).                                                                                                                                                                                                                 | High                      |
| `test-engineer`         | `sonnet` / inherited   |  **C**   | Same (`:43`), "structured but not cheap".                                                                                                                                                                                     | High                      |
| `container-engineer`    | `sonnet` / inherited   |  **C**   | "structured and pattern-driven".                                                                                                                                                                                              | High                      |
| `crossplane-engineer`   | `sonnet` / inherited   |  **C**   | "well-specified".                                                                                                                                                                                                             | High                      |
| `deployment-engineer`   | `sonnet` / inherited   |  **C**   | "structured".                                                                                                                                                                                                                 | High                      |
| `devops-engineer`       | `sonnet` / inherited   |  **C**   | "structured and iterative".                                                                                                                                                                                                   | High                      |
| `docker-engineer`       | `sonnet` / inherited   |  **C**   | "structured".                                                                                                                                                                                                                 | High                      |
| `iac-engineer`          | `sonnet` / inherited   |  **C**   | "structured and pattern-driven".                                                                                                                                                                                              | High                      |
| `pulumi-engineer`       | `sonnet` / inherited   |  **C**   | "code-first and structured".                                                                                                                                                                                                  | High                      |
| `terragrunt-engineer`   | `sonnet` / inherited   |  **C**   | "well-specified".                                                                                                                                                                                                             | High                      |
| `changelog-assistant`   | `haiku` / inherited    |  **C**   | "formulaic and lightweight" → Mechanical.                                                                                                                                                                                     | High                      |
| `documentation-writer`  | `haiku` / inherited    |  **C**   | "templated and fast-turnaround" → Mechanical. **Caveat:** it is a member of the `post-pr-review` docs-only profile, where it is the _sole_ non-security reviewer (`SKILL.md:124`).                                            | Medium                    |

### Skills (37 model + 18 effort)

| Component                       | Current model / effort |                            Category                             | Reason                                                                                                                                                                                                  | Confidence                |
| ------------------------------- | ---------------------- | :-------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `security-review`               | `opus` / —             |                              **A**                              | Security review; same floor argument as `security-auditor`.                                                                                                                                             | High                      |
| `veracity-audit`                | `opus` / `max`         |                              **A**                              | Data-integrity audit that dispatches three subagents, one of which (`data-engineer`) does not exist. Pin the coordinator until the fleet is correct.                                                    | Medium                    |
| `rollback-prod`                 | `sonnet` / `medium`    |                              **A**                              | Destructive production operation. `.github/instructions/rollback-prod.instructions.md:51` already forbids a "model routing decision" from bypassing its confirmation. Honour that.                      | High                      |
| `agents-search`                 | `sonnet` / `medium`    | **A** for its own model; **F** for the tier taxonomy it encodes | Its own work is mechanical file parsing, but its body _is_ model policy (`SKILL.md:83-87,225`). The taxonomy must be redesigned, not migrated.                                                          | High                      |
| `local-attest`                  | **absent** / —         |                              **A**                              | Already inherits. This is the target state; do not add a model.                                                                                                                                         | High                      |
| `spec`                          | `opus` / `max`         |                              **C**                              | Design-document authoring. → Frontier Reasoning / Maximum.                                                                                                                                              | High                      |
| `audit-and-fix`                 | `opus` / —             |                          **C** + **F**                          | Coordinator reasoning is genuinely deep (**C**, Frontier). But the implementation runs on `general-purpose` subagents (`SKILL.md:56`), so the `opus` applies to the cheaper half. Fleet model is **F**. | Medium                    |
| `review-prs`                    | `opus` / —             |                          **E** + **F**                          | Its own work is preflight and aggregation (**E** — inherit). The per-PR subagents are `general-purpose` and carry the real load; their model is **F**.                                                  | Medium                    |
| `plan-grader`                   | `opus` / —             |                              **C**                              | Rubric-based grading across four CLIs' plans. → Deep Reasoning.                                                                                                                                         | High                      |
| `create-audit`                  | `opus` / —             |                              **C**                              | Evidence-based audit authoring. → Deep Reasoning.                                                                                                                                                       | High                      |
| `create-assessment`             | `opus` / —             |                              **C**                              | Weighted-rubric grading. → Deep Reasoning.                                                                                                                                                              | High                      |
| `create-inspection`             | `opus` / —             |                              **C**                              | Options + trade-off analysis. → Deep Reasoning.                                                                                                                                                         | High                      |
| `ground-first`                  | `opus` / —             |                              **C**                              | Grounded-analysis discipline. → Deep Reasoning.                                                                                                                                                         | High                      |
| `aws-specialist`                | `opus` / `max`         |                              **C**                              | Deep Reasoning / Deep.                                                                                                                                                                                  | High                      |
| `azure-specialist`              | `opus` / `max`         |                              **C**                              | Same.                                                                                                                                                                                                   | High                      |
| `gcp-specialist`                | `opus` / `max`         |                              **C**                              | Same.                                                                                                                                                                                                   | High                      |
| `crossplane-specialist`         | `opus` / `max`         |                              **C**                              | Same.                                                                                                                                                                                                   | High                      |
| `kubernetes-specialist` (skill) | `opus` / `max`         |                              **C**                              | Same.                                                                                                                                                                                                   | High                      |
| `terraform-specialist`          | `opus` / `max`         |                              **C**                              | Same.                                                                                                                                                                                                   | High                      |
| `terragrunt-specialist`         | `opus` / `max`         |                              **C**                              | Same.                                                                                                                                                                                                   | High                      |
| `pulumi-specialist`             | `opus` / `max`         |                              **C**                              | Same.                                                                                                                                                                                                   | High                      |
| `detect-flaky`                  | `sonnet` / —           |                              **C**                              | Root-cause analysis of nondeterminism. → Deep Reasoning.                                                                                                                                                | Medium                    |
| `quality-review`                | `sonnet` / —           |                              **C**                              | Semantic risks tools cannot judge. → Deep Reasoning.                                                                                                                                                    | Medium                    |
| `reproduce-bug`                 | `sonnet` / —           |                              **C**                              | Isolation + regression capture. → Deep Reasoning.                                                                                                                                                       | Medium                    |
| `validate-spec`                 | `sonnet` / `max`       |                              **F**                              | The only `sonnet` + `max` artifact. `6-implementation-plan.md:62` says it should be `opus`. Implementation and spec disagree; intent is undecided.                                                      | High (that it is unknown) |
| `code-simplifier`               | `sonnet` / —           |                              **C**                              | Routine Engineering.                                                                                                                                                                                    | High                      |
| `create-experiment`             | `sonnet` / —           |                              **C**                              | Routine Engineering.                                                                                                                                                                                    | High                      |
| `fix-with-evidence`             | `sonnet` / —           |                              **C**                              | Routine Engineering.                                                                                                                                                                                    | High                      |
| `review-pr`                     | `sonnet` / —           |                              **C**                              | Routine Engineering.                                                                                                                                                                                    | High                      |
| `post-pr-review`                | `sonnet` / `medium`    |              **C** for itself; **D** for the fleet              | Coordinator is Routine Engineering. The diff-profile heuristic at L112-126 is precisely a "which fleet, at what cost" question a recommender should answer.                                             | High                      |
| `pr-conductor`                  | `sonnet` / —           |                              **E**                              | Thin orchestration over `post-pr-review`; no independent reasoning need.                                                                                                                                | High                      |
| `release-conductor`             | `sonnet` / —           |                              **E**                              | Same shape.                                                                                                                                                                                             | High                      |
| `deploy-status`                 | `sonnet` / `medium`    |                              **E**                              | Reads SHAs from provider CLIs. Inherit.                                                                                                                                                                 | High                      |
| `flyctl`                        | `sonnet` / `medium`    |                              **E**                              | CLI wrapper. Inherit.                                                                                                                                                                                   | High                      |
| `git`                           | `sonnet` / —           |                              **E**                              | Conventional-commit / PR mechanics. Inherit.                                                                                                                                                            | High                      |
| `project-sync`                  | `sonnet` / `low`       |                              **E**                              | Wraps `dotbabel project-sync`. Inherit.                                                                                                                                                                 | High                      |
| `handoff`                       | `sonnet` / `medium`    |                              **D**                              | It already _reads_ a session's model. Its own model, and the model it recommends to the receiving CLI, are the natural first consumers of a resolver.                                                   | Medium                    |

### Commands (7)

| Component          | Current model | Category | Reason                                                                                                                                | Confidence |
| ------------------ | ------------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `changelog`        | `haiku`       |  **C**   | Mechanical. Matches its agent twin.                                                                                                   | High       |
| `markdown`         | `haiku`       |  **C**   | Mechanical.                                                                                                                           | High       |
| `tldr`             | `haiku`       |  **C**   | Mechanical summarization.                                                                                                             | High       |
| `pr-tldr`          | `haiku`       |  **C**   | Mechanical summarization.                                                                                                             | High       |
| `merge-pr`         | `sonnet`      |  **C**   | Routine Engineering with a gate.                                                                                                      | High       |
| `pre-pr`           | `sonnet`      |  **C**   | Routine Engineering coordinator.                                                                                                      | High       |
| `dependabot-sweep` | `sonnet`      |  **D**   | Per-PR risk triage over `general-purpose` subagents with a 6-wide cap. Fleet sizing and per-PR depth are exactly a recommender's job. | Medium     |

### Infrastructure, schemas, generators, docs

| Component                                                                                                                       | Current model/effort                                       | Category | Reason                                                                                                                                                                                                                                                                                                                                                                                                                      | Confidence                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | :------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| The "native resolution, no tooling required" premise (`3-high-level-architecture.md:7`, `4-data-flow-components.md:28`, PERF-3) | architectural assumption                                   |  **F**   | **The first decision to make, and it gates every other row in this table.** Keeping it means Dotbabel stays a declaration layer and the fix is per-harness _translation_ (extend `copilot-frontmatter.mjs`'s table shape to all six). Dropping it means Dotbabel becomes a resolver and needs discovery, caching, and trust. The repo contains the argument for the old premise and no argument either way for the new one. | High (that it is undecided) |
| `VALID_MODELS` (`validate-skills-inventory.mjs:10`)                                                                             | closed 4-value `Set`, hard error                           |  **D**   | Must become a resolver question ("is this alias known to this harness at this version?") with an explicit unknown state, not a frozen list.                                                                                                                                                                                                                                                                                 | High                        |
| `agent.schema.json:20-23` model enum                                                                                            | 4-value enum                                               |  **D**   | Same, at the schema layer.                                                                                                                                                                                                                                                                                                                                                                                                  | High                        |
| `skill.schema.json:29-32` model enum                                                                                            | 4-value enum                                               |  **D**   | Same.                                                                                                                                                                                                                                                                                                                                                                                                                       | High                        |
| `command.schema.json:12-15` model enum                                                                                          | 4-value enum                                               |  **D**   | Same.                                                                                                                                                                                                                                                                                                                                                                                                                       | High                        |
| `skill.schema.json:33-36` effort enum                                                                                           | `low \| medium \| max`                                     |  **D**   | Matches no harness. Must resolve against per-harness capability, or become a semantic ladder mapped per harness.                                                                                                                                                                                                                                                                                                            | High                        |
| `agents.mjs` `Runtime` typedef (L77-86)                                                                                         | no model fields                                            |  **D**   | Where per-harness model/effort capability metadata belongs.                                                                                                                                                                                                                                                                                                                                                                 | High                        |
| `copilot-frontmatter.mjs:46,60` drop rules                                                                                      | drop + warn                                                |  **A**   | Correct **today** and the right behaviour under the current design. Revisit only once a translation layer exists.                                                                                                                                                                                                                                                                                                           | High                        |
| Project fan-out pass-through (skills)                                                                                           | alias passed verbatim to 4 harnesses                       |  **D**   | Needs per-harness resolution or explicit stripping, as Copilot already does.                                                                                                                                                                                                                                                                                                                                                | High                        |
| Project fan-out copies (7 commands × 2 trees)                                                                                   | 14 committed `model:` literals                             |  **D**   | Same, and these are physical files.                                                                                                                                                                                                                                                                                                                                                                                         | High                        |
| `index/artifacts.json` entry shape                                                                                              | model/effort dropped                                       |  **D**   | A recommender needs structured model data in the index. `additionalProperties: true` makes this additive.                                                                                                                                                                                                                                                                                                                   | High                        |
| `handoff-extract.sh:84` Claude `model: null`                                                                                    | hardcoded null                                             |  **D**   | Should read the live value. This is the repo's only path to "what model am I on".                                                                                                                                                                                                                                                                                                                                           | High                        |
| `handoff-extract.sh:275` Codex `.model_provider`                                                                                | provider in the model field                                |  **D**   | Needs separate `provider` and `model` fields.                                                                                                                                                                                                                                                                                                                                                                               | High                        |
| `handoff-extract.sh:9-11` 4-CLI list                                                                                            | 4 of 6                                                     |  **D**   | Derive from `RUNTIMES`.                                                                                                                                                                                                                                                                                                                                                                                                     | High                        |
| `templates/workflows/ai-review.yml:27`                                                                                          | no `--model`                                               |  **F**   | Unclear whether the omission is intentional ("track the CLI default") or an oversight. It is a shipped production review path; the owner must decide.                                                                                                                                                                                                                                                                       | High (that it is undecided) |
| `templates/workflows/ai-review.yml:8,25` `ANTHROPIC_API_KEY`                                                                    | provider pin                                               |  **A**   | Deliberate and documented at L4-6, with the alternative named.                                                                                                                                                                                                                                                                                                                                                              | High                        |
| `5-interfaces-apis.md:29-31` alias→ID table                                                                                     | `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` |  **B**   | The one genuine case: exact versions pinned in prose that should become official moving aliases, or be deleted in favour of a generated table. **Not performed here.**                                                                                                                                                                                                                                                      | High                        |
| `5-interfaces-apis.md:36-45` tier table                                                                                         | 8 duplicated assignments                                   |  **B**   | Should be generated from the artifacts rather than restated.                                                                                                                                                                                                                                                                                                                                                                | High                        |
| `6-implementation-plan.md:62-64` tier list                                                                                      | drifted (`validate-spec`)                                  |  **F**   | Already contradicts the shipped artifact. Someone must decide which is right.                                                                                                                                                                                                                                                                                                                                               | High                        |
| `skills/agents-search` tier ladder                                                                                              | `opus → sonnet → haiku → inherit`, "never reorder"         |  **F**   | Provider-neutral grouping is a design question, not a mechanical substitution.                                                                                                                                                                                                                                                                                                                                              | High                        |
| `post-pr-review` opus-cost prose                                                                                                | "Three of the four agents … run on `opus`"                 |  **D**   | Should query the fleet's resolved models rather than assert them.                                                                                                                                                                                                                                                                                                                                                           | High                        |
| `8-risks-alternatives.md:11` R-3 cost advice                                                                                    | "default borderline agents to `sonnet`"                    |  **C**   | Reword as a semantic policy ("prefer the lower tier when the requirement is Routine Engineering").                                                                                                                                                                                                                                                                                                                          | Medium                      |
| `spec` skill `/think`, `/ultraplan`                                                                                             | dangling effort escalations                                |  **F**   | Neither command exists. Delete or replace — a decision, not a migration.                                                                                                                                                                                                                                                                                                                                                    | High                        |
| `agent.schema.json:24-27` `invocation` enum                                                                                     | declared, unused                                           |  **F**   | A dead execution-mode field. Use it or remove it.                                                                                                                                                                                                                                                                                                                                                                           | High                        |
| `headless_safe` schema placement                                                                                                | command-only, used on skills                               |  **F**   | Adjacent execution-mode metadata with an inconsistent home.                                                                                                                                                                                                                                                                                                                                                                 | High                        |

---

## Risk Analysis

### Where a dynamic recommender could **lower** reliability

Ranked. These are the components where a strong hardcoded model is doing safety
work.

1. **`security-auditor` (`opus`) and `security-engineer` (`opus`) — HIGH.**
   `agents/security-auditor.md:18` states the asymmetry plainly: "false
   negatives have high downstream cost". A missed injection vector is silent;
   the failure is invisible until exploited, so the usual feedback loop that
   would catch a bad recommendation does not exist. Compounding it,
   `skills/post-pr-review/SKILL.md:128-134` makes `security-auditor` a
   **pipeline invariant**: it is dispatched in every profile precisely because
   callers narrow their own security step assuming it runs
   (`commands/pre-pr.md` step 3 under `--conductor`). De-escalating it weakens
   the only security review in that pipeline. **Keep pinned (A) until a
   recommender can demonstrate non-inferiority on adversarial review.**

2. **`rollback-prod` — HIGH.** A destructive production operation.
   `.github/instructions/rollback-prod.instructions.md:51-52` already states:
   "No `--yes`, environment variable, autonomous mode, or **model routing
   decision** may bypass this confirmation." A recommender must be _architecturally
   incapable_ of touching this path, not merely instructed not to. The same rule
   must extend to `merge-pr`, `release-conductor`, and `deploy-status`.

3. **`veracity-audit` (`opus`, dispatches 3) — HIGH.** Data-integrity auditing,
   where a false pass propagates silently into downstream data. It already has a
   structural defect: it names a `data-engineer` agent that does not exist in
   `agents/`, so one third of its fleet has an undefined model today. Fix the
   fleet before touching the tier.

4. **The criteria-verdict boundary — HIGH, and already fenced.**
   `docs/specs/qa-verification-harness/spec/7-non-functional-requirements.md:66`:
   "No text written by a model sets a criterion status", enforced by the
   `guard-criteria-evidence.sh` PreToolUse hook. `8-risks-alternatives.md:42`
   rejected alternative A-8 ("A model verdict for criteria") because "Model
   output varies between runs and can be steered by the content it reads". **A
   model-recommendation system is itself a model-derived verdict.** Any advisory
   output must be labelled advisory and must never reach a gate — this project
   has already litigated the principle.

5. **`compliance-auditor` (`opus`) and `data-scientist` (`sonnet`) — MEDIUM-HIGH.**
   Both are read-only auditors of invariants and formulas, and both are the
   _only_ agents with **no documented rationale** for their tier. A migration
   has nothing to migrate _from_. `data-scientist` at `sonnet` while its
   same-fleet sibling is `opus` is either a deliberate cost trade or an
   oversight; the repo cannot say which. Treat both as **F** and decide
   explicitly before any automated change.

6. **`architect-reviewer` (`opus`) — MEDIUM.** Whole-repo coupling analysis. A
   de-escalation produces plausible-but-shallow findings, which is worse than no
   review because it creates false confidence.

7. **`workflow-orchestrator` (`opus`) — MEDIUM.** Its own rationale is the
   argument: "poor decomposition cascades into downstream failures". Errors
   multiply across every delegated agent. Note it is already partly broken — its
   `tools:` grant (L19) has no `Task`/`Agent`.

8. **The `ai-review.yml` CI path — MEDIUM, and currently unmanaged.** An
   always-on production review on every non-draft same-repo PR
   (`templates/workflows/ai-review.yml:12-19`) with **no declared model**. It is
   simultaneously the highest-leverage automation Dotbabel ships and the least
   specified. Introducing a recommender here changes behaviour for every
   consumer at once.

9. **Automated code modification — MEDIUM.** `audit-and-fix` and
   `dependabot-sweep` open draft PRs and (for the latter) merge safe bumps, with
   up to 6 concurrent subagents. The _declared_ models (`opus`, `sonnet`) are
   **not** what does the work — `general-purpose` subagents are
   (`audit-and-fix/SKILL.md:56`, `dependabot-sweep.md:41`). Today the writing
   half of the pipeline already runs on an unspecified model. Any recommender
   must address the fleet, not the coordinator, or it will optimise the wrong
   half.

10. **Concurrency and distributed-systems reasoning — MEDIUM.**
    `kubernetes-specialist` (`opus`, "scheduler decisions, network policy
    semantics, control-plane interactions") and `detect-flaky` (`sonnet`, race
    and shared-state diagnosis, `SKILL.md:71-73`) both reason about
    nondeterminism, where a shallow answer looks correct. Note `detect-flaky` is
    already the _lower_ tier of the two despite arguably harder reasoning.

### Where unnecessarily strong models may be wasting latency

Stated as latency and dispatch-count observations. **No cost claim is made** —
the repository contains no pricing data, no token accounting, and no benchmark.

1. **`post-pr-review`'s full set — the repo's own strongest claim.**
   `skills/post-pr-review/SKILL.md:112-113`: "Three of the four agents in the
   full set run on `opus`, so dispatching all four at every diff size is the
   single most expensive thing this skill does." The mitigation already shipped
   (a four-rule diff-size profile at L117-126), which makes this the one place
   with a real fleet-sizing policy — and a good template. It is also duplicated
   prose that can silently go stale (finding 8).

2. **Seven cloud/IaC specialist skills all at `opus` + `effort: max`** —
   `aws`, `azure`, `gcp`, `crossplane`, `kubernetes`, `terraform`,
   `terragrunt`, plus `pulumi`. Applied uniformly with identical rationale text.
   `LIKELY` over-provisioned for the routine half of their work (reading a
   manifest, checking a lock file). No evidence either way exists in the repo,
   and `effort: max` is not even valid on Antigravity.

3. **`review-prs` and `audit-and-fix` at `opus`** while the actual work runs on
   `general-purpose` subagents. The expensive declaration sits on the cheap
   coordination step. **Inverted allocation** (category E/F above).

4. **`plan-grader` at `opus` + `create-assessment`/`create-audit`/`create-inspection`
   at `opus`** — four document-authoring skills at the top tier. `LIKELY`
   correct for analysis depth; the rubric-scoring mechanics are not.

5. **Eleven of 24 agents at `opus`** against the project's own written policy:
   "Default borderline agents to `sonnet`, not `opus`"
   (`8-risks-alternatives.md:11`). Whether 11/24 counts as honouring that is
   `UNCERTAIN` — the policy names no threshold.

6. **`effort: max` on 11 skills, `medium` on 6, `low` on 1.** The distribution
   is top-heavy and, critically, **unenforced** — so it is not obvious the
   values have any runtime effect at all today. Measuring that is prerequisite
   work.

### Second-order risk unique to this project

Dotbabel is a **distribution mechanism**. A change to `agents/security-auditor.md`
propagates through `build-plugin` → the npm tarball → every consumer's
`~/.claude/agents/`. `validate-skills-inventory.mjs:10` is a **hard error**, so
a new alias breaks consumers' CI in both directions during any migration window.
The migration is therefore a **compatibility problem before it is a design
problem** — and the project already owns the right tool for it:
`build-index.mjs:474-481`'s "warn first, enforce later" pattern.

---

## Test Coverage Analysis

| Area                                                                                 |      Covered?       | Evidence                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | :-----------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent `model` presence required                                                      |       **yes**       | `tests/validate-skills-inventory.test.mjs:161-177`                                                                                                                                                           |
| Agent `model` enum rejection                                                         |       **yes**       | `…:226-241` — rejects `turbo`, asserts the message names the 4 values                                                                                                                                        |
| Agent `model` enum acceptance                                                        |       **yes**       | `…:244-257` — loops all four                                                                                                                                                                                 |
| Shipped agent templates all valid                                                    |       **yes**       | `…:375-384` — 0 errors, 0 warnings across `templates/claude/agents/`                                                                                                                                         |
| Authored `agents/` validated directly                                                |       **no**        | `bin/dotbabel-validate-skills.mjs:95` targets the template dir only; covered transitively by `build-plugin --check` (`dogfood.yml:42`)                                                                       |
| Skill `model` values                                                                 |       **no**        | no assertion anywhere                                                                                                                                                                                        |
| Command `model` values                                                               |       **no**        | no assertion anywhere                                                                                                                                                                                        |
| `effort` values, any artifact                                                        |       **no**        | no `effort` check in any validator; `tests/copilot-frontmatter.test.mjs:213` uses out-of-enum `effort: high` and passes                                                                                      |
| Schemas compile                                                                      |       **yes**       | `tests/build-index.test.mjs:411-440`                                                                                                                                                                         |
| Skill schema enum rejection                                                          |     **partial**     | `…:441-487` — "accepts a valid example and rejects an invalid enum"; does not target `model` or `effort` specifically                                                                                        |
| `disable-model-invocation` boolean typing                                            |       **yes**       | `…:611-633`                                                                                                                                                                                                  |
| `allowed-tools` string/array shapes                                                  |       **yes**       | `…:569-610`                                                                                                                                                                                                  |
| Index entry required fields                                                          |       **yes**       | `…:488-523`                                                                                                                                                                                                  |
| Index **drops** model/effort                                                         |       **no**        | the drop is unasserted; verified here only by inspection                                                                                                                                                     |
| Copilot drops `model`/`effort`/`disable-model-invocation` with warnings              |       **yes**       | `tests/copilot-frontmatter.test.mjs:88-102`, `222-260`                                                                                                                                                       |
| Copilot mapper never leaks taxonomy keys                                             |       **yes**       | `…:103-120`                                                                                                                                                                                                  |
| Copilot fan-out warns by name on dropped `model`/`effort`/`disable-model-invocation` |       **yes**       | `tests/project-sync.test.mjs:409-433` (integration level, above the pure mapper)                                                                                                                             |
| Mirror preserves `model:` through `build-plugin`                                     |       **yes**       | `tests/build-plugin.test.mjs:372` (`/^model:/m`), fixture at `:49`                                                                                                                                           |
| Mirror preserves `effort:`                                                           |       **no**        | no assertion; only `name`, `model`, `tools` are checked at `:371-373`                                                                                                                                        |
| Fan-out **pass-through** of model/effort to Codex/Gemini/Antigravity/OpenCode        |       **no**        | `tests/project-sync.test.mjs` covers only the Copilot branch; `tests/bats/project-sync.bats` asserts nothing about model                                                                                     |
| Handoff meta: Copilot model                                                          |       **yes**       | `tests/bats/handoff-extract.bats:126` asserts `"model":"gpt-5"`                                                                                                                                              |
| Handoff meta: Gemini model                                                           |       **yes**       | `…:146` asserts `"model":"gemini-2.5-pro"`                                                                                                                                                                   |
| Handoff meta: Claude model                                                           |       **no**        | `…:113-120` asserts `cwd`/`session_id`/`short_id`/`cli` only — the value is hardcoded `null`                                                                                                                 |
| Handoff meta: Codex model                                                            |       **no**        | `…:131-137` asserts `cwd`/`session_id`/`short_id` only — the value is the provider                                                                                                                           |
| Handoff extractor covers all six runtimes                                            |       **no**        | `handoff-extract.sh:9-11` lists four; nothing compares that list to `RUNTIMES`                                                                                                                               |
| Runtime registry: detection, config roots, env precedence, fan-out sets              | **yes, thoroughly** | `tests/agents.test.mjs` (incl. `:329` agy-only, `:387` scope reasoning, `:448` opencode); `tests/bootstrap-global.test.mjs:417`; `tests/dotbabel-doctor.test.mjs:149-176`; `tests/project-sync.test.mjs:299` |
| Quality policy resolution, states, adapters                                          |       **yes**       | the quality suite                                                                                                                                                                                            |
| Template mirror freshness                                                            |       **yes**       | `tests/build-plugin.test.mjs` + `dogfood.yml:42`                                                                                                                                                             |
| Instruction drift / freshness / parity                                               |       **yes**       | `package.json` `dogfood` script; `.github/workflows/dogfood.yml`                                                                                                                                             |
| Spec tier tables match artifacts                                                     |       **no**        | three tables, one already drifted (`validate-spec`)                                                                                                                                                          |
| `post-pr-review` cost prose matches agent tiers                                      |       **no**        | prose only                                                                                                                                                                                                   |
| Unknown-but-valid new alias handled gracefully                                       |       **no**        | only rejection is tested; no graceful path exists to test                                                                                                                                                    |

**Shape of the gap.** Model testing is **inverted**: the 24 agents — the only
artifacts whose model is enforced — are the only ones tested, while the 44
skills and commands that fan out to five other harnesses have no model test at
all. And the two handoff extractors that are _wrong_ are precisely the two with
no model assertion.

---

## Unknowns and Questions

Only items that repository reads and read-only probes cannot answer.

1. **What does each non-Claude harness do with an unrecognised `model:` key in
   `SKILL.md` frontmatter?** `UNCERTAIN`. Determining it requires running each
   CLI against a planted skill. Dotbabel ships `model: opus` into four such
   harnesses; whether that is ignored, warned, or an error is unknown.

2. **Does Claude Code honour a subagent's `model:` when the session has an
   explicit `--model`/`--effort`?** `UNCERTAIN`. Determines whether user
   overrides beat artifact declarations.

3. **Is a skill's `tools:` list restrictive or advisory for `Task`/`Agent` in
   Claude Code?** `UNCERTAIN`. Decides whether `audit-and-fix`, `review-prs`,
   `dependabot-sweep`, and `workflow-orchestrator` can actually dispatch.

4. **Does Codex CLI 0.154.0 expose a reasoning-effort setting?** `UNCERTAIN`.
   `codex --help` shows only the generic `-c key=value` form (example:
   `-c model="o3"`). Requires reading Codex's config schema, not probed here.

5. **Does OpenCode v2.0.5 expose per-model effort or an effort flag?**
   `UNCERTAIN`. Not in top-level `--help`.

6. **Does Gemini CLI 0.59.0 expose an effort flag or a model list?**
   `UNCERTAIN`. Neither appears in `--help`; `gemini gemma` routes local Gemma
   only.

7. **Is the missing `--model` in `templates/workflows/ai-review.yml:27`
   intentional?** `UNCERTAIN` — an owner decision. The surrounding comment
   (L3-6) reasons about provider choice and never mentions model choice.

8. **What were `compliance-auditor`'s and `data-scientist`'s tiers chosen
   for?** `UNCERTAIN`. Both lack a rationale and both cite an external
   catalogue (`source:`). Original intent may be unrecoverable.

9. **Which is authoritative for `validate-spec` — `sonnet` (shipped) or `opus`
   (`6-implementation-plan.md:62`)?** `UNCERTAIN`. An owner decision.

10. **Do the `effort:` values have any observable effect today?** `UNCERTAIN`.
    Nothing validates them and no test measures behaviour. They may be inert.

11. **Are `agy models` / `opencode models` outputs stable enough to parse?**
    `UNCERTAIN`. One sample each, this account, this day. `agy models` prints a
    "Fetching available models…" banner to the same stream, which a parser must
    handle.

12. **Do `low`/`medium`/`high` mean comparable things across Claude, Copilot,
    and Antigravity?** `UNCERTAIN`, and `LIKELY not` — Antigravity encodes them
    into model ids.

13. **Do any consumers of the published npm package override the shipped model
    values?** `UNCERTAIN`. Not observable from this repository.

---

## Recommended Next Investigation

What evidence to gather **before** designing anything. No architecture is
proposed here.

### Tier 1 — settle what the six harnesses actually accept (blocks all schema work)

1. **Per-harness `model:` frontmatter behaviour.** For each of Codex, Gemini,
   Antigravity, OpenCode, plant a throwaway skill carrying `model: opus` and
   `effort: max` in an isolated config root and record: ignored, warned,
   errored, or honoured. This single matrix decides whether the fan-out leak is
   cosmetic or harmful, and whether translation or stripping is the right fix.
   Answers unknowns 1 and 10.
2. **Capability matrix from each CLI's own surface.** Record, per CLI and
   version: does `--model` exist; does an effort flag exist and with what
   values; is there a model-list command and what is its output grammar; is
   effort fused into the model id; is there an Auto/Adaptive mode; is the list
   account-scoped. Six of six are installed and four facts per CLI are already
   captured in this audit — complete the grid and **version-stamp it**. Answers
   unknowns 4, 5, 6, 11.
3. **Claude Code's precedence.** Empirically determine whether a session
   `--model`/`--effort` overrides a subagent's `model:`, and whether a skill's
   `tools:` gates `Task`. Answers unknowns 2 and 3 and fixes the two broken
   arrows in Hierarchy 1.

### Tier 2 — measure the current system before changing it

4. **Does `effort:` do anything?** Run one skill at `effort: low` and
   `effort: max` on the same task and compare observable behaviour. If the field
   is inert, 36 literal sites are decoration and the migration is far cheaper
   than it looks.
5. **Baseline the security-critical set.** For `security-auditor`,
   `security-engineer`, and `security-review`, build a small fixture corpus of
   diffs with known planted vulnerabilities and record the current `opus`
   findings. Without this baseline, _no_ future recommendation can be shown not
   to lower reliability — which is the central risk in
   [Risk Analysis](#risk-analysis).
6. **Measure the `post-pr-review` profile heuristic.** It is the only shipped
   fleet-sizing policy. Record how often each of its four rules fires on real
   PRs and whether the chosen fleet was right. It is the best available evidence
   for what a recommender would need to decide.
7. **Instrument dispatch reality.** For the six dispatchers, record which
   `subagent_type` actually ran. Four of six use `general-purpose`, so the
   declared coordinator models may be irrelevant to cost and quality alike.

### Tier 3 — recover intent that only a human holds

8. **Decide the four open `F` items.** `compliance-auditor` and
   `data-scientist` tiers (unknown 8); `validate-spec` `sonnet` vs `opus`
   (unknown 9); the `ai-review.yml` missing `--model` (unknown 7); the
   `agents-search` tier ladder's future. None is derivable from the repository.
9. **Audit the third-party agent path.** `skills/agents-search/SKILL.md:159`
   fetches and installs agents from an external catalogue. Sample what `model:`
   values that catalogue currently uses — migration must handle agents Dotbabel
   did not author.
10. **Reconcile the three tier tables and record which is authoritative.**
    `agents/` frontmatter, `5-interfaces-apis.md:36-45`,
    `6-implementation-plan.md:62-64`. One has already drifted; the drift must be
    resolved before anything is generated from any of them.

### Tier 4 — establish the invariants a future system must not break

11. **Enumerate the safety fences that must survive.** At minimum:
    `.github/instructions/rollback-prod.instructions.md:51-52` (no model routing
    decision bypasses confirmation);
    `qa-verification-harness/spec/7-non-functional-requirements.md:66` (no model
    text sets a criterion status) and its rejected alternative A-8;
    `validate-skills-inventory.mjs:157-176` (SEC-2 read-only tool grants);
    `post-pr-review/SKILL.md:128-134` (`security-auditor` in every profile).
    Write them down as testable invariants before any design starts.
12. **Design the compatibility window first, not last.** `VALID_MODELS` is a
    hard error shipped to consumers, so the migration sequence — not the target
    schema — is the binding constraint. Study how
    `build-index.mjs:474-481`'s warn-then-enforce escalation and
    `schemas/index-entry.schema.json:7`'s `additionalProperties: true` were used
    for the taxonomy rollout, and cost the same path for model.
13. **Prototype against `agents.mjs` and the quality layer only.** Before
    proposing anything, verify by reading that a per-harness capability block
    fits the `Runtime` typedef (L77-86) and that `QUALITY_STATES`
    (`quality/types.mjs:14-22`) covers the unknown-model cases. If those two
    carry the load, the future system is an extension rather than a new
    subsystem — which is the cheapest possible outcome and should be tested for
    first.

---

_Audit produced 2026-09-17 against commit `0db0221`, package version `3.4.0`.
Read-only: the only file created or changed is this one._

> Correction, 2026-09-18: a recount of the `skills/*/SKILL.md` frontmatter gives `effort: max` on 11 skills, `medium` on 6, and `low` on 1 (18 in total). The first version of this audit said 12, 5, and 1. It also said "seven duplication clusters" where its own Duplication Analysis table lists ten rows. Both are corrected in place.
