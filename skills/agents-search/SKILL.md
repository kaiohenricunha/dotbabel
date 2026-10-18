---
id: agents-search
name: agents-search
type: skill
version: 1.0.0
domain: [devex]
platform: [none]
task: [debugging]
maturity: validated
owner: "@kaiohenricunha"
created: 2025-01-01
updated: 2026-04-17
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

### Read-only compute labels for `search` and `list`

Read agent definitions as data. These two sub-commands never install, fetch, synchronize,
or change an agent, a catalog, or a runtime setting.

Use a valid, explicitly authored `dotbabel.compute` declaration when it is available.
An installed native projection can omit that private metadata. In that case, read the
matching canonical source only through an existing, verified Dotbabel projection manifest
and an explicitly known source root. Verify the source identity and hash before using it.
Never guess a source root or follow an unverified generated comment. If the canonical
declaration cannot be verified, report **undeclared/legacy**.

Keep the authored mode, requirement and binding separate from the installed native `model`
and `effort` fields. `mode: inherit` belongs to the **inherit** group. Otherwise, group only
by an explicitly declared valid `requirement`. A dynamic or pinned declaration without an
explicit class belongs to **undeclared/legacy**, with its mode shown in the demand cell.
An absent or invalid declaration also belongs there; identify invalid metadata instead of
silently treating it as inheritance. Do not infer a demand class from a model name, a tool
list, a missing native model, or a normalized default. These labels describe declared demand,
not measured model quality or native enforcement.

Show native selectors and effort exactly as written, or `unset` when absent. A native
`model: inherit` remains a native control; it does not establish canonical inheritance.

### `search <query>`

Find installed agents whose name or description matches a query string.

**Steps:**

1. Use `Glob` to enumerate all files at `~/.claude/agents/*.md`.
2. For each file, use `Read` to load its content (frontmatter + body). Parse YAML frontmatter
   (the block between the first `---` and the second `---`) to extract:
   - `name` (string)
   - `model` and `effort` (native values, may be absent — display `unset`)
   - Canonical compute mode, explicit requirement and binding, using the read-only rules above
   - `tools` (array or comma-separated string, may be absent — default to `""`)
   - `description` (string — use only the first line if multi-line)
3. Perform a **case-insensitive substring match** of `<query>` against both `name` and the first
   line of `description`. Include a file if either field matches.
4. If one or more agents match, render a markdown table:

   ```
   | Name | Compute demand | Native model | Native effort | Tools | Description |
   | ---- | -------------- | ------------ | ------------- | ----- | ----------- |
   | ...  | ...            | ...          | ...           | ...   | ...         |
   ```

   - `Tools` column: join array entries with `", "` or display the raw string; truncate to 40 chars
     with `…` if longer.
   - `Description` column: first line of the `description` field only.

5. If no agents match, output exactly:

   ```
   No agents found matching '<query>'
   ```

6. If Glob returns no results (no agents installed), check `~/.claude/cache/agents-catalog.md` — if it exists and is less than 12 hours old (use `Bash(stat -c %Y ~/.claude/cache/agents-catalog.md 2>/dev/null || stat -f %m ~/.claude/cache/agents-catalog.md 2>/dev/null || echo 0)` to check mtime), display results from the catalog instead and note they are from the cached remote catalog.

---

### `list`

List all installed agents grouped by explicitly declared canonical compute demand.

**Steps:**

1. Use `Glob` to enumerate all files at `~/.claude/agents/*.md`.
2. For each file, `Read` its frontmatter and extract the same fields as `search`.
   Resolve canonical metadata only through the read-only rules above.
3. Group agents in this fixed order:
   - **mechanical** — explicit canonical requirement `mechanical`
   - **routine** — explicit canonical requirement `routine`
   - **deep** — explicit canonical requirement `deep`
   - **frontier** — explicit canonical requirement `frontier`
   - **exceptional** — explicit canonical requirement `exceptional`
   - **inherit** — explicit canonical `mode: inherit`
   - **undeclared/legacy** — no verified explicit class or inheritance declaration
4. For each non-empty group, render a section header and a table. Sort names within
   the group alphabetically. Show the canonical mode/class/binding in `Compute demand`;
   keep native controls in their own columns:

   ```markdown
   ### Frontier

   | Name | Compute demand | Native model | Native effort | Tools | Description |
   | ---- | -------------- | ------------ | ------------- | ----- | ----------- |
   ```

5. If `~/.claude/agents/` does not exist or contains no `.md` files, output:

   ```
   No agents installed. Run `/agents:search fetch <name>` to install one.
   ```

6. If Glob returns no results (no agents installed), check `~/.claude/cache/agents-catalog.md` — if it exists and is less than 12 hours old (use `Bash(stat -c %Y ~/.claude/cache/agents-catalog.md 2>/dev/null || stat -f %m ~/.claude/cache/agents-catalog.md 2>/dev/null || echo 0)` to check mtime), display results from the catalog instead and note they are from the cached remote catalog.

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
   `Bash(stat -c %Y ~/.claude/cache/agents-catalog.md 2>/dev/null || stat -f %m ~/.claude/cache/agents-catalog.md 2>/dev/null || echo 0)`.
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

1. Run `Bash(stat -c %Y ~/.claude/cache/agents-catalog.md 2>/dev/null || stat -f %m ~/.claude/cache/agents-catalog.md 2>/dev/null || echo 0)` to get mtime.
2. If `(now - mtime) > 43200` seconds (12 hours), display an inline notice:

   ```
   (Cache is stale — last updated more than 12 h ago. Run `/agents:search invalidate --fetch` to refresh.)
   ```

   Then continue with the stale data rather than blocking the user.

---

## Tool Usage

All file I/O uses Claude Code built-in tools — this is a skill, not a shell script:

| Operation                       | Tool                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| Enumerate agents                | `Glob`                                                                  |
| Read file content / frontmatter | `Read`                                                                  |
| Search catalog content          | `Grep`                                                                  |
| Write / install agent           | `Write`                                                                 |
| Delete cache file               | `Bash(rm <path>)`                                                       |
| Create cache directory          | `Bash(mkdir -p <path>)`                                                 |
| Check file mtime                | `Bash(stat -c %Y <path>)` (GNU) / `Bash(stat -f %m <path>)` (BSD/macOS) |
| Fetch remote catalog            | `WebFetch`                                                              |

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
6. **Canonical group order is fixed.** `list` uses mechanical → routine → deep → frontier →
   exceptional → inherit → undeclared/legacy. Native selectors remain separate metadata;
   never turn their spelling into a demand class, quality ranking, or enforcement claim.
