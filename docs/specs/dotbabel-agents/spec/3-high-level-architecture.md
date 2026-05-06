# §3 — High-Level Architecture

> System view: components, data stores, external dependencies, deployment.

## System Overview

The agent layer sits alongside the existing skills layer. Agents are `.md` files with YAML frontmatter placed under `.claude/agents/`. dotbabel ships a curated set via its plugin template; `bootstrap.sh` copies them into the user's environment. A `/agents:search` skill provides discovery. Model routing (`model:` frontmatter) is a convention read natively by Claude Code — no new runtime tooling required.

```
dotbabel repo
└── plugins/dotbabel/templates/
    └── .claude/
        ├── agents/          ← new: bundled starter agents
        └── skills/          ← existing
            └── ...

bootstrap.sh
  → symlinks / copies agents/ into ~/.claude/agents/

Claude Code runtime
  → reads ~/.claude/agents/*.md
  → respects model: frontmatter per agent
```

## Data Stores

| Store                               | Role                           | Access Pattern                              |
| ----------------------------------- | ------------------------------ | ------------------------------------------- |
| `~/.claude/cache/agents-catalog.md` | TTL cache for `/agents:search` | Read on search, written on fetch/invalidate |

## External APIs / Dependencies

| Service               | Purpose                                                    | Rate Limits / Constraints                                      |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| GitHub API (optional) | Fetch agent definitions from awesome-claude-code-subagents | 60 req/hr unauthenticated; graceful degradation to stale cache |

## Deployment

Runs entirely on the user's local machine. No server, no hosted state. The `/agents:search` skill optionally reaches out to GitHub for remote catalog fetches — all other operations are local file I/O.
