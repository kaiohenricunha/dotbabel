# Upgrade guide

_Last updated: v1.3.0_

## 0.1.x → 0.2.0

`0.1.x` was never published to npm — it was the local development skeleton.
The first public release is `0.2.0`. If you're starting
from a checked-out development copy of `0.1.x`, the migration surface is:

### Breaking

- **Errors are `ValidationError`, not strings.** Pipelines that ran
  `errors.some((e) => /regex/.test(e))` continue to work because
  `ValidationError.prototype.toString()` preserves the
  `"<file>: <message>"` format. If you programmatically accessed
  `result.errors[0]` as a raw string, migrate to `.code` + `.message`:

  ```js
  // before
  if (result.errors[0].startsWith("docs/specs/foo: invalid status")) …

  // after
  if (result.errors[0].code === ERROR_CODES.SPEC_STATUS_INVALID) …
  ```

- **Deep imports are no longer a supported contract.** Rewrite:

  ```js
  // before
  import { validateSpecs } from "@dotclaude/dotclaude/plugins/dotclaude/src/validate-specs.mjs";

  // after
  import { validateSpecs } from "@dotclaude/dotclaude";
  ```

  The subpath exports `./errors` and `./exit-codes` are supported; any
  other deep path may move without notice.

- **Exit codes** moved to the named `EXIT_CODES` enum. If you wrote
  `process.exit(1)` in a wrapper, keep using `1`; if you scripted against
  "any non-zero", you're fine. `64` (`USAGE`) is new — treat it distinctly
  from `1` (`VALIDATION`).

### New capabilities

- `--help`, `--version`, `--json`, `--verbose`, `--no-color` on every bin.
- Umbrella `dotclaude` CLI and `dotclaude-doctor` self-diagnostic.
- `validate-settings.sh --json` structured output.
- Hardened `guard-destructive-git.sh` with `BYPASS_DESTRUCTIVE_GIT=1` bypass.
- `bootstrap.sh --quiet`, `sync.sh` secret scan on push.

## Forking the dotfiles

If you want to fork the repo to keep your _own_ personal Claude Code
config, the key files to edit are:

- `commands/**/*.md` — your slash commands.
- `skills/**/SKILL.md` — your skills.
- `CLAUDE.md` — your global rules.

Run `./bootstrap.sh` after the fork to symlink them into `~/.claude/`.

The plugin surface (`plugins/dotclaude/**`) should remain a strict upstream
of the canonical `dotclaude` repo — pull changes from upstream rather than
forking divergent plugin code.

## Migrating a hand-written `.claude/` tree

If you already maintain a hand-written `.claude/` tree in a consumer repo
and want to start using dotclaude:

1. **Inventory what you have.** `npx dotclaude-validate-skills --update`
   from an empty manifest will seed the checksums; you then have to choose
   between treating each existing file as indexed (keep the entry) or
   removed (delete it + rerun `--update`).
2. **Draft `docs/repo-facts.json`** with your `team_count`,
   `protected_paths`, and `instruction_files`.
3. **Draft at least one spec** (`docs/specs/<id>/spec.json`). It can be
   `status: draft` initially — gating only kicks in at
   `approved|implementing|done`.
4. Run `npx dotclaude-doctor` and iterate on every `✗` it reports.
5. Wire the three shipped workflows into `.github/workflows/`.

## Running `v0.2.0` in CI without a published npm

Until `release.yml` lands (PR 7), consumers can point `package.json` at a
git commit:

```json
"devDependencies": {
  "@dotclaude/dotclaude": "github:kaiohenricunha/dotclaude#v0.2.0"
}
```

Swap to the published version once `npm view @dotclaude/dotclaude@0.2.0`
returns a hit.
