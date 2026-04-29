# `@dotclaude/dotclaude` — docs

_Last updated: v1.0.0_

dotclaude is an opinionated Claude Code toolkit shipped as a portable
npm package + Claude Code plugin. It curates a library of skills,
slash commands, and cloud/IaC specialists, hardens every Claude Code
session via a global rule floor, and adds an optional spec-driven-development
governance CLI on top — Node API, umbrella CLI, gold-standard shell
settings validator, and a destructive-git PreToolUse hook.

## Start here

| If you are…                                  | Read                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Setting up skills & commands in `~/.claude/` | [dotfile-quickstart.md](./dotfile-quickstart.md) — 30 seconds, no npm required     |
| A consumer evaluating the plugin             | [quickstart.md](./quickstart.md) — 5 minutes from install to first green validator |
| Integrating the library in CI                | [cli-reference.md](./cli-reference.md) and the `--json` payload examples           |
| Importing the Node API                       | [api-reference.md](./api-reference.md)                                             |
| Debugging a validator failure                | [troubleshooting.md](./troubleshooting.md) (indexed by `ERROR_CODES`)              |
| Upgrading or forking                         | [upgrade-guide.md](./upgrade-guide.md)                                             |
| Contributing                                 | [../CONTRIBUTING.md](../CONTRIBUTING.md)                                           |

## Deeper references

- [architecture.md](./architecture.md) — layer diagram + PR-time coverage check sequence
- [personas.md](./personas.md) — consumer vs dotfile user vs contributor entry-point matrix
- [handoff-guide.md](./handoff-guide.md) — cross-CLI, cross-machine session transfer (v0.5.0+)
- [adr/](./adr/) — architectural decision records (one per load-bearing decision)
- [specs/dotclaude-core/](./specs/dotclaude-core/) — the canonical spec this repo governs itself with

## What this package gives you

- **Structured-error contract.** Every validator emits `ValidationError`
  instances with stable `.code` values (see [troubleshooting.md](./troubleshooting.md)).
- **Umbrella CLI + standalone bins.** `dotclaude validate-specs` or
  `dotclaude-validate-specs` — both exist, same behavior.
- **Universal flags.** `--help`, `--version`, `--json`, `--verbose`,
  `--no-color` on every bin.
- **Named exit codes.** `{OK:0, VALIDATION:1, ENV:2, USAGE:64}` — `64`
  mirrors BSD `sysexits.h`.
- **Minimal runtime footprint.** Plain Node 20+, no bundler, no TypeScript
  runtime — three small JSON/YAML utility dependencies (ajv, ajv-formats, js-yaml).

## Governance

This package is itself a consumer of its own validators — see
[../CLAUDE.md](../CLAUDE.md) §Protected paths. Every PR touching a
protected path either carries `Spec ID: dotclaude-core` or a
`## No-spec rationale` section; `dogfood.yml` enforces this on every push.
