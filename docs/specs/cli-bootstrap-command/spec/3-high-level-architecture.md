# §3 — High-Level Architecture

> System view: components, data stores, external dependencies, deployment.

## System Overview

The feature adds a "global config layer" to the CLI. Today the CLI only
operates on a per-repo target directory; the new commands operate on the
developer's home directory (`~/.claude/`).

```
Developer machine
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  dotclaude bootstrap / sync                             │
│         │                                               │
│         ▼                                               │
│  bootstrap-global.mjs ◄── source resolver               │
│         │                  ├─ npm mode:                 │
│         │                  │   import.meta.url → pkg    │
│         │                  │   root → commands/ skills/ │
│         │                  └─ clone mode:               │
│         │                      DOTCLAUDE_DIR / --source │
│         │                                               │
│         ▼                                               │
│  ~/.claude/                                             │
│    ├── CLAUDE.md          ← symlink                     │
│    ├── commands/*.md      ← symlinks                    │
│    ├── skills/*/          ← symlinks                    │
│    └── agents/*.md        ← copies (skip if exists)     │
│                                                         │
│  sync-global.mjs                                        │
│    ├── npm mode:  npm update -g → bootstrap             │
│    └── clone mode: git fetch/rebase → bootstrap         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

ARCH-1: All writes are idempotent. Re-running `dotclaude bootstrap` on an
already-bootstrapped machine must produce the same state without data loss.
Existing symlinks are updated if they point elsewhere; real files are backed
up with a `.bak-<timestamp>` suffix before overwriting (identical to
`bootstrap.sh` behavior).

ARCH-2: Source resolution is deterministic and explicit. The resolution order
is: `--source` flag → `DOTCLAUDE_DIR` env var → npm package root (derived
from `import.meta.url`). No silent fallbacks.

ARCH-3: The two modes (npm / clone) share the same `bootstrap-global.mjs`
logic. Only the source path resolution differs; the symlinking operations are
identical.

## Data Stores

| Store                                      | Role                                               | Access Pattern                                   |
| ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------ |
| `~/.claude/`                               | Target directory for symlinks                      | Read on status checks; write on bootstrap        |
| npm global registry (`registry.npmjs.org`) | Version check + update for `sync pull` in npm mode | Read-only HTTP GET; only on explicit `sync pull` |
| git remote (`origin`)                      | Source of truth for clone mode `sync pull`         | Read-only fetch + rebase on explicit `sync pull` |

## External APIs / Dependencies

| Service              | Purpose                                                                                     | Rate Limits / Constraints                                                              |
| -------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `registry.npmjs.org` | `npm view @dotclaude/dotclaude version` for `sync status` + `npm update -g` for `sync pull` | npm rate-limits unauthenticated fetches to ~1 req/sec; trivial for interactive CLI use |
| `git` binary         | Clone-mode `sync pull` / `push` / `status`                                                  | Must be present in PATH; absence is an ENV error (exit 2)                              |
| `npm` binary         | npm-mode `sync pull`                                                                        | Must be present in PATH; absence is an ENV error (exit 2)                              |

## Deployment

Shipped as part of the `@dotclaude/dotclaude` npm package. No additional
infrastructure. The two new source files are bundled in the same package;
`commands/`, `skills/`, and `CLAUDE.md` are added to the `files` array so
they are included in the published tarball.
