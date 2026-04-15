---
name: agents-search
description: >
  Discover, search, and manage Claude Code agents. Use when you want to find available
  agents, list installed agents, or refresh the agent catalog.
  Triggers on: "search agents", "list agents", "find agent", "what agents", "agent catalog".
argument-hint: "search <query> | list | fetch <name> | invalidate [--fetch]"
tools: Glob, Read, Grep, Write, Bash, WebFetch
effort: medium
model: sonnet
---

# Agents Search — Discovery and Management

Discover, search, and manage Claude Code sub-agents installed under `~/.claude/agents/`.
Supports four sub-commands: `search`, `list`, `fetch`, and `invalidate`.

## Arguments

- `$0` — sub-command: `search`, `list`, `fetch`, or `invalidate`. If not provided, default to `list`.
- `$1` — query string (for `search`), agent name (for `fetch`), or `--fetch` flag (for `invalidate`).

---

## Sub-Commands

### `search <query>`

Find installed agents whose name or description matches a query string.

**Steps:**

1. Use `Glob` to enumerate all files at `~/.claude/agents/*.md`.
2. For each file, use `Read` to load its content (frontmatter + body). Parse YAML frontmatter
   (the block between the first `---` and the second `---`) to extract:
   - `name` (string)
   - `model` (string, may be absent — default to `inherit`)
   - `tools` (array or comma-separated string, may be absent — default to `""`)
   - `description` (string — use only the first line if multi-line)
3. Perform a **case-insensitive substring match** of `<query>` against both `name` and the first
   line of `description`. Include a file if either field matches.
4. If one or more agents match, render a markdown table:

   ```
   | Name | Model | Tools | Description |
   | ---- | ----- | ----- | ----------- |
   | ...  | ...   | ...   | ...         |
   ```

   - `Tools` column: join array entries with `, ` or display the raw string; truncate to 40 chars
     with `…` if longer.
   - `Description` column: first line of the `description` field only.

5. If no agents match, output exactly:

   ```
   No agents found matching '<query>'
   ```

6. If Glob returns no results (no agents installed), check `~/.claude/cache/agents-catalog.md` — if it exists and is less than 12 hours old (use `Bash(stat -c %Y ~/.claude/cache/agents-catalog.md 2>/dev/null || echo 0)` to check mtime), display results from the catalog instead and note they are from the cached remote catalog.

---

### `list`

List all installed agents grouped by model tier.

**Steps:**

1. Use `Glob` to enumerate all files at `~/.claude/agents/*.md`.
2. For each file, `Read` its frontmatter and extract `name`, `model`, `tools`, `description`
   (same parsing rules as `search`).
3. Group agents by model tier in this order:
   - **opus** — entries where `model` contains `opus`
   - **sonnet** — entries where `model` contains `sonnet`
   - **haiku** — entries where `model` contains `haiku`
   - **inherit** — entries with no `model` field, `model: inherit`, or any other value
4. For each non-empty tier, render a section header and a table:

   ```markdown
   ### Opus

   | Name | Model | Tools | Description |
   | ---- | ----- | ----- | ----------- |
   ```

5. If `~/.claude/agents/` does not exist or contains no `.md` files, output:

   ```
   No agents installed. Run `/agents:search fetch <name>` to install one.
   ```

6. If Glob returns no results (no agents installed), check `~/.claude/cache/agents-catalog.md` — if it exists and is less than 12 hours old (use `Bash(stat -c %Y ~/.claude/cache/agents-catalog.md 2>/dev/null || echo 0)` to check mtime), display results from the catalog instead and note they are from the cached remote catalog.

---

### `fetch <name>`

Read a specific agent's full definition and offer install / view options.

**Steps:**

1. Construct the local path `~/.claude/agents/<name>.md`.
2. Attempt `Read` on that path.
   - **If found locally:** display the agent's frontmatter fields (one per line, `key: value`)
     followed by the full body. Then present the user with options:
     - Already installed — offer to re-display or customize.
     - Customize — open the file for editing via a follow-up Edit call.
     - View only — no further action.
3. **If not found locally:** check whether `~/.claude/cache/agents-catalog.md` exists via `Read`.
   - If the catalog exists, search it for a section or entry matching `<name>` (case-insensitive).
     If a match is found, display the matching content and offer the user three options:
     - Install — write the agent definition to `~/.claude/agents/<name>.md` using `Write`.
     - Customize — show the content and ask the user to provide edits before writing.
     - View only — no further action.
   - If the catalog does not exist or contains no match, output:

     ```
     Agent '<name>' not found locally or in catalog.
     Run `/agents:search invalidate --fetch` to refresh the catalog, then try again.
     ```

---

### `invalidate [--fetch]`

Clear the local agent catalog cache, optionally refreshing it from GitHub.

**Steps:**

1. **If `--fetch` flag is present:** Read the mtime of `~/.claude/cache/agents-catalog.md`
   now (before deleting anything) using
   `Bash(stat -c %Y ~/.claude/cache/agents-catalog.md 2>/dev/null || echo 0)`.
   Store the result for informational use later.

2. Check whether `~/.claude/cache/agents-catalog.md` exists via `Read`.
   - If it exists, delete it using `Bash`: `rm ~/.claude/cache/agents-catalog.md`.
   - If it does not exist, note "No cache file found."

3. **Without `--fetch`** (cache clear only):
   Output:

   ```
   Cache cleared.
   ```

4. **With `--fetch`** (clear and refresh — user explicitly requested a fresh fetch):
   - Fetch the catalog using `WebFetch` from:
     `https://raw.githubusercontent.com/VoltAgent/awesome-claude-code-subagents/main/README.md`
     - Use HTTPS only (SEC-3).
     - If the fetch succeeds, ensure `~/.claude/cache/` exists
       (`Bash: mkdir -p ~/.claude/cache`) and save the content to
       `~/.claude/cache/agents-catalog.md` using `Write`.
       Output:

       ```
       Catalog refreshed. <N> bytes written to ~/.claude/cache/agents-catalog.md
       ```

     - If the fetch fails (network error, non-200, timeout), **do not hard-fail** (REL-1).
       Warn the user:

       ```
       Warning: Could not fetch catalog (network error). Existing cache cleared.
       Run `/agents:search invalidate --fetch` again when connectivity is restored.
       ```

       Do not throw or abort; return gracefully.

---

## Cache TTL

Whenever `search` or `list` falls back to `~/.claude/cache/agents-catalog.md` for data,
check whether the cache is stale before using it:

1. Run `Bash(stat -c %Y ~/.claude/cache/agents-catalog.md 2>/dev/null || echo 0)` to get mtime.
2. If `(now - mtime) > 43200` seconds (12 hours), display an inline notice:

   ```
   (Cache is stale — last updated more than 12 h ago. Run `/agents:search invalidate --fetch` to refresh.)
   ```

   Then continue with the stale data rather than blocking the user.

---

## Tool Usage

All file I/O uses Claude Code built-in tools — this is a skill, not a shell script:

| Operation                       | Tool                         |
| ------------------------------- | ---------------------------- |
| Enumerate agents                | `Glob`                       |
| Read file content / frontmatter | `Read`                       |
| Search catalog content          | `Grep`                       |
| Write / install agent           | `Write`                      |
| Delete cache file               | `Bash(rm <path>)`            |
| Create cache directory          | `Bash(mkdir -p <path>)`      |
| Check file mtime                | `Bash(stat -c %Y <path>)`    |
| Fetch remote catalog            | `WebFetch`                   |

---

## Key Principles

1. **Case-insensitive everywhere.** All name and description matching is case-insensitive.
2. **Graceful degradation.** Network failures in `invalidate --fetch` warn and continue; they
   never abort the session or raise an unhandled error (REL-1).
3. **HTTPS only.** The catalog URL must always use `https://` (SEC-3).
4. **Read before write.** Use `Read` to check existing files before `Write` to avoid blind
   overwrites without user confirmation.
5. **User drives installs.** Never silently write to `~/.claude/agents/` without presenting
   options and getting implicit or explicit user consent.
6. **Tier order is fixed.** `list` always outputs opus → sonnet → haiku → inherit. Never
   reorder based on agent count or alphabetical sort within tiers (alphabetical within a tier
   is acceptable).
