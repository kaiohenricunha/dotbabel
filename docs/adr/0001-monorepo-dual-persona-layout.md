# ADR-0001 — Monorepo dual-persona layout

**Status**: Accepted (2026-04-14)

## Context

The work Kaio needs this repo to do splits into two distinct audiences:

1. **Personal dotfiles** — `commands/`, `skills/`, `CLAUDE.md`, bootstrapped
   into `~/.claude/` via `bootstrap.sh`.
2. **`@kaiohenricunha/harness` npm package** — a reusable plugin other repos
   install via `npm i -D`. Lives under `plugins/harness/`.

The overlap is large: both surfaces define slash commands, skills, hooks,
and CI workflows. Keeping two repos in sync by copy-paste was the status
quo; drift appeared within days.

## Decision

Single repo. Two top-level trees:

```
dotclaude/
├─ commands/  skills/  CLAUDE.md  bootstrap.sh  sync.sh    ← dotfile persona
└─ plugins/harness/                                         ← npm package
```

`package.json.files` excludes the dotfile-only paths from the npm tarball.
Consumers installing the package see only `plugins/harness/`. The author's
`bootstrap.sh` symlinks from `commands/` and `skills/` into `~/.claude/`.

## Consequences

- One source of truth for every slash command and skill that both personas
  want to share.
- Single CI pipeline covers both surfaces; dogfood runs every harness
  validator against the repo itself.
- Contributors see two trees and need the [personas.md](../personas.md)
  matrix to pick their entry-point — added cognitive cost.
- `package.json.files` becomes a trust boundary: a missing entry there
  silently ships dotfile scripts into consumer installs. Covered by an
  integration test that asserts `plugins/harness/scripts/*` _is_ shipped
  and `bootstrap.sh` _is not_.

## Alternatives considered

- **Two repos, cross-repo sync action** — rejected. The sync action itself
  becomes a load-bearing dependency; every failure mode is a drift between
  the two repos. Net complexity is higher.
- **Separate the dotfiles to a second repo, keep the package here** —
  viable. Rejected for now because the author's friction cost of mirroring
  changes across two repos is real and unamortized until the dotfile side
  has third-party contributors (currently it has one, Kaio).
- **Move the npm package to its own repo, dotfiles stay here** — same
  objection, inverted.

## Revisit triggers

- The first external contributor to the dotfile tree (implies a third
  audience, strengthens the split-repo case).
- The first consumer requesting a tighter tarball that excludes
  `plugins/harness/tests/`.
