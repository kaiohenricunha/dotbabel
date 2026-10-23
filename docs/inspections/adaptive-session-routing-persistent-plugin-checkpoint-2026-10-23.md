# Persistent Claude routing plugin: checkpoint

Status: the owner approved the design and the routing-spec paragraph on 2026-10-23 ("Approve and
build"; no real install on the owner's machine without a separate instruction). The spec paragraph
lands first. The implementation is **not started**.

## Documented facts (Claude Code docs, read 2026-10-23)

| Fact                                                                                                                                                                                                       | Source                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| A directory holding `.claude-plugin/marketplace.json` is a valid marketplace source                                                                                                                        | `plugins/install.md`                               |
| `claude plugin marketplace add <dir>`, then `claude plugin install <name>@<marketplace> --scope user`, both scriptable, `--json` available                                                                 | `plugins/cli-reference.md`                         |
| A user-scope install writes `enabledPlugins` in the user's Claude settings; adding a marketplace writes `extraKnownMarketplaces` and `~/.claude/plugins/known_marketplaces.json`                           | `plugins/install.md`, `plugins/loading.md`         |
| `claude plugin marketplace remove` uninstalls its plugins and removes their `enabledPlugins` entries                                                                                                       | `plugins/install.md`                               |
| Mods hooks run in `claude -p`                                                                                                                                                                              | `plugins/mods/overview.md`                         |
| A hook's own time limit is 10 s and excludes time inside a mods API call such as `$.process.run`; `$.process.run` times out at 30 s by default, 10 min at most, and takes an argument list without a shell | `plugins/mods/reference.md`, `plugins/mods/api.md` |
| `turn.step` fires once per model request; a turn with tool calls has several. Per-prompt work belongs in `turn.start`                                                                                      | `plugins/mods/events.md`                           |
| `allowManagedModsOnly` stops every user-installed mod; `disableAllHooks` and `allowManagedHooksOnly` also apply                                                                                            | `plugins/mods/admin.md`                            |
| A local directory plugin loads in place; changes apply at the next session start or after `/reload-plugins`                                                                                                | `plugins/loading.md`                               |

## Open questions to answer first

1. **How the prompt reaches the local command.** A command-line argument would show the prompt in
   the process list. Check whether `$.process.run` accepts standard input. The installed types are
   the authority, but `claude plugin validate` produced no `.d.ts`, and `claude plugin init` writes
   under `~/.claude/skills/`, which a grant forbids. A scratch `CLAUDE_CONFIG_DIR` may allow
   `init` safely.
2. **`$.session.root()`.** The mods reference lists it without a definition. The current module
   (`plugins/dotbabel/src/adaptive-session-routing/claude-mod-prepare.mjs`) already calls it; confirm
   its value in a host test.
3. **How to detect organization policy.** Decide how `models status` detects
   `allowManagedModsOnly` (managed settings file) to report `blocked_by_policy` truthfully.

## Build steps

1. Tests first, against a scratch `CLAUDE_CONFIG_DIR`: install, idempotent re-install, uninstall,
   no other key changed in the settings file, refusal when the `claude` CLI is missing.
2. A `dotbabel models` route command that takes one bounded request (activation, prompt, current
   axes) and returns the existing `prepareRoute` decision, with no socket.
3. A persistent module variant of `claude-mod.mjs`: no-op outside enabled projects, decision at
   `turn.start`, application at `turn.step` for MAIN requests only.
4. `enable|disable --routing --claude-plugin` and the `models status` integration state, including
   `blocked_by_policy`.
5. Host test, then a metadata proof in a scratch config; a real install only on the owner's word.
