# §4 — Data Flow / Components

> Current state analysis + target architecture.

## Current State

`plugins/dotbabel/templates/claude/` holds settings, hooks, and `skills-manifest.json`. `bootstrap.sh` copies these into `~/.claude/`. The `plugin.json` is flat with no `agents` field. No `agents/` directory exists anywhere in the template tree. Skills have no `model:` frontmatter — all run on whatever model the user has active.

```
plugins/dotbabel/
├── .claude-plugin/plugin.json      ← no agents field
├── templates/
│   └── claude/
│       ├── settings.json
│       ├── hooks/
│       └── skills-manifest.json
└── (no agents/ anywhere)
```

## Component Boundaries

| Component                           | Responsibility                                                             |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `templates/claude/agents/`          | Stores bundled starter agent `.md` files                                   |
| `plugin.json`                       | Declares the `agents` array for Claude Code plugin system                  |
| `/agents:search` skill              | Discovery — search, fetch, and inspect agents from local or remote catalog |
| `~/.claude/cache/agents-catalog.md` | Local TTL cache for remote catalog fetches                                 |
| `model:` frontmatter convention     | Routes each agent/skill to the appropriate Claude tier                     |

## Shared State

| State            | Location                            | Consumers                  |
| ---------------- | ----------------------------------- | -------------------------- |
| Installed agents | `~/.claude/agents/*.md`             | Claude Code runtime        |
| Catalog cache    | `~/.claude/cache/agents-catalog.md` | `/agents:search` skill     |
| Skills manifest  | `~/.claude/skills-manifest.json`    | `dotbabel-validate-skills` |

No shared mutable state between agents at runtime — each agent is stateless and scoped to its invocation.

## Target Architecture

```
plugins/dotbabel/
├── .claude-plugin/plugin.json      ← gains "agents" array
├── templates/
│   └── claude/
│       ├── agents/                 ← new: starter agents
│       │   ├── security-auditor.md
│       │   ├── architect-reviewer.md
│       │   └── ...
│       ├── settings.json
│       ├── hooks/
│       └── skills-manifest.json
└── skills/
    └── agents-search.md            ← new: /agents:search discovery skill
```

Bootstrap flow:

```
bootstrap.sh
  → copies templates/claude/agents/ → ~/.claude/agents/
  → Claude Code reads ~/.claude/agents/*.md natively
  → model: frontmatter respected per agent invocation
```

### Key Decisions

- **KD-1**: Agents land in `templates/claude/agents/` — matches existing `templates/claude/` convention (not `templates/.claude/`). See §6 for migration note.
- **KD-2**: `plugin.json` gains an `agents` array — Claude Code reads this natively, no dotbabel runtime changes needed.
- **KD-3**: `/agents:search` is a skill, not an agent — it's a user-invoked command, not a persistent specialist. Feeds into §5.
