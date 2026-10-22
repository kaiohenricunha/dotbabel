# Host and platform capabilities — Phase 2-0 — 2026-10-16

## Method and meaning

This report separates a documented host hook from an implemented fleet adapter.
`supported` means dotbabel implements and tests that capability. `unsupported`
means dotbabel has no implementation. `unverified` means evidence is incomplete;
it never enables a feature. No new CLI or operating system was installed.

## Hosts

| Host        | identity    | liveness    | preEdit     | preBash     | postTool    | sessionStart | Evidence and implementation decision                                                                                                                                                                                                                                                                     |
| ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | supported   | supported   | supported   | supported   | supported   | supported    | `fleet/registry.mjs:31-179`, `fleet-guard.sh`, and fleet integration tests verify the existing session registry and hooks.                                                                                                                                                                               |
| Codex       | supported   | supported   | supported   | supported   | supported   | supported    | Verified 2026-10-21 with Codex CLI 0.163.0: hook `session_id` bound to the `codex` process above the hook (`fleet/registry.mjs` `findCodexSelf`); PreToolUse on `apply_patch` and `Bash`, PostToolUse, and SessionStart; a `deny` blocks the patch. Installed by `dotbabel fleet setup --harness codex`. |
| Gemini CLI  | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported  | [Hook reference](https://geminicli.com/docs/hooks/reference/) documents `session_id`, `BeforeTool`, and lifecycle hooks. The fleet has no tested identity/liveness registry or payload translator.                                                                                                       |
| Antigravity | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported  | [Hook reference](https://antigravity.google/docs/hooks) documents lifecycle hooks. No fleet process-incarnation backend is verified.                                                                                                                                                                     |
| OpenCode    | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported  | [Plugin reference](https://opencode.ai/docs/plugins/) documents tool and session events. Plugins need an explicit bridge to the fleet's command hooks and identity store.                                                                                                                                |
| Copilot CLI | unsupported | unsupported | unsupported | unsupported | unsupported | unsupported  | [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) documents tool and lifecycle hooks. No fleet identity, liveness, or payload bridge is tested.                                                                                                                            |

These states describe **dotbabel fleet support**, not whether the upstream CLI
has hooks. Upstream hook availability is verified for the linked documents;
process identity, PID reuse safety, and the integration are unverified for the
four unimplemented hosts. Codex was added on 2026-10-21 (see its row). A session UUID alone does not identify a live process.
Do not enable those hosts by copying the Claude registry lookup.

`host-adapter.mjs` is the capability boundary. The fleet bin selects the host
with `DOTBABEL_FLEET_HOST` (default `claude` for existing installations). An
unsupported host cannot identify itself or claim resources. Its hooks fail open.
Graph, decider, and export commands remain available on every host.

## Platforms

| Platform          | pin         | cpuShare    | Operational evidence                                                                                                                                       |
| ----------------- | ----------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux             | supported   | supported   | `fleet-lane.sh` uses `taskset` and `flock`; `cpushare.mjs` builds systemd user-scope CPUWeight operations. Existing lane/share tests cover their behavior. |
| macOS (`darwin`)  | unsupported | unsupported | No verified CPU affinity or group-share backend exists in this package. Linux commands must not run here.                                                  |
| Windows (`win32`) | unsupported | unsupported | No verified Windows affinity/job-object backend exists in this package. Linux commands must not run here.                                                  |

The Linux capability is conditional on the required installed commands and,
for CPU sharing, cgroup v2 and a systemd user manager. The existing shell lane
backend checks those conditions and passes commands through when unavailable.
[The Linux taskset manual](https://man7.org/linux/man-pages/man1/taskset.1.html)
describes its platform-specific CPU affinity operation.

`platform-adapter.mjs` supplies the capability table. Non-Linux systems run
commands directly, without the Linux lane script. The shell-prefix wrapper
also checks `uname` before it inspects or queues a heavy command. Doctor reports
the current platform, its states, and required tools. No macOS or Windows
execution was available; those backends remain explicitly unsupported.

## Verification and follow-up

The platform tests verify Linux descriptors and off behavior for macOS,
Windows, and unknown systems. Host registry tests verify supported and absent
adapters. Fleet token CLI tests exercise the selected Claude adapter through
real processes. Supporting another host requires a tested identity store,
process incarnation validation, translated tool payloads, and documented hook
installation. Supporting another platform requires a tested backend.

No capability depends on a default network request, and none starts a daemon.
