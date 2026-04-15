# §5 — Interfaces and APIs

> CLI interface, Node API surface, updated dispatcher.

## CLI Interface

### `dotclaude bootstrap`

```
dotclaude-bootstrap [OPTIONS]

Set up (or refresh) ~/.claude/ by symlinking commands/, skills/, CLAUDE.md,
and copying agent templates into place. Idempotent — safe to re-run.

Options:
  --source <path>   Path to a local dotclaude git clone. Overrides DOTCLAUDE_DIR.
                    Default: npm package install directory.
  --target <dir>    Override destination directory. Default: ~/.claude
  --quiet           Suppress per-file progress; print summary only.
  --json            Emit a JSON array of {kind, message} events on stdout.
  --no-color        Suppress ANSI colour.
  --help, -h
  --version, -V

Exit codes: 0 ok, 1 validation failure, 2 env error, 64 usage error.

Examples:
  dotclaude bootstrap
  dotclaude bootstrap --source ~/projects/dotclaude
  DOTCLAUDE_DIR=~/projects/dotclaude dotclaude bootstrap --quiet
```

### `dotclaude sync`

```
dotclaude-sync <subcommand> [OPTIONS]

Subcommands:
  pull      Update dotclaude and re-bootstrap ~/.claude/
            npm mode:   npm update -g @dotclaude/dotclaude, then bootstrap
            clone mode: git fetch + rebase origin/main, then bootstrap
  status    Show current version vs. latest (npm mode) or git status (clone mode)
  push      [clone mode only] Secret-scan, commit, and push the dotclaude clone

Options:
  --source <path>   Path to local dotclaude git clone (activates clone mode).
                    Overrides DOTCLAUDE_DIR.
  --quiet           Summary output only.
  --json            JSON output mode.
  --no-color
  --help, -h
  --version, -V

Exit codes: 0 ok, 1 failure, 2 env error (git/npm not found), 64 usage error.

Examples:
  dotclaude sync pull
  dotclaude sync status
  dotclaude sync pull --source ~/projects/dotclaude
  dotclaude sync push --source ~/projects/dotclaude
```

### Updated `dotclaude` dispatcher

`dotclaude.mjs` SUBCOMMANDS array gains two entries:

```js
const SUBCOMMANDS = [
  "bootstrap", // ← new
  "sync", // ← new
  "validate-skills",
  "validate-specs",
  "check-spec-coverage",
  "check-instruction-drift",
  "detect-drift",
  "doctor",
  "init",
];
```

### Updated `dotclaude-doctor`

Doctor gains one new check section — **bootstrap** — reporting the state of
each expected symlink in `~/.claude/`:

```
  ✓ CLAUDE.md         → /path/to/dotclaude/CLAUDE.md
  ✓ commands/         → 14 files linked
  ✓ skills/           → 12 dirs linked
  ⚠ agents/           → 0 files (run dotclaude bootstrap to install)
```

If `~/.claude/` has never been bootstrapped, doctor emits a single `warn`
suggesting `dotclaude bootstrap` rather than failing with an error.

## Node API Surface

Two new exports added to `index.mjs`:

```js
/**
 * Set up or refresh ~/.claude/ by symlinking source files into the target.
 *
 * @param {object} [opts]
 * @param {string} [opts.source]   Path to dotclaude root. Defaults to pkg root.
 * @param {string} [opts.target]   Destination dir. Defaults to $HOME/.claude.
 * @param {boolean} [opts.quiet]
 * @param {boolean} [opts.json]
 * @param {boolean} [opts.noColor]
 * @returns {{ ok: boolean, linked: number, skipped: number, backed_up: number }}
 */
export { bootstrapGlobal } from "./bootstrap-global.mjs";

/**
 * Pull updates (npm or git) and re-bootstrap, or query status.
 *
 * @param {'pull'|'status'|'push'} subcommand
 * @param {object} [opts]
 * @param {string} [opts.source]   Activates clone mode.
 * @param {boolean} [opts.quiet]
 * @param {boolean} [opts.json]
 * @param {boolean} [opts.noColor]
 * @returns {{ ok: boolean, mode: 'npm'|'clone', summary: string }}
 */
export { syncGlobal } from "./sync-global.mjs";
```

## package.json Changes

```json
{
  "files": [
    "commands/",
    "skills/",
    "CLAUDE.md",
    "plugins/dotclaude/src/",
    "plugins/dotclaude/bin/",
    "plugins/dotclaude/scripts/",
    "plugins/dotclaude/templates/",
    "plugins/dotclaude/hooks/",
    "plugins/dotclaude/README.md",
    "plugins/dotclaude/.claude-plugin/"
  ],
  "bin": {
    "dotclaude": "./plugins/dotclaude/bin/dotclaude.mjs",
    "dotclaude-bootstrap": "./plugins/dotclaude/bin/dotclaude-bootstrap.mjs",
    "dotclaude-sync": "./plugins/dotclaude/bin/dotclaude-sync.mjs",
    "dotclaude-doctor": "./plugins/dotclaude/bin/dotclaude-doctor.mjs",
    "dotclaude-detect-drift": "./plugins/dotclaude/bin/dotclaude-detect-drift.mjs",
    "dotclaude-validate-skills": "./plugins/dotclaude/bin/dotclaude-validate-skills.mjs",
    "dotclaude-check-spec-coverage": "./plugins/dotclaude/bin/dotclaude-check-spec-coverage.mjs",
    "dotclaude-validate-specs": "./plugins/dotclaude/bin/dotclaude-validate-specs.mjs",
    "dotclaude-check-instruction-drift": "./plugins/dotclaude/bin/dotclaude-check-instruction-drift.mjs",
    "dotclaude-init": "./plugins/dotclaude/bin/dotclaude-init.mjs"
  }
}
```
