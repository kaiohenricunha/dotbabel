# Model Intelligence

_Last updated: v4.2.0_

Model Intelligence is an optional project capability. Installation does not enable it. The current
activation interface stores project flags; resolver and adaptive runtime integrations are separate
implementation work. An enabled routing preference alone does not prove a runtime is routing prompts.

## Project activation

Run these commands from the selected project, or pass `--repo-root <project>`:

```bash
dotbabel models enable
dotbabel models enable --routing
dotbabel models status --json
dotbabel models disable --routing
dotbabel models disable
```

The engine and routing require independent explicit flags in `.dotbabel.json`:

```json
{
  "model_intelligence": {
    "enabled": true,
    "adaptive_routing": { "enabled": true }
  }
}
```

`enabled` defaults to false. `routingRequested` reports the independent routing flag.
`routingEnabled` reports effective project permission: both flags are true. It does not assert that
an integration is installed, supported, or active. Runtime mechanism and effective configuration must
be verified independently. No automatic per-prompt routing ships in the activation unit.

Disabling the engine preserves the routing preference and makes it ineffective. Disabling routing
preserves the engine's enabled flag. Both operations retain policy, agent configurations and unrelated files.
They do not alter global Claude Code or Codex settings. Parallel projects read their own flags.

Explicit `models refresh`, `status` and migration analysis remain available when disabled. Status
never refreshes. Refresh can access runtime/provider metadata only when explicitly requested; it does
not enable the project. Existing dotbabel operations and native per-agent model configuration retain
their behavior while the feature is disabled.

## Runtime availability

The [adaptive routing spec](specs/adaptive-session-routing/README.md) defines the planned runtime
integrations. Candidate mechanisms are Claude mods and Codex App Server `turn/start`. The stock Codex
interactive CLI has no verified transparent interception mechanism in this work. A future managed
App Server client must be identified as a separate execution mode.

The activation commands currently change only the project flags. They do not install or reload a
runtime integration. Any later adapter must document its startup/reload requirements. Do not expect
an existing session to route prompts merely because the flags changed.

## Troubleshooting and rollback

A malformed configuration produces `invalid_project_config`, exit 1, without echoing its contents.
A symbolic link, non-file or oversized configuration produces `project_config_unavailable`, exit 2.
Configuration mutation refuses these paths before replacement. Concurrent writers serialize under a
project configuration lock. Persistent contention produces `project_config_locked`; investigate the
owner before removing any lock. Age alone does not prove the owner is dead.

Use `--json` for stable machine output. Activation output has envelope `ModelsActivation`, version 1,
and an `activation` object. Status retains envelope `ModelsStatus` and adds the same object. Failures
carry `diagnostics[].code`.

To roll back, disable routing and then disable the engine with the commands above. No global files
or unrelated artifacts need removal. Keep explicit pins and mandatory safety floors in their existing
configuration; activation does not weaken them.
