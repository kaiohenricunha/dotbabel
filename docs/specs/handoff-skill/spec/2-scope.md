# §2 — Scope

> What's in, what's out, and where are the boundaries?

## In Scope

- **Public surface redesign.** Replace the current five-form / eleven-sub-command sprawl with a two-job surface (cross-agent + cross-machine) and demote supporting commands.
- **Source-CLI auto-detection.** For query-based flows, the binary determines source from the path it resolves; users do not pass a `--from`-equivalent. For `push` without a `<query>`, `--from` is required.
- **Target-CLI implicit handling.** The target is "wherever the user pastes" — the user is never asked to declare it. The `--to` flag and the per-target Next-step text branching get removed.
- **Push / pull contract for the GitHub-repo transport.** Lock the branch-naming, scrubbing, metadata, and pull-resolution semantics so they stop changing PR-to-PR.
- **Supporting-command surface.** Define how `search`, `describe`, `list`, `file`, `digest`, `resolve`, `remote-list`, `doctor` are reachable without competing for primary attention. Some may be removed entirely if they don't feed a primary job.
- **Documentation reconciliation.** Bring `skills/handoff/SKILL.md`,
  `skills/handoff/references/*.md`, the binary `--help` text, and
  `docs/handoff-guide.md` into agreement with the implementation. Drift fixes
  ship in this spec's PRs, not separately.
- **Test surface alignment.** Update `plugins/dotbabel/tests/bats/*.bats` and
  vitest suites to cover the new public surface; remove tests for removed
  flags/forms.

## Out of Scope

- **New agents.** Claude Code, GitHub Copilot CLI, OpenAI Codex CLI only. Cursor, Aider, Continue, etc. are not added.
- **New transports.** Git repo (named by `$DOTBABEL_HANDOFF_REPO`) is the
  only remote transport. The previously-removed gist transports
  (`--via github`, `--via gist-token`) do not return.
- **End-to-end encryption.** Content stays plaintext in a private repo; the
  existing best-effort scrubber stays. New scrub patterns out of scope.
- **Auto-injecting the digest into the target agent.** The skill prints; the
  user pastes. Stays manual by design (see `skills/handoff/SKILL.md`'s
  `## Out of scope` section).
- **Session-file reader internals.** The per-CLI `jq` filters in
  `plugins/dotbabel/scripts/handoff-extract.sh` and the resolver logic in
  `plugins/dotbabel/scripts/handoff-resolve.sh` keep their current
  semantics. Their **public CLI interface** may move, but the substrate that
  understands each CLI's transcript format is not redesigned.
- **The `dotbabel` plugin packaging / distribution model.** How the binary
  ships (`@dotbabel/dotbabel` npm package, `bootstrap.sh` symlink path)
  is unchanged. The skill's binary entrypoint is the only thing that
  evolves.

## Boundaries

| Touches                                                  | Does Not Touch                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `skills/handoff/SKILL.md`                                | Other skill SKILL.md files                                         |
| `skills/handoff/references/*.md`                         | Skills outside `skills/handoff/`                                   |
| `plugins/dotbabel/bin/dotbabel-handoff.mjs`              | Other `plugins/dotbabel/bin/*.mjs` entrypoints                     |
| `plugins/dotbabel/src/lib/handoff-remote.mjs`            | `plugins/dotbabel/src/lib/argv.mjs`, `exit-codes.mjs`              |
| `plugins/dotbabel/src/lib/handoff-scrub.mjs`             | Scrub patterns in `plugins/dotbabel/scripts/handoff-scrub.sh`      |
| `plugins/dotbabel/scripts/handoff-doctor.sh`             | `handoff-extract.sh` (substrate, frozen)                           |
| `plugins/dotbabel/scripts/handoff-description.sh`        | `handoff-resolve.sh` internals (substrate, frozen)                 |
| `plugins/dotbabel/tests/bats/handoff-*.bats`             | `plugins/dotbabel/tests/bats/dotbabel-*.bats` for non-handoff bins |
| `plugins/dotbabel/tests/handoff-*.test.mjs`              | Other vitest suites in `plugins/dotbabel/tests/`                   |
| `docs/handoff-guide.md`                                  | Other `docs/*.md` files                                            |
| `docs/specs/handoff-skill/spec.json` (added at finalize) | Other `docs/specs/*/spec.json` files                               |

## Urgency

No hard external deadline. Internal urgency is the patch-loop tax: every PR
that touches the handoff surface without a spec to anchor against compounds
the drift. The longer this stays unspec'd, the more rework future PRs cost.
Treat as "next-up after the current in-flight PRs (#91 Gap variants) land."
