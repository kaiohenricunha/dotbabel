# §6 — Implementation Plan

> Phases, workstreams, prompts, tests, migrations, rollback.

## 6.1 Phased Rollout

```
Phase 1 — ship commands/skills/CLAUDE.md in the package (package.json only)
    ↓
Phase 2 — implement bootstrap-global.mjs + bin + tests
    ↓
Phase 3 — implement sync-global.mjs + bin + tests
    ↓
Phase 4 — update dispatcher + doctor + exports + docs
```

Phases 2 and 3 are independent once Phase 1 is merged.

## 6.2 Workstream Breakdown

| Track                | Owner | Depends On                     | Deliverable                                                              |
| -------------------- | ----- | ------------------------------ | ------------------------------------------------------------------------ |
| A — package.json     | any   | —                              | `files` + `bin` updated; `npm pack` includes commands/ skills/ CLAUDE.md |
| B — bootstrap-global | any   | Track A                        | `bootstrap-global.mjs` + `dotbabel-bootstrap.mjs` + tests                |
| C — sync-global      | any   | Track B (uses bootstrapGlobal) | `sync-global.mjs` + `dotbabel-sync.mjs` + tests                          |
| D — wiring + docs    | any   | Tracks B + C                   | dispatcher, doctor, index.mjs exports, README, cli-reference             |

## 6.3 Prompt Sequence

### Prompt B1 — bootstrap-global.mjs (core logic)

```
Read first:
  - bootstrap.sh (full file — source of truth for the symlinking algorithm)
  - plugins/dotbabel/src/init-harness-scaffold.mjs (pattern for fs operations)
  - plugins/dotbabel/src/lib/output.mjs (createOutput interface)
  - plugins/dotbabel/src/lib/errors.mjs (ValidationError, ERROR_CODES)
  - plugins/dotbabel/src/lib/exit-codes.mjs

Write plugins/dotbabel/src/bootstrap-global.mjs implementing bootstrapGlobal(opts):
  - resolveSource: --source → DOTBABEL_DIR → pkgRoot() via import.meta.url
  - resolveTarget: opts.target ?? path.join(os.homedir(), '.claude')
  - linkOne(src, dst): matches bootstrap.sh behavior exactly:
      symlink pointing to src → ok
      symlink pointing elsewhere → rm + ln -s → updated
      real file/dir → mv to .bak-<ts> + ln -s → backed up + linked (out.warn)
      missing → ln -s → linked
  - bootstrapGlobal: link CLAUDE.md, commands/*.md, skills/*/, copy agents
  - return { ok, linked, skipped, backed_up }

TDD: write these failing tests first in
plugins/dotbabel/tests/bootstrap-global.test.mjs:
  - bootstrapGlobal creates symlinks in a temp target dir
  - bootstrapGlobal is idempotent (second run produces same state, no extra backups)
  - bootstrapGlobal backs up a real file before overwriting
  - bootstrapGlobal updates a stale symlink
  - bootstrapGlobal skips existing agent files
  - bootstrapGlobal returns { ok: false } when source is missing
  - resolveSource uses DOTBABEL_DIR when no --source given
  - resolveSource falls back to pkgRoot() when DOTBABEL_DIR is unset
```

### Prompt B2 — dotbabel-bootstrap.mjs bin

```
Read first:
  - plugins/dotbabel/bin/dotbabel-init.mjs (bin pattern to replicate)
  - plugins/dotbabel/src/lib/argv.mjs
  - plugins/dotbabel/src/bootstrap-global.mjs

Write plugins/dotbabel/bin/dotbabel-bootstrap.mjs:
  - META with name, synopsis, description, flags: source (string), target (string), quiet (boolean)
  - parse argv, handle --help/--version
  - call bootstrapGlobal, map result to exit codes
  - on win32 platform: out.fail with OPS-1 message, exit 2
```

### Prompt C1 — sync-global.mjs (core logic)

```
Read first:
  - sync.sh (full file — source of truth for pull/push/status logic)
  - plugins/dotbabel/src/bootstrap-global.mjs
  - plugins/dotbabel/src/lib/output.mjs
  - plugins/dotbabel/src/lib/errors.mjs

Write plugins/dotbabel/src/sync-global.mjs implementing syncGlobal(subcommand, opts):

  resolveMode(opts.source): 'clone' if source provided, else 'npm'

  pull (npm mode):
    1. spawnSync('npm', ['view', '@dotbabel/dotbabel', 'version'])
    2. if current === latest: out.info "already up to date (v<x>)"
    3. else: spawnSync('npm', ['update', '-g', '@dotbabel/dotbabel'])
    4. bootstrapGlobal(opts)

  pull (clone mode):
    1. spawnSync('git', ['-C', source, 'fetch', 'origin'])
    2. spawnSync('git', ['-C', source, 'rebase', 'origin/main'])
    3. bootstrapGlobal({ ...opts, source })

  status (npm mode):
    1. currentVer from version export
    2. latestVer from npm registry
    3. out.info lines

  status (clone mode):
    1. result = spawnSync('git', ['-C', source, 'status', '--short'])
    2. print stdout

  push (npm mode):
    out.fail "sync push is only available in clone mode"

  push (clone mode):
    Port SECRET_RX regex from sync.sh verbatim.
    1. secretScan(source) — check staged files via git show ":$file"
    2. git -C source add -A
    3. git -C source commit -m "dotbabel: sync <date>"
    4. git -C source push

TDD: write failing tests first in plugins/dotbabel/tests/sync-global.test.mjs:
  - syncGlobal pull (npm mode) calls npm update when newer version available
  - syncGlobal pull (npm mode) skips update when already up to date
  - syncGlobal pull (clone mode) runs git fetch + rebase then bootstraps
  - syncGlobal status (npm mode) emits current vs latest
  - syncGlobal status (clone mode) delegates to git status
  - syncGlobal push (npm mode) exits with fail message
  - syncGlobal resolveMode returns 'clone' when --source is set
  - syncGlobal resolveMode returns 'npm' when no source
```

### Prompt C2 — dotbabel-sync.mjs bin

```
Read first:
  - plugins/dotbabel/bin/dotbabel-init.mjs (bin pattern)
  - plugins/dotbabel/src/sync-global.mjs

Write plugins/dotbabel/bin/dotbabel-sync.mjs:
  - positional[0] is the subcommand: 'pull' | 'status' | 'push'
  - flags: source (string), quiet (boolean)
  - missing subcommand: print usage, exit 64
  - unknown subcommand: stderr + exit 64
  - delegate to syncGlobal, map exit codes
```

### Prompt D1 — wiring

```
Read first:
  - plugins/dotbabel/bin/dotbabel.mjs
  - plugins/dotbabel/src/index.mjs
  - plugins/dotbabel/bin/dotbabel-doctor.mjs
  - package.json

Four surgical edits:
  1. dotbabel.mjs: add 'bootstrap', 'sync' to SUBCOMMANDS array and help text
  2. index.mjs: add bootstrapGlobal export from bootstrap-global.mjs
               add syncGlobal export from sync-global.mjs
  3. package.json: add commands/, skills/, CLAUDE.md to files array
                   add dotbabel-bootstrap + dotbabel-sync to bin map
  4. dotbabel-doctor.mjs: add bootstrap check section (symlinks present + valid)
```

## 6.4 Testing Strategy

| Unit                     | UNIT                                               | INTEGRATION                                                                                            | POST-DEPLOY                                           |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `bootstrap-global.mjs`   | Symlink/backup/idempotency logic with temp dirs    | `npm pack` then `npm install` in a temp prefix; run `dotbabel bootstrap` and verify `~/.claude/` state | `dotbabel doctor` shows all ✓ after bootstrap         |
| `sync-global.mjs`        | resolveMode, secretScan regex, npm/git spawn stubs | Clone-mode pull against a local bare git repo                                                          | `dotbabel sync status` returns correct version string |
| `dotbabel-bootstrap.mjs` | `--help`, `--version`, win32 guard, exit codes     | Full bin invocation via `node bin/dotbabel-bootstrap.mjs`                                              | —                                                     |
| `dotbabel-sync.mjs`      | Unknown subcommand → exit 64                       | Full bin invocation                                                                                    | —                                                     |
| Dispatcher               | `bootstrap` + `sync` in SUBCOMMANDS                | `dotbabel bootstrap --help` exits 0                                                                    | —                                                     |

## 6.5 Migration Sequence

1. Add `commands/`, `skills/`, `CLAUDE.md` to `package.json` `files` (no behavior change; just ships more files in the tarball)
2. Add new src modules (no exports yet; safe to land early)
3. Export from `index.mjs` (additive; existing consumers unaffected)
4. Add new bins and update `package.json` `bin` map
5. Update dispatcher + doctor (last — requires bins to exist)
6. Bump minor version (`0.3.x → 0.4.0`) — new public exports + new bins = minor bump

All steps are additive. Nothing is renamed or removed.

## 6.6 Rollback Plan

| Scenario                                                     | Action                                                                                                          | Notes                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| bootstrap-global.mjs corrupts `~/.claude/`                   | Restore from `.bak-<timestamp>` files written by the tool itself                                                | ARCH-1 guarantees backups exist                             |
| npm mode symlinks break after `npm update -g`                | Re-run `dotbabel bootstrap`; links will be refreshed                                                            | Idempotent by design                                        |
| New bins cause regression in existing subcommands            | Revert the `dotbabel.mjs` SUBCOMMANDS change; new bins still ship but are not reachable via umbrella dispatcher | Dispatcher change is one-line; easy to revert independently |
| `package.json` `files` change causes unexpected tarball size | `npm pack --dry-run` to audit; revert the files entry                                                           | No code change required                                     |
