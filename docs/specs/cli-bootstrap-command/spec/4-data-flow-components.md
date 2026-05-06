# §4 — Data Flow / Components

> Current state analysis + target architecture.

## Current State

Bootstrap flow today:

```
Developer
  │
  ├─ clone dotbabel repo
  ├─ cd ~/projects/dotbabel
  └─ ./bootstrap.sh
       ├─ symlink CLAUDE.md → ~/.claude/CLAUDE.md
       ├─ symlink commands/*.md → ~/.claude/commands/
       ├─ symlink skills/*/ → ~/.claude/skills/
       └─ copy agents templates → ~/.claude/agents/

Sync flow today:
  └─ ./sync.sh pull
       ├─ git fetch origin
       ├─ git rebase origin/main
       └─ ./bootstrap.sh   (re-run)
```

Both flows require the developer to be inside the dotbabel clone directory.
The npm CLI has no awareness of these operations.

## Component Boundaries

| Component                 | File   | Responsibility                                                           |
| ------------------------- | ------ | ------------------------------------------------------------------------ |
| `dotbabel-bootstrap.mjs` | `bin/` | CLI entry-point: arg parsing, help text, exit codes                      |
| `dotbabel-sync.mjs`      | `bin/` | CLI entry-point for `sync <subcommand>`; routes to sync-global           |
| `bootstrap-global.mjs`    | `src/` | Core symlinking logic: source resolution, backup, link-one, agents copy  |
| `sync-global.mjs`         | `src/` | Pull (npm update / git rebase) + status + push; delegates bootstrap step |
| `dotbabel.mjs`           | `bin/` | Umbrella dispatcher; adds `bootstrap` + `sync` to SUBCOMMANDS            |
| `dotbabel-doctor.mjs`    | `bin/` | Existing diagnostic; extended to check bootstrap state                   |

## Shared State

- `~/.claude/` — written by bootstrap, read by doctor. No locking needed;
  the CLI is not designed for concurrent invocations.
- `DOTBABEL_DIR` environment variable — read by both `bootstrap-global.mjs`
  and `sync-global.mjs` to locate the clone in clone mode.

## Target Architecture

### bootstrap-global.mjs

```
bootstrapGlobal(opts)
  opts: { source?, target?, quiet?, json?, noColor? }

1. resolveSource(opts.source)
   └─ --source → DOTBABEL_DIR → pkgRoot()     [ARCH-2]
2. resolveTarget(opts.target)
   └─ opts.target ?? $HOME/.claude
3. mkdir -p target
4. linkOne(source/CLAUDE.md, target/CLAUDE.md)
5. for f in source/commands/*.md:
     linkOne(f, target/commands/<name>)
6. for d in source/skills/*/:
     linkOne(d, target/skills/<name>)
7. for f in source/plugins/dotbabel/templates/claude/agents/*.md:
     copyAgent(f, target/agents/<name>)   ← skip if exists [KD-1]
8. out.pass/fail/warn per step            [ARCH-1]

linkOne(src, dst):
  if dst is symlink pointing to src → out.pass "ok"
  if dst is symlink pointing elsewhere → rm + ln -s + out.pass "updated"
  if dst is real file/dir → mv to dst.bak-<ts> + ln -s + out.warn "backed up"
  else → ln -s + out.pass "linked"
```

### sync-global.mjs

```
syncGlobal(subcommand, opts)
  subcommand: 'pull' | 'status' | 'push'
  opts: { source?, quiet?, json?, noColor? }

mode = resolveMode(opts.source)   ← 'npm' | 'clone'

pull (npm mode):
  1. npm view @dotbabel/dotbabel version → latestVer
  2. if latestVer === currentVer → out.info "already up to date"
  3. else: spawnSync('npm', ['update', '-g', '@dotbabel/dotbabel'])
  4. bootstrapGlobal(opts)

pull (clone mode):
  1. spawnSync('git', ['-C', source, 'fetch', 'origin'])
  2. spawnSync('git', ['-C', source, 'rebase', 'origin/main'])
  3. bootstrapGlobal({ ...opts, source })

status (npm mode):
  1. currentVer = version (from index.mjs)
  2. latestVer = npm view @dotbabel/dotbabel version
  3. out.info "installed: <currentVer>  latest: <latestVer>"

status (clone mode):
  1. spawnSync('git', ['-C', source, 'status', '--short'])

push (clone mode only):
  1. secretScan(source)   [KD-2]
  2. git add -A
  3. git commit -m "dotbabel: sync <date>"
  4. git push
push (npm mode): out.fail "sync push is only available in clone mode (--source)"
```

### Key Decisions

KD-1: Agents are **copied** (not symlinked) to `~/.claude/agents/` and skipped
if already present. This mirrors the existing `bootstrap.sh` behavior and
allows developers to customise their local agent files without having changes
overwritten on re-bootstrap.

KD-2: `sync push` secret-scanning uses the same regex logic from `sync.sh`
but reimplemented in Node so the bin is cross-platform (no bash dependency).
The regex is lifted verbatim into `sync-global.mjs`.

KD-3: In npm mode, symlinks point to the npm package's install directory
(resolved via `pkgRoot()` which walks up from `import.meta.url`). After
`npm update -g`, npm replaces the package directory contents, so all symlinks
automatically reflect the new version without needing to re-run bootstrap.
