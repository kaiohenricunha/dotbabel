# §2 — Scope

> What's in, what's out, and where are the boundaries?

## In Scope

- Bundled starter agents shipped with dotbabel (curated small set, not exhaustive)
- Bootstrap template updates so agents are installed alongside skills on `bootstrap.sh`
- `model:` frontmatter routing on skills and agents (opus/sonnet/haiku/inherit)
- A `/agents:search` discovery skill for finding and fetching agents from the catalog
- Plugin manifest (`marketplace.json` / `plugin.json`) wiring for the agents category

## Out of Scope

- Building a full 140-agent catalog — we ship a curated starter set, not a replica of awesome-claude-code-subagents
- A custom interactive installer script — bootstrap.sh handles installation
- Agent lifecycle management (versioning, update notifications) — deferred to a future spec
- Custom agent type definitions beyond what Claude Code natively supports

## Boundaries

| Touches                        | Does Not Touch                        |
| ------------------------------ | ------------------------------------- |
| `plugins/dotbabel/templates/`  | Agent runtime / Claude Code internals |
| `plugins/dotbabel/src/`        | Existing skills content               |
| `.claude/skills-manifest.json` | CI pipelines                          |
| `bootstrap.sh`                 | External agent catalogs               |
| `docs/specs/dotbabel-agents/`  | Other spec domains                    |

## Urgency

No hard deadline. Ecosystem is moving in this direction now — shipping before dotbabel-core stabilizes keeps the agent layer composable from the start.
