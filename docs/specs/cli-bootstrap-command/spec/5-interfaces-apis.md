# §5 — Interfaces and APIs

> CLI interface, Node API surface, updated dispatcher.

## CLI Interface

### `dotbabel bootstrap`

```
dotbabel-bootstrap [OPTIONS]

Set up (or refresh) ~/.claude/ by symlinking commands/, skills/, CLAUDE.md,
and copying agent templates into place. Idempotent — safe to re-run.

Options:
  --source <path>   Path to a local dotbabel git clone. Overrides DOTBABEL_DIR.
                    Default: npm package install directory.
  --target <dir>    Override destination directory. Default: ~/.claude
  --quiet           Suppress per-file progress; print summary only.
  --json            Emit a JSON array of {kind, message} events on stdout.
  --no-color        Suppress ANSI colour.
  --help, -h
  --version, -V

Exit codes: 0 ok, 1 validation failure, 2 env error, 64 usage error.

Examples:
  dotbabel bootstrap
  dotbabel bootstrap --source ~/projects/dotbabel
  DOTBABEL_DIR=~/projects/dotbabel dotbabel bootstrap --quiet
```

### `dotbabel sync`

```
dotbabel-sync <subcommand> [OPTIONS]

Subcommands:
  pull      Update dotbabel and re-bootstrap ~/.claude/
            npm mode:   npm update -g @dotbabel/dotbabel, then bootstrap
            clone mode: git fetch + rebase origin/main, then bootstrap
  status    Show current version vs. latest (npm mode) or git status (clone mode)
  push      [clone mode only] Secret-scan, commit, and push the dotbabel clone

Options:
  --source <path>   Path to local dotbabel git clone (activates clone mode).
                    Overrides DOTBABEL_DIR.
  --quiet           Summary output only.
  --json            JSON output mode.
  --no-color
  --help, -h
  --version, -V

Exit codes: 0 ok, 1 failure, 2 env error (git/npm not found), 64 usage error.

Examples:
  dotbabel sync pull
  dotbabel sync status
  dotbabel sync pull --source ~/projects/dotbabel
  dotbabel sync push --source ~/projects/dotbabel
```

### Updated `dotbabel` dispatcher

`dotbabel.mjs` SUBCOMMANDS array gains two entries:

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

### Updated `dotbabel-doctor`

Doctor gains one new check section — **bootstrap** — reporting the state of
each expected symlink in `~/.claude/`:

```
  ✓ CLAUDE.md         → /path/to/dotbabel/CLAUDE.md
  ✓ commands/         → 14 files linked
  ✓ skills/           → 12 dirs linked
  ⚠ agents/           → 0 files (run dotbabel bootstrap to install)
```

If `~/.claude/` has never been bootstrapped, doctor emits a single `warn`
suggesting `dotbabel bootstrap` rather than failing with an error.

## Node API Surface

Two new exports added to `index.mjs`:

```js
/**
 * Set up or refresh ~/.claude/ by symlinking source files into the target.
 *
 * @param {object} [opts]
 * @param {string} [opts.source]   Path to dotbabel root. Defaults to pkg root.
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
    "plugins/dotbabel/src/",
    "plugins/dotbabel/bin/",
    "plugins/dotbabel/scripts/",
    "plugins/dotbabel/templates/",
    "plugins/dotbabel/hooks/",
    "plugins/dotbabel/README.md",
    "plugins/dotbabel/.claude-plugin/"
  ],
  "bin": {
    "dotbabel": "./plugins/dotbabel/bin/dotbabel.mjs",
    "dotbabel-bootstrap": "./plugins/dotbabel/bin/dotbabel-bootstrap.mjs",
    "dotbabel-sync": "./plugins/dotbabel/bin/dotbabel-sync.mjs",
    "dotbabel-doctor": "./plugins/dotbabel/bin/dotbabel-doctor.mjs",
    "dotbabel-detect-drift": "./plugins/dotbabel/bin/dotbabel-detect-drift.mjs",
    "dotbabel-validate-skills": "./plugins/dotbabel/bin/dotbabel-validate-skills.mjs",
    "dotbabel-check-spec-coverage": "./plugins/dotbabel/bin/dotbabel-check-spec-coverage.mjs",
    "dotbabel-validate-specs": "./plugins/dotbabel/bin/dotbabel-validate-specs.mjs",
    "dotbabel-check-instruction-drift": "./plugins/dotbabel/bin/dotbabel-check-instruction-drift.mjs",
    "dotbabel-init": "./plugins/dotbabel/bin/dotbabel-init.mjs"
  }
}
```
