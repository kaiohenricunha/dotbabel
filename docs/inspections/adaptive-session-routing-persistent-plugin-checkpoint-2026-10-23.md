# Persistent Claude routing plugin: checkpoint

Status: the owner approved the design and the routing-spec paragraph on 2026-10-23 ("Approve and
build"; no real install on the owner's machine without a separate instruction). The spec paragraph
landed in #577. The transport slice (stdin `models route` verb, process transport, per-session catalog
cache) is the next pull request; the plugin package, install, status and host test remain.

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

## Answered questions (2026-10-23)

1. **The prompt travels on stdin.** `$.process.run(argv, init)` takes `init.stdin` ("Text written to
   the child's standard input, then closed") in the public Mods types
   (`anthropics/claude-code` `mods/types/claude-code.d.ts`, `ProcessRunInit`). That file is upstream
   `main`, not pinned to 2.1.309; the host test must confirm it on an accepted release.
2. **`$.session.id()`** returns the transcript name. The route command keys its cache with it.
3. **Measured cost (2.1.309, scratch projects, a loaded host).** A prompt in a project with routing
   off costs about 200-375 ms for the activation check. With routing on, the first turn of a session
   costs about 2-2.8 s (three zero-inference `claude` probes); later turns cost about 0.4 s from the
   owner-approved per-session catalog cache.

## Still open

- How `models status` detects `allowManagedModsOnly`, `disableAllHooks` and `allowManagedHooksOnly`
  to report `blocked_by_policy`.
- Whether the routing-off check can avoid the process start (for example, a cheaper activation probe),
  because it runs on every prompt in every project once the plugin is installed.

## Build steps

1. Done: shared `handleRoutingInput`, the stdin `models route` verb, the mod's process transport, the
   per-session catalog cache.
2. A plugin package (`.claude-plugin/plugin.json`, a local marketplace, the persistent module): no-op
   outside enabled projects, decision at `turn.start`, application at `turn.step` for MAIN requests
   only, an absolute `node` and `dotbabel-models.mjs` path in argv.
3. `enable|disable --routing --claude-plugin` against a scratch `CLAUDE_CONFIG_DIR`: install,
   idempotent re-install, uninstall, no other settings key changed, refusal without the `claude` CLI.
4. `models status`: the plugin state and `blocked_by_policy`.
5. Host test on an accepted release, then a real install only on the owner's word.
