# §6 — Implementation Plan

> Phases, workstreams, prompts, tests, migrations, rollback.

## 6.1 Phased Rollout

| Phase | Work                                                         | Depends On                        |
| ----- | ------------------------------------------------------------ | --------------------------------- |
| 1     | Add `model:` frontmatter to all existing skills              | Nothing — fully independent       |
| 2     | Author starter agents in `templates/claude/agents/`          | Nothing — independent of Phase 1  |
| 3     | Update `plugin.json` with `agents` array                     | Phase 2 (agents must exist first) |
| 4     | Update `bootstrap.sh` to copy agents                         | Phase 2                           |
| 5     | Add `/agents:search` skill                                   | Phase 2 (needs agents to search)  |
| 6     | Update `dotclaude-validate-skills` to lint agent frontmatter | Phase 2                           |

Phases 1 and 2 are fully parallelizable.

## 6.2 Workstream Breakdown

### Workstream A — Model routing (Phase 1)

- Audit all skills in `skills/` for appropriate model tier
- Add `model:` to each frontmatter
- No runtime changes; Claude Code reads it natively
- Interface contract: `model: opus | sonnet | haiku | inherit`

### Workstream B — Starter agents (Phase 2)

- Create `plugins/dotclaude/templates/claude/agents/`
- Author 8 starter agents (see §5 for list and tier assignments)
- Each must pass frontmatter validation: `name`, `description`, `tools`, `model`

### Workstream C — Plugin manifest + bootstrap (Phases 3–4, depends on B)

- Add `agents` array to `plugins/dotclaude/.claude-plugin/plugin.json`
- Update `bootstrap.sh` to copy `templates/claude/agents/` → `~/.claude/agents/` (skip if file exists — OPS-1)

### Workstream D — Discovery skill (Phase 5, depends on B)

- Author `skills/agents-search.md` with `search`, `fetch`, `list`, `invalidate` commands
- Implement 12h TTL cache at `~/.claude/cache/agents-catalog.md`
- Graceful degradation to stale cache on network failure (REL-1)

### Workstream E — Validator update (Phase 6, depends on B)

- Extend `dotclaude-validate-skills` to also lint `~/.claude/agents/*.md`
- Required fields: `name`, `description`, `tools`, `model`
- Valid model values: `opus`, `sonnet`, `haiku`, `inherit`

## 6.3 Prompt Sequence

### Prompt 1 — Model routing pass (Workstream A)

```
Read first:
- plugins/dotclaude/templates/claude/skills-manifest.json
- skills/ (glob all .md files, read frontmatter)
- docs/specs/dotclaude-agents/spec/5-interfaces-apis.md (model routing table)

Task: Add `model:` frontmatter to every skill .md file under skills/.
Use the tier assignment table in §5 as guidance:
- opus: security-review, spec, validate-spec, create-audit, audit-and-fix, ground-first
- haiku: changelog, markdown, simplify
- sonnet: everything else
- inherit: skills that orchestrate other skills (dispatching-parallel-agents, executing-plans)

Failing test first:
- test: skills missing model: frontmatter → dotclaude-validate-skills exits non-zero
```

### Prompt 2 — Starter agents (Workstream B)

```
Read first:
- plugins/dotclaude/templates/claude/agents/ (create this directory)
- docs/specs/dotclaude-agents/spec/5-interfaces-apis.md (agent file format + tier table)
- /home/kaiocunha/Projects/VoltAgent/awesome-claude-code-subagents/categories/01-core-development/ (reference)
- /home/kaiocunha/Projects/VoltAgent/awesome-claude-code-subagents/categories/04-quality-security/ (reference)

Task: Author the 8 starter agents listed in §5. Follow the agent file format exactly.
Keep descriptions specific enough for auto-activation matching.
Scope tools to minimum necessary per agent type (see §5 tool scoping table from DOC-1).

Failing test first:
- test: each agent file has all required frontmatter fields → pass
- test: model value is one of opus/sonnet/haiku/inherit → pass
```

### Prompt 3 — Plugin manifest + bootstrap (Workstream C)

```
Read first:
- plugins/dotclaude/.claude-plugin/plugin.json
- bootstrap.sh
- plugins/dotclaude/templates/claude/agents/ (must exist from Prompt 2)
- plugins/dotclaude/tests/bats/bootstrap.bats

Task:
1. Add "agents" array to plugin.json pointing to all 8 agent files
2. Update bootstrap.sh to copy templates/claude/agents/ → ~/.claude/agents/
   - Skip copy if destination file already exists (OPS-1: never overwrite user edits)
   - Log each agent installed

Failing test first:
- test (bats): bootstrap.sh installs agents to ~/.claude/agents/
- test (bats): bootstrap.sh skips existing agent files (idempotent)
```

### Prompt 4 — `/agents:search` skill (Workstream D)

```
Read first:
- skills/dependabot-sweep.md (reference for skill structure)
- skills/changelog.md (reference for haiku-tier skill)
- docs/specs/dotclaude-agents/spec/5-interfaces-apis.md (command interface)
- /home/kaiocunha/Projects/VoltAgent/awesome-claude-code-subagents/tools/subagent-catalog/ (reference)

Task: Author skills/agents-search.md implementing the four sub-commands from §5.
Cache logic: check ~/.claude/cache/agents-catalog.md mtime; if > 12h or missing, fetch.
Fallback: if fetch fails, use stale cache and warn.

Failing test first:
- test: /agents:search list returns installed agents
- test: /agents:search invalidate clears cache file
```

### Prompt 5 — Validator update (Workstream E)

```
Read first:
- plugins/dotclaude/src/validate-skills-inventory.mjs
- plugins/dotclaude/tests/validate-skills-inventory.test.mjs
- plugins/dotclaude/bin/dotclaude-validate-skills.mjs
- docs/specs/dotclaude-agents/spec/5-interfaces-apis.md (required fields + valid model values)

Task: Extend validate-skills-inventory to also validate agent files under .claude/agents/.
Required fields: name, description, tools, model.
Valid model values: opus, sonnet, haiku, inherit.
Emit clear error messages citing file:line for each violation.

Failing test first:
- test: agent missing model: → non-zero exit + error message
- test: agent with model: invalid → non-zero exit + error message
- test: valid agent → passes
```

## 6.4 Testing Strategy

| Unit                       | UNIT                                         | INTEGRATION                                      | POST-DEPLOY                                |
| -------------------------- | -------------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| Model routing frontmatter  | Validate all skills have valid model: value  | `dotclaude-validate-skills` exits 0 on full repo | Spot-check one skill invocation per tier   |
| Starter agents             | Each agent has required fields + valid model | `dotclaude-validate-skills` passes on agents/    | Claude Code surfaces agents in UI          |
| `plugin.json` agents array | JSON schema check                            | `claude plugin install` picks up agents          | Agents appear in fresh install             |
| `bootstrap.sh` agent copy  | Bats: installs agents; skips existing        | End-to-end bootstrap on clean $HOME              | `ls ~/.claude/agents/` post-bootstrap      |
| `/agents:search` skill     | Cache TTL logic; fallback on network failure | Search returns installed agents                  | `search security` returns security-auditor |
| Validator extension        | Missing/invalid fields → non-zero exit       | CI validate-skills step catches bad agents       | PR with bad agent file fails CI            |

## 6.5 Migration Sequence

All steps are additive — no existing behavior changes until bootstrap.sh is run by the user.

1. Add `model:` to skill frontmatter (read-only metadata; no behavior change for existing users)
2. Create `templates/claude/agents/` with starter agents (new directory; no conflict)
3. Update `plugin.json` with `agents` array (additive field; ignored by older Claude Code versions)
4. Update `bootstrap.sh` — new agent copy step runs only on fresh files (skips existing)
5. Ship `/agents:search` skill (new file; no conflict with existing skills)
6. Update validator — new checks apply only to agent files; existing skill checks unchanged

## 6.6 Rollback Plan

| Scenario                                            | Action                                  | Notes                                               |
| --------------------------------------------------- | --------------------------------------- | --------------------------------------------------- |
| Bundled agent causes problems                       | Delete `~/.claude/agents/<name>.md`     | Per-agent; no global rollback needed                |
| `plugin.json` agents array breaks older Claude Code | Remove `agents` field from plugin.json  | Additive field; shouldn't break, but safe to revert |
| bootstrap.sh agent copy step breaks bootstrap       | Remove the copy block from bootstrap.sh | Agents directory still exists; no data loss         |
| `/agents:search` skill is buggy                     | Delete `skills/agents-search.md`        | Standalone file; no dependencies                    |
| Validator rejects valid agents                      | Revert validator change                 | Previous version in git; `git revert` the commit    |
