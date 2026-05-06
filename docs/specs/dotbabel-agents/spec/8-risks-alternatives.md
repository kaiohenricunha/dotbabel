# §8 — Risks and Alternatives

> Known risks with mitigations, rejected approaches with reasoning.

## Risks

| ID  | Risk                                                                                              | Likelihood | Impact | Mitigation                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | Claude Code changes the `.claude/agents/` spec or frontmatter contract, breaking installed agents | Low        | High   | Pin to documented Claude Code behavior; monitor release notes. Agent files are plain markdown — degradation is graceful (ignored, not crashed). |
| R-2 | `bootstrap.sh` agent copy overwrites user-customized agents on re-run                             | Medium     | High   | OPS-1: skip copy if destination exists. Document the behavior explicitly in bootstrap output.                                                   |
| R-3 | `model: opus` agents surprise users with higher token costs                                       | Medium     | Medium | Document tier rationale in each agent's description. Default borderline agents to `sonnet`, not `opus`.                                         |
| R-4 | Starter agent set becomes stale as Claude Code evolves                                            | Medium     | Low    | Agents are plain markdown — users can edit freely. Staleness is visible and self-correcting.                                                    |
| R-5 | GitHub API rate limit blocks `/agents:search fetch` in CI or headless contexts                    | Low        | Low    | REL-1: fall back to stale cache. Remote fetch is optional, not required.                                                                        |

## Rejected Alternatives

- **A-1: Ship a full 140-agent catalog (mirroring awesome-claude-code-subagents)**
  Rejected because the maintenance burden would be enormous and the value is unclear — most agents would go unused by most users. A curated starter set of 8 high-value agents is the right scope. Users who want the full catalog can install awesome-claude-code-subagents directly via `/agents:search fetch`.

- **A-2: Build a custom interactive installer script (like awesome-claude-code-subagents' `install-agents.sh`)**
  Rejected because `bootstrap.sh` is already the installation vehicle for dotclaude. Adding a second installer creates a confusing split. The right answer is to extend bootstrap, not add a parallel path.

- **A-3: Store agents under `templates/.claude/agents/` (with the dot)**
  Rejected in favor of `templates/claude/agents/` (without the dot) to match the existing convention in this repo — `templates/claude/` already holds `settings.json`, `hooks/`, and `skills-manifest.json`. Consistency beats pedantry. See KD-1.

- **A-4: Make `/agents:search` an agent (not a skill)**
  Rejected because discovery is a user-invoked command, not a persistent specialist. It has no domain expertise — it's plumbing. Skills are the right primitive for commands; agents are the right primitive for specialists. See KD-3.
