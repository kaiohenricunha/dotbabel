# §1 — Problem / Motivation

> Why does this exist? What's broken? Why now?

## Why

dotbabel today ships skills and commands, but agents — the `.claude/agents/` primitive — are treated as a side effect of skills rather than a first-class artifact. Users who install dotbabel get no bundled agents, no template for creating them, no discovery mechanism, and no guidance on model routing. The result is that advanced Claude Code capabilities (persistent specialized agents, model cost optimization, inter-agent orchestration) are invisible to dotbabel users even though the platform fully supports them.

## What

Add a first-class agent layer to dotbabel — bundled starter agents, a bootstrap template that installs them, `model:` routing in skill/agent frontmatter, and a `/agents:search` discovery skill — so that users get the full Claude Code primitives, not just the skills subset.

## Why Now

The `awesome-claude-code-subagents` project demonstrates the pattern is mature and the ecosystem is moving in this direction. Claude Code's agent plugin system (`marketplace.json`, `.claude/agents/`) is stable. dotbabel is already the right distribution vehicle — we just haven't used it for agents yet.
