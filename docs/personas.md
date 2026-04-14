# Personas — who reads which file

This repo is a dual-purpose checkout. Three distinct audiences consume
parts of it. Pick yours, then follow the "Start here" column.

| Persona                                                           | What you want                                              | Start here                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Consumer** — installing the plugin to govern your own repo      | Install, scaffold, run validators, wire CI                 | [quickstart.md](./quickstart.md) → [cli-reference.md](./cli-reference.md) |
| **Library user** — importing the Node API into your own tooling   | Import, typed signatures, error codes                      | [api-reference.md](./api-reference.md)                                    |
| **Dotfile user** — personal Claude Code config via `bootstrap.sh` | Symlink into `~/.claude/`, manage your own commands/skills | [../CLAUDE.md](../CLAUDE.md) + [../bootstrap.sh](../bootstrap.sh)         |
| **Contributor** — sending PRs to this repo                        | Dev workflow, local gates, spec discipline                 | [../CONTRIBUTING.md](../CONTRIBUTING.md)                                  |
| **Security researcher**                                           | Private disclosure, threat model                           | [../SECURITY.md](../SECURITY.md)                                          |

## Where the split happens

| Path                                                                   | Who consumes it                          |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| `package.json`, `plugins/dotclaude/src/**`, `plugins/dotclaude/bin/**` | Consumer + library user                  |
| `plugins/dotclaude/templates/**`                                       | Consumer (installed by `dotclaude-init`) |
| `plugins/dotclaude/.claude-plugin/plugin.json`                         | Claude Code when the plugin is enabled   |
| `bootstrap.sh`, `sync.sh`, `commands/**`, `skills/**`                  | Dotfile user                             |
| `CLAUDE.md`, `docs/specs/dotclaude-core/**`, `.claude/**` at repo root | Contributors + the dogfood CI            |
| `docs/**` (excluding `specs/dotclaude-core/`)                          | All of the above                         |

## Why the dual-purpose layout

ADR-0001 records the decision. Short version: the dotfiles and the plugin
cover the same surface area (Claude Code commands/skills/hooks), the
author wants a single source of truth, and npm install ignores the
dotfile-specific top-level scripts (`bootstrap.sh`, `sync.sh`, `commands/`,
`skills/`) via `package.json.files`.

If the dotfile side feels like noise when you're only consuming the npm
package: **it is.** Install via `npm i -D @dotclaude/dotclaude` and you
never see `bootstrap.sh` — only `node_modules/.../plugins/dotclaude/`.
