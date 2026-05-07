# Upgrade guide

_Last updated: v2.1.0_

## 1.x → 2.0.0 — project renamed `dotclaude` → `dotbabel`

Strategic rebrand to position the toolkit as model-agnostic. **Every reference to `dotclaude` in your install is renamed to `dotbabel`.** A read-fallback compatibility layer keeps v1 setups working through the 2.x release window; all compat shims are removed in 3.0.0.

### What changed

| Surface      | v1.x                                             | v2.0.0                              |
| ------------ | ------------------------------------------------ | ----------------------------------- |
| npm package  | `@dotclaude/dotclaude`                           | `@dotbabel/dotbabel`                |
| CLI binaries | `dotclaude`, `dotclaude-bootstrap`, … (15 total) | `dotbabel`, `dotbabel-bootstrap`, … |
| Config dir   | `~/.config/dotclaude/`                           | `~/.config/dotbabel/`               |
| Cache dir    | `~/.cache/dotclaude/`                            | `~/.cache/dotbabel/`                |
| Schema host  | `https://dotclaude.dev/schemas/*`                | `https://dotbabel.dev/schemas/*`    |
| Source dir   | `plugins/dotclaude/`                             | `plugins/dotbabel/`                 |
| Spec IDs     | `dotclaude-core`, `dotclaude-agents`             | `dotbabel-core`, `dotbabel-agents`  |

### Env var mapping (12 vars)

| Legacy (deprecated)        | Canonical                 |
| -------------------------- | ------------------------- |
| `DOTCLAUDE_HANDOFF_REPO`   | `DOTBABEL_HANDOFF_REPO`   |
| `DOTCLAUDE_DIR`            | `DOTBABEL_DIR`            |
| `DOTCLAUDE_DEBUG`          | `DOTBABEL_DEBUG`          |
| `DOTCLAUDE_QUIET`          | `DOTBABEL_QUIET`          |
| `DOTCLAUDE_REPO_ROOT`      | `DOTBABEL_REPO_ROOT`      |
| `DOTCLAUDE_JSON`           | `DOTBABEL_JSON`           |
| `DOTCLAUDE_DOCTOR_SH`      | `DOTBABEL_DOCTOR_SH`      |
| `DOTCLAUDE_JSON_BUFFER`    | `DOTBABEL_JSON_BUFFER`    |
| `DOTCLAUDE_VERSION`        | `DOTBABEL_VERSION`        |
| `DOTCLAUDE_SKIP_BOOTSTRAP` | `DOTBABEL_SKIP_BOOTSTRAP` |
| `DOTCLAUDE_HANDOFF_DEBUG`  | `DOTBABEL_HANDOFF_DEBUG`  |

### Compatibility window (2.x only)

For one release window, dotbabel reads the legacy paths and env vars when canonical ones are absent and emits a one-time deprecation warning per process:

- **Config / cache:** if `~/.config/dotbabel/` is missing AND `~/.config/dotclaude/` exists, the legacy path is used and a `DOTBABEL_LEGACY_CONFIG` (or `_CACHE`) `process.emitWarning` fires once.
- **Env vars:** `DOTBABEL_<NAME>` wins; if unset, `DOTCLAUDE_<NAME>` is honored with a `DOTBABEL_LEGACY_ENV` warning naming the variable.

**All writes target canonical only.** A v2 dotbabel will never modify your existing `~/.config/dotclaude/` files; it writes new state to `~/.config/dotbabel/`.

### Migration steps

1. **npm install:** `npm install -g @dotbabel/dotbabel` (this also handles uninstalling the old `@dotclaude/dotclaude`).
2. **Re-bootstrap:** `dotbabel bootstrap` to point `~/.claude/` symlinks at `plugins/dotbabel/`.
3. **Rename your env vars** in shell rc files: `DOTCLAUDE_*` → `DOTBABEL_*`. Compat fallbacks keep things working in the meantime, but the warnings will fire on every process invocation.
4. **(Optional) move config:** `mv ~/.config/dotclaude ~/.config/dotbabel` if you want to silence `DOTBABEL_LEGACY_CONFIG`.
5. **CI workflows / wrapper scripts:** find/replace `dotclaude-` → `dotbabel-` and `@dotclaude/dotclaude` → `@dotbabel/dotbabel`.

### Compat removal in 3.0.0

The `legacy-compat` helper, the env-var fallback chain, and the legacy-path reads are all removed in 3.0.0. Migrate before then to avoid breakage.

---

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
  import { validateSpecs } from "@dotbabel/dotbabel/plugins/dotbabel/src/validate-specs.mjs";

  // after
  import { validateSpecs } from "@dotbabel/dotbabel";
  ```

  The subpath exports `./errors` and `./exit-codes` are supported; any
  other deep path may move without notice.

- **Exit codes** moved to the named `EXIT_CODES` enum. If you wrote
  `process.exit(1)` in a wrapper, keep using `1`; if you scripted against
  "any non-zero", you're fine. `64` (`USAGE`) is new — treat it distinctly
  from `1` (`VALIDATION`).

### New capabilities

- `--help`, `--version`, `--json`, `--verbose`, `--no-color` on every bin.
- Umbrella `dotbabel` CLI and `dotbabel-doctor` self-diagnostic.
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

The plugin surface (`plugins/dotbabel/**`) should remain a strict upstream
of the canonical `dotbabel` repo — pull changes from upstream rather than
forking divergent plugin code.

## Migrating a hand-written `.claude/` tree

If you already maintain a hand-written `.claude/` tree in a consumer repo
and want to start using dotbabel:

1. **Inventory what you have.** `npx dotbabel-validate-skills --update`
   from an empty manifest will seed the checksums; you then have to choose
   between treating each existing file as indexed (keep the entry) or
   removed (delete it + rerun `--update`).
2. **Draft `docs/repo-facts.json`** with your `team_count`,
   `protected_paths`, and `instruction_files`.
3. **Draft at least one spec** (`docs/specs/<id>/spec.json`). It can be
   `status: draft` initially — gating only kicks in at
   `approved|implementing|done`.
4. Run `npx dotbabel-doctor` and iterate on every `✗` it reports.
5. Wire the three shipped workflows into `.github/workflows/`.

## Running `v0.2.0` in CI without a published npm

Until `release.yml` lands (PR 7), consumers can point `package.json` at a
git commit:

```json
"devDependencies": {
  "@dotbabel/dotbabel": "github:kaiohenricunha/dotbabel#v0.2.0"
}
```

Swap to the published version once `npm view @dotbabel/dotbabel@0.2.0`
returns a hit.
