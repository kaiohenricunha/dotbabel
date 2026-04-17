# §7 — Non-Functional Requirements

> Performance, reliability, operational, security constraints.

## Performance

- **PERF-1**: `/agents:search list` (local only) must complete in < 1s on a cold shell. No network calls for local operations.
- **PERF-2**: Remote catalog fetch (GitHub API) uses a 12-hour TTL cache. Stale-cache reads are < 100ms.
- **PERF-3**: `model:` frontmatter resolution adds no measurable latency — Claude Code reads it natively at agent load time.

## Reliability

- **REL-1**: `/agents:search` must degrade gracefully on GitHub API failure — fall back to stale cache and surface a warning, never hard-fail. See §6 Workstream D.
- **REL-2**: `bootstrap.sh` agent installation must be idempotent — re-running bootstrap on an existing install must not corrupt or overwrite user-modified agent files. See OPS-1.
- **REL-3**: Validator failures must be actionable — every error must cite the file and field that failed, not just exit non-zero silently.

## Operational

- **OPS-1**: Bootstrap must never overwrite a user-modified agent file. Copy only if the destination does not exist. Users who want updates must delete and re-run. See §6 Prompt 3.
- **OPS-2**: The `agents` array in `plugin.json` must use relative paths so the plugin works regardless of where the repo is cloned.
- **OPS-3**: All 8 starter agents must pass `dotclaude-validate-skills` on every CI run. The validate-skills workflow is the enforcement gate.
- **OPS-4**: Cache file at `~/.claude/cache/agents-catalog.md` must be excluded from version control (already covered by `.gitignore` pattern for `~/.claude/cache/`).

## Security

- **SEC-1**: Agent `.md` files must not contain secrets, tokens, or credentials. The validator must check for common patterns (e.g., `ghp_`, `sk-`, `AKIA`) and reject on match.
- **SEC-2**: The `tools:` field must be the minimum necessary for the agent's role. Reviewer/auditor agents must not have `Write` or `Edit`. Enforced by validator lint rule.
- **SEC-3**: Remote catalog fetches in `/agents:search` must use HTTPS only. No HTTP fallback.
