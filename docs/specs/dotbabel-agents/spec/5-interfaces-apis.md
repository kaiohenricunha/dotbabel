# §5 — Interfaces and APIs

> External APIs, internal endpoints, database schemas.

## Agent File Format

Every agent is a `.md` file with YAML frontmatter. This is the contract between dotbabel and Claude Code:

```yaml
---
name: security-auditor # kebab-case, unique within ~/.claude/agents/
description: > # Shown in Claude Code UI; used for auto-activation matching
  Use when reviewing code for security vulnerabilities, auditing PRs,
  or analyzing attack surface. Triggers on: "security review", "audit", "CVE".
tools: Read, Grep, Glob # Comma-separated; minimal necessary permissions
model: opus # See model routing below
---
You are a security-focused code reviewer...
```

**Required frontmatter fields:** `name`, `description`, `tools`, `model`

---

## Model Routing Values

| Value     | Maps To               | When to Use                                                                  |
| --------- | --------------------- | ---------------------------------------------------------------------------- |
| `opus`    | claude-opus-4-6       | Deep reasoning — security audits, architecture review, complex orchestration |
| `sonnet`  | claude-sonnet-4-6     | Everyday coding — feature work, bug fixes, refactors                         |
| `haiku`   | claude-haiku-4-5      | Lightweight tasks — docs, formatting, quick lookups                          |
| `inherit` | Caller's active model | When the agent should flex with the user's session model                     |

**Starter agent tier assignments:**

| Agent                   | Model    | Rationale                                             |
| ----------------------- | -------- | ----------------------------------------------------- |
| `security-auditor`      | `opus`   | High-stakes analysis; false negatives are costly      |
| `architect-reviewer`    | `opus`   | Deep cross-cutting reasoning across large codebases   |
| `workflow-orchestrator` | `opus`   | Coordinates other agents; reasoning quality compounds |
| `backend-developer`     | `sonnet` | Everyday implementation work                          |
| `frontend-developer`    | `sonnet` | Everyday implementation work                          |
| `test-engineer`         | `sonnet` | Test writing is structured but not cheap              |
| `documentation-writer`  | `haiku`  | Formulaic; low reasoning demand                       |
| `changelog-assistant`   | `haiku`  | Git log summarization; lightweight                    |

---

## `/agents:search` Skill Commands

The discovery skill exposes four sub-commands:

### `search <query>`

- Case-insensitive substring match against agent names and descriptions
- Searches local `~/.claude/agents/` first, then remote catalog (if cache warm)
- Returns a table: `Name | Model | Tools | Description`

### `fetch <name>`

- Retrieves full agent definition (frontmatter + body)
- Offers: save to `~/.claude/agents/`, customize before saving, or just inspect

### `list`

- Lists all installed agents in `~/.claude/agents/` with one-line descriptions
- Groups by model tier (opus / sonnet / haiku / inherit)

### `invalidate [--fetch]`

- Clears `~/.claude/cache/agents-catalog.md`
- `--fetch` immediately re-populates from GitHub before returning

---

## `plugin.json` Schema Changes

Current:

```json
{
  "name": "harness",
  "description": "...",
  "author": { ... }
}
```

Target — add `agents` array:

```json
{
  "name": "harness",
  "description": "...",
  "author": { ... },
  "agents": [
    "./templates/claude/agents/security-auditor.md",
    "./templates/claude/agents/architect-reviewer.md",
    "./templates/claude/agents/backend-developer.md",
    "./templates/claude/agents/frontend-developer.md",
    "./templates/claude/agents/test-engineer.md",
    "./templates/claude/agents/documentation-writer.md",
    "./templates/claude/agents/workflow-orchestrator.md",
    "./templates/claude/agents/changelog-assistant.md"
  ]
}
```
