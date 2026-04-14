---
name: spec
description: >
  Create structured engineering specs through interactive pairing.
  Use when the user wants to create a spec, design doc, technical specification,
  architecture document, RFC, or engineering plan. Triggers on "let's spec this out",
  "create a spec", "design doc", "write a technical plan", "plan the architecture".
  Works for greenfield and brownfield projects. Outputs to docs/specs/.
argument-hint: "[spec-name] [description] [--brownfield]"
effort: max
---

# Spec-Driven Design

Create structured engineering specifications through interactive, phased collaboration.
Outputs organized markdown files into `docs/specs/<spec-name>/` of the current project.

## Arguments

- `$0` — spec name (kebab-case). If not provided, ask the user.
- `$1` — brief description of what the spec covers (free text, optional). Used to seed the README subtitle and give context for Phase 2 questions. If not provided, proceed normally — the user will supply context interactively.
- `--brownfield` flag — if present, include a `current-state/` folder for existing system analysis.

## Workflow Overview

There are 3 phases. **Always start with Phase 1.** Do not skip ahead.

---

### Phase 1: Scaffold

Create the spec directory and empty section files. This gives the user a concrete structure to react to.

**Steps:**

1. Determine the spec name from `$0` or ask the user. Capture the description from `$1` if provided.
2. Create the directory structure:

```
docs/specs/<spec-name>/
├── README.md
├── spec/
│   ├── 1-problem-motivation.md
│   ├── 2-scope.md
│   ├── 3-high-level-architecture.md
│   ├── 4-data-flow-components.md
│   ├── 5-interfaces-apis.md
│   ├── 6-implementation-plan.md
│   ├── 7-non-functional-requirements.md
│   └── 8-risks-alternatives.md
├── research/
│   └── sources.md
└── current-state/              ← only if --brownfield
    └── analysis.md
```

3. Each spec section file gets the scaffold template (see "Section Scaffolds" below).
4. The README gets a status dashboard showing all sections as `[ ] empty`.
5. Tell the user the scaffold is created.
   - **If `$1` was provided:** "Scaffold created. Based on your description — *{$1}* — let's start with §1 Problem/Motivation. What specifically is broken or missing that this addresses?"
   - **If no description:** "Scaffold created. Let's fill it in — starting with §1 Problem/Motivation. What problem are we solving?"

**Do not fill in any content during scaffolding.** The scaffold is purely structural (the description goes only in the README header, not into section bodies).

---

### Phase 2: Interactive Fill-In

Walk through each section with the user. For each section:

1. **Ask** a focused question about what belongs in that section.
2. **Listen** — only write what the user provides or explicitly approves. Never invent requirements.
3. **Write** — update the section file with the user's input, properly formatted.
4. **Tag** — assign constraint IDs where appropriate (ARCH-1, PERF-1, etc.) for cross-referencing.
5. **Update README** — mark the section status as `[~] in-progress` or `[x] done`.
6. **Offer next** — suggest moving to the next section, or ask if they want to go deeper.

**Section order is suggested, not mandatory.** If the user wants to jump to §6 Implementation Plan, go there. If they want to revisit §2 Scope after filling §5, do that.

**Rules:**
- Only add content the user explicitly provides or approves.
- Tag constraints with IDs (e.g., PERF-1, SEC-3, ARCH-1) for cross-referencing between sections.
- Place constraints in the section they **shape**, not just where they're mentioned.
- Cross-reference between sections: "See ARCH-1 in §3" or "Feeds into §6 Phase 2".
- Empty sections are fine — mark them and move on. The user fills them when ready.

#### Research Sources

As the user references documents, codebases, or external resources:

1. Assign each a **DOC-N** identifier.
2. Add it to `research/sources.md` with a one-line description.
3. Tag which spec sections it feeds (e.g., "Feeds: §3, §5, §7").

#### Deep Dives

For complex sections (especially §4 Data Flow and §6 Implementation Plan), offer to generate
**analysis prompts** the user can run in separate Claude Code sessions. Use the templates
from [references/cc-prompt-templates.md](references/cc-prompt-templates.md).

When the user pastes back results, integrate findings into the appropriate section files.

---

### Phase 3: Finalize

When all sections are filled (or the user says "done" / "finalize"):

1. Do a consistency pass — check cross-references are valid, constraint IDs are used, no orphaned references.
2. Update README with final status: all sections marked `[x] done` or `[ ] skipped`.
3. Add a "Quick Start" section to README pointing to the most important sections.
4. Tell the user the spec is complete and where to find it.

---

## Section Scaffolds

Use these templates when creating each section file in Phase 1.

### 1-problem-motivation.md
```markdown
# §1 — Problem / Motivation

> Why does this exist? What's broken? Why now?

## Why

<!-- What is the core problem or opportunity? -->

## What

<!-- What does the solution look like at a high level? -->

## Why Now

<!-- What changed that makes this urgent? Incidents? Scale? Business needs? -->
```

### 2-scope.md
```markdown
# §2 — Scope

> What's in, what's out, and where are the boundaries?

## In Scope

<!-- Bulleted list of what this spec covers -->

## Out of Scope

<!-- Bulleted list of what this spec explicitly does NOT cover, with brief reasoning -->

## Boundaries

<!-- What files/systems/services does this touch vs. not touch? -->

| Touches | Does Not Touch |
|---------|---------------|
|         |               |

## Urgency

<!-- How time-sensitive is this? Any hard deadlines? -->
```

### 3-high-level-architecture.md
```markdown
# §3 — High-Level Architecture

> System view: components, data stores, external dependencies, deployment.

## System Overview

<!-- How does the system fit together at the highest level? -->

## Data Stores

<!-- What databases, caches, queues, or storage systems are involved? -->

| Store | Role | Access Pattern |
|-------|------|---------------|
|       |      |               |

## External APIs / Dependencies

<!-- What external services does this depend on? -->

| Service | Purpose | Rate Limits / Constraints |
|---------|---------|--------------------------|
|         |         |                          |

## Deployment

<!-- Where does this run? Regions, runtimes, infrastructure. -->
```

### 4-data-flow-components.md
```markdown
# §4 — Data Flow / Components

> Current state analysis + target architecture.

## Current State

<!-- How does data flow through the system today? -->

## Component Boundaries

<!-- What are the key modules/services and their responsibilities? -->

## Shared State

<!-- What state is shared between components? How is it synchronized? -->

## Target Architecture

<!-- What does the new architecture look like? Key decisions and rationale. -->

### Key Decisions

<!-- Tag each as KD-N for cross-referencing -->
```

### 5-interfaces-apis.md
```markdown
# §5 — Interfaces and APIs

> External APIs, internal endpoints, database schemas.

## External APIs

<!-- APIs consumed from third parties -->

## Internal APIs

<!-- Endpoints this system exposes -->

## Database Schema

<!-- Key tables/collections and their structure -->
```

### 6-implementation-plan.md
```markdown
# §6 — Implementation Plan

> Phases, workstreams, prompts, tests, migrations, rollback.

## 6.1 Phased Rollout

<!-- Build order, dependencies, what's parallelizable -->

## 6.2 Workstream Breakdown

<!-- Parallel work tracks, interface contracts between them -->

## 6.3 Prompt Sequence

<!-- One prompt per implementation unit -->
<!--
Each prompt should include:
- <read-first> block listing 4-6 specific source files
- Command recommendation (/think, /ultraplan, /plan)
- TDD test names (the test is the first deliverable)
- Exact file paths to create/modify
-->

## 6.4 Testing Strategy

<!-- Per-unit matrix -->

| Unit | UNIT | INTEGRATION | POST-DEPLOY |
|------|------|-------------|-------------|
|      |      |             |             |

## 6.5 Migration Sequence

<!-- Numbered steps, all additive (no breaking changes), deployable before code -->

## 6.6 Rollback Plan

<!-- Scenario → action table, coexistence strategy for old/new -->

| Scenario | Action | Notes |
|----------|--------|-------|
|          |        |       |
```

### 7-non-functional-requirements.md
```markdown
# §7 — Non-Functional Requirements

> Performance, reliability, operational, security constraints.

## Performance

<!-- Tag each as PERF-N -->

## Reliability

<!-- Tag each as REL-N -->

## Operational

<!-- Tag each as OPS-N -->

## Security

<!-- Tag each as SEC-N -->
```

### 8-risks-alternatives.md
```markdown
# §8 — Risks and Alternatives

> Known risks with mitigations, rejected approaches with reasoning.

## Risks

<!-- Tag each as R-N -->

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
|    |      |           |        |            |

## Rejected Alternatives

<!-- Tag each as A-N. Include WHY it was rejected — future readers need the reasoning. -->
```

### README.md
```markdown
# {Spec Name} — Engineering Spec

> {description from $1, or omit this line if none provided}
>
> Created: {date}

## Status

| # | Section | Status |
|---|---------|--------|
| 1 | Problem / Motivation | [ ] empty |
| 2 | Scope | [ ] empty |
| 3 | High-Level Architecture | [ ] empty |
| 4 | Data Flow / Components | [ ] empty |
| 5 | Interfaces and APIs | [ ] empty |
| 6 | Implementation Plan | [ ] empty |
| 7 | Non-Functional Requirements | [ ] empty |
| 8 | Risks and Alternatives | [ ] empty |

## Quick Start

<!-- Filled in during finalization -->

## Research Sources

See [research/sources.md](research/sources.md) for indexed source documents.
```

### research/sources.md
```markdown
# Research Sources

> Indexed documents feeding into this spec. Each tagged with which sections it informs.

<!-- Format:
- **DOC-N**: {title} — {one-line description}. Feeds: §N, §N.
-->
```

### current-state/analysis.md (brownfield only)
```markdown
# Current State Analysis

> Analysis of the existing system being redesigned.

## System Overview

<!-- What exists today? -->

## Pain Points

<!-- What's broken, slow, or hard to maintain? -->

## Preserved Behaviors

<!-- What MUST remain the same after the rewrite? -->
```

---

## Constraint ID Conventions

| Prefix | Domain | Lives In |
|--------|--------|----------|
| ARCH-N | Architecture | §3, §4 |
| IMPL-N | Implementation | §6 |
| TEST-N | Testing | §6 |
| PERF-N | Performance | §7 |
| REL-N | Reliability | §7 |
| OPS-N | Operational | §7 |
| SEC-N | Security | §7 |
| KD-N | Key Decisions | §4 target arch |
| R-N | Risks | §8 |
| A-N | Alternatives | §8 |
| DOC-N | Research docs | research/sources.md |

---

## Key Principles

1. **User drives content, Claude drives structure.** Never invent requirements. Place user input in the correct section with proper tagging.
2. **Scaffold first, fill interactively.** Create the empty structure immediately so the user can see what they're building toward.
3. **Cross-reference everything.** Constraints reference sections. Docs reference sections. Prompts reference docs and files.
4. **TDD-first in §6.** Every prompt in the Implementation Plan must list failing test names before implementation instructions.
5. **Empty sections are fine.** Don't fill sections preemptively. Mark them empty and move on.
6. **Constraints belong where they shape design.** A testing requirement goes in §6, not §7. A modularity requirement goes in §4, not §7. Operational limits go in §7.
7. **One question at a time.** Don't overwhelm the user with multiple questions. Ask about one section or one aspect, then write what they give you.
