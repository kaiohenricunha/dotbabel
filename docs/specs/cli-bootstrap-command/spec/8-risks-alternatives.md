# §8 — Risks and Alternatives

> Known risks with mitigations, rejected approaches with reasoning.

## Risks

| ID  | Risk                                                                                                                                                  | Likelihood | Impact | Mitigation                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | npm global install directory varies by platform (nvm, volta, brew, system node) — `pkgRoot()` via `import.meta.url` may resolve to an unexpected path | Medium     | Medium | Log the resolved source path on every bootstrap run so users can verify it. Document the resolution algorithm in `--help`.                                                  |
| R-2 | `npm update -g` in `sync pull` updates ALL globally installed packages, not just `@dotclaude/dotclaude`                                               | Low        | Low    | Use `npm update -g @dotclaude/dotclaude` (package-scoped) not `npm update -g` bare.                                                                                         |
| R-3 | Adding `commands/` and `skills/` to the npm tarball significantly increases package size                                                              | Low        | Low    | `npm pack --dry-run` before publishing; current skills/commands total ~200 KB. Acceptable.                                                                                  |
| R-4 | `bootstrap.sh` and `dotclaude bootstrap` diverge over time — someone updates one but not the other                                                    | Medium     | Medium | Add a note in `bootstrap.sh` referencing the CLI equivalent. The integration test for bootstrap-global.mjs runs against the same expected outputs as the bootstrap.sh test. |
| R-5 | Symlinking the npm package directory into `~/.claude/` means updating the package breaks the symlinks briefly during the npm update window            | Low        | Low    | npm replaces package contents atomically (via rename); symlinks remain valid throughout.                                                                                    |

## Rejected Alternatives

A-1: **Ship only a wrapper that calls `bootstrap.sh`** — have `dotclaude bootstrap`
`exec` the shell script from the npm package directory. Rejected because it
requires bash, breaks on Windows (OPS-1), and ties the npm package's behavior
to a shell script rather than the tested JS module system. It would also make
the Node API (`bootstrapGlobal`) impossible to implement without shelling out.

A-2: **Clone dotclaude from GitHub if no local clone is detected** — have
`dotclaude bootstrap` run `git clone` in npm mode to create a local clone in
`~/.dotclaude/` and then symlink from there. Rejected because it introduces
an unconditional network call at bootstrap time, adds complexity (what if the
clone already exists? what version to clone?), and the npm package already
ships the right files. The npm install is the natural distribution channel.

A-3: **Copy files instead of symlink in npm mode** — skip symlinks entirely
and just copy `commands/`, `skills/`, `CLAUDE.md` into `~/.claude/`. Rejected
because copies drift silently — after `npm update -g`, the files in `~/.claude/`
would be stale until the user manually re-runs bootstrap. Symlinks (KD-3)
make the update atomic: the npm update replaces the package dir contents, and
all symlinks immediately reflect the new version.

A-4: **Use a `dotclaude setup` name instead of `dotclaude bootstrap`** —
more general naming. Rejected because `bootstrap` is already the established
term in the README, `bootstrap.sh`, and onboarding docs. Consistent naming
reduces confusion; new devs who know `./bootstrap.sh` will find `dotclaude bootstrap`
immediately intuitive.

A-5: **Merge `sync` into `bootstrap` as flags** — `dotclaude bootstrap --pull`
to update before symlinking. Rejected because pull and bootstrap are distinct
operations with different failure modes and different exit semantics. Keeping
them as separate subcommands follows the existing pattern (each subcommand has
a single responsibility) and makes error attribution unambiguous.
