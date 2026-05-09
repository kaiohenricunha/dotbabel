# dotbabel Taxonomy

_Last updated: v2.3.0_

The dotbabel taxonomy organizes every artifact (agents, skills, commands, hooks, templates) by **type** (flat directory) and **facets** (YAML frontmatter). This avoids the placement ambiguity of domain-first hierarchies and lets the generated index serve any faceted query.

## Why type-first?

Types have fundamentally different runtime contracts: an agent is invoked by the dispatcher; a skill is read by Claude; a command is user-typed; a hook is run by the harness. Mixing them by domain hides these contracts and forces arbitrary placement for cross-cutting work.

Domain, platform, task, and maturity are many-to-many with artifacts. They live in frontmatter as enum arrays, not as folder paths.

## Repo layout

```
dotbabel/
  agents/            # .md, flat
  skills/            # directory-per-skill: <slug>/SKILL.md
  commands/          # .md, flat
  hooks/             # .sh / .js / .md, flat
  templates/         # directory-per-template (scaffolding)

  schemas/           # JSON Schema per artifact type + shared facets
  index/             # generated — do not hand-edit
    artifacts.json   # full faceted index
    by-type.json     # { agent: [...], skill: [...], ... }
    by-facet.json    # { domain: {...}, platform: {...}, ... }
    README.md
  docs/              # taxonomy.md, governance.md, facet-definitions.md
```

Two structural rules:

1. Never nest by domain / platform / task / maturity. Those are frontmatter.
2. The plugin templates tree is generated from the top-level tree, not authored independently.

## Frontmatter schema (all types)

```yaml
id: <slug> # == filename basename, stable
name: <Human-Readable Name>
type: agent | skill | command | hook | template
description: <1–2 sentences, trigger-oriented>
version: 1.0.0 # semver

domain: [infra, backend, frontend, data, security, observability, devex, writing]
platform:
  [
    aws,
    azure,
    gcp,
    kubernetes,
    docker,
    vercel,
    flyio,
    neon,
    github-actions,
    crossplane,
    pulumi,
    terraform,
    terragrunt,
    none,
  ]
task: [debugging, migration, scaffolding, review, testing, documentation, incident-response]
maturity: draft | validated | production | deprecated

owner: <github-handle>
created: YYYY-MM-DD
updated: YYYY-MM-DD
```

See `docs/facet-definitions.md` for enum definitions with examples.

## CLI

```bash
# Rebuild the index
node plugins/dotbabel/bin/dotbabel-index.mjs

# Verify freshness (CI)
node plugins/dotbabel/bin/dotbabel-index.mjs --check

# Strict mode (fail on any schema warning)
node plugins/dotbabel/bin/dotbabel-index.mjs --strict

# Search
dotbabel search <query>
dotbabel list --type skill --domain infra --maturity validated
dotbabel show <id>
```

## Naming conventions

- Files, folders, slugs, IDs: strict `kebab-case`, ASCII only.
- Slug shape: `[<platform-or-domain>-]<object>-<task>` where it adds clarity.
- Reserved prefix `meta-` for taxonomy/governance artifacts.
- IDs are immutable once `maturity >= validated`. Renaming requires a new id and `deprecated_by` on the old one.

## New artifact vs variation

Create a **new artifact** when the platform, task, or required tools differ substantially. **Extend the existing artifact** (bump `version`) for flags, optional inputs, wording improvements, or expanding coverage within the same domain.

See `docs/governance.md` for the full promotion ladder and CI gates.

## Pairing agents with skills

Agents and skills are complementary, not redundant. For any domain deep enough to justify both, keep each artifact in its lane and link them via `related:`.

- **Agent** = thin persona + routing. Trigger keywords, tool list, and the four-section dotbabel pattern (`## Expertise`, `## Working Approach`, `## Standards` or `## Constraints`, `## Collaboration`). Target ~50 lines.
- **Skill** = procedural runbook. Multi-phase workflow, command catalogs, and supporting `references/` docs. As deep as the domain warrants.

**When to split vs. fatten an agent:** if a domain needs more than ~3 reference documents, a multi-phase procedure, or step-by-step command examples, author the depth as a skill and keep the agent thin. A 200-line agent is a smell — the content probably belongs in a skill.

**Linking:** the agent's frontmatter declares `related: [<skill-id>]` so Claude can read the skill on invocation. Both artifacts share the same base `id` (e.g. `kubernetes-specialist` agent, `kubernetes-specialist` skill). Use `dotbabel show <id> --type agent|skill` to disambiguate when both exist.

Canonical examples in this repo:

- `agents/kubernetes-specialist.md` (persona, triggers) ↔ `skills/kubernetes-specialist/SKILL.md` (investigation runbook + references)
- `agents/aws-engineer.md` (persona, triggers) ↔ `skills/aws-specialist/SKILL.md` (audit procedure + references)
