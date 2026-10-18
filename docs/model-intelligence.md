# Model Intelligence

_Last updated: v4.2.0_

Model Intelligence is an optional project capability. Installation does not enable it. The current
activation interface stores project flags. Explicit resolution uses cached capability evidence;
adaptive runtime integrations remain separate implementation work. An enabled routing preference alone does not prove a runtime is routing prompts.

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

Explicit `models refresh`, `status`, `resolve` and migration analysis remain available when disabled. Status
never refreshes. Refresh can access runtime/provider metadata only when explicitly requested; it does
not enable the project. Existing dotbabel operations and native per-agent model configuration retain
their behavior while the feature is disabled.

## Read-only resolution

Resolve an explicit requirement or an artifact with the shared resolver:

```bash
dotbabel models refresh --runtime codex
dotbabel models resolve --requirement deep --runtime codex --json
dotbabel models resolve skills/example/SKILL.md --artifact-kind skill --runtime codex --json
```

Refresh is an explicit cache update. Resolution reads the existing cache and policy; it does not
refresh, start an inference turn, or change a session. These diagnostic commands remain available
without project activation. A missing runtime adapter or usable local cache produces exit 2.
Insufficient capability evidence produces an unresolved result; a known pin/floor conflict produces
exit 1. Invalid CLI arguments produce exit 64. Malformed artifact declarations produce data errors,
not an implicit fallback to legacy metadata.

`--artifact-kind` selects the target binding contract; it defaults to `command`. Pass the actual kind
when resolving an artifact. JSON returns the shared `ResolverResult`, including selected axes,
representation/provenance, enforcement, confidence, reason codes and diagnostics. Human output also
shows the requirement, floor and target. A resolved recommendation with `enforcement: unknown` does
not prove that a running session uses it. Reasoning and tool facts evaluate the configured semantic
policy; they are not measured model-quality rankings.

Artifacts must be regular files of at most 1 MiB. Missing, non-file or oversized inputs report
`artifact_unavailable`. Opaque pin values rejected by the runtime contract are not printed in human
diagnostics. Use explicit refresh when older cached evidence lacks the capabilities needed by a
requirement; resolution never performs that refresh on its own.

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

## Canonical migration

`dotbabel models migrate --json` reports legacy metadata without changing files. Alias-derived
semantic proposals require review. Explicit `model: inherit` can become an inherited declaration;
an omitted model never creates a concrete requirement. The writer preserves native model/effort
fields and artifact bodies until a separate runtime projection migration proves replacement behavior.
Mandatory floor projections retain the native compatibility pin. Explicit dynamic and inherit modes
keep their existing canonical precedence.

Create a reviewed JSON decision file for a selected batch:

```json
[
  {
    "sourcePath": "agents/changelog-assistant.md",
    "artifactKind": "agent",
    "category": "C",
    "compute": { "requirement": "mechanical", "mode": "floor", "binding": "self" }
  }
]
```

Run `dotbabel models migrate --check --decisions migration.json --batch C --json` to inspect the
required changes. Check returns 1 while that selected batch needs changes, and 0 when compliant.
Apply the same reviewed input with `--write` instead of `--check`. The flags are mutually exclusive.
Omit both flags to preview a decision file. Categories A through F follow the migration audit;
class F remains unchanged and reports an owner decision. Unselected legacy artifacts remain
unchanged. A compliant selected batch does not mean the entire repository has completed migration.

The writer prevalidates the complete batch under the existing project lock. Each replacement
compares the original bytes. A concurrent edit stops replacement and preserves that edit. Earlier
completed files keep their legacy controls and remain usable; resolve the changed source before
resuming. The current write backend requires Linux, `/proc/self/fd`, Python 3 and `renameat2`.
No migration command discovers models, executes an inference or changes project activation.

## Exact artifact floors

`model_intelligence.scoped_floors` adds minima for exact canonical paths and artifact kinds:

```json
{
  "model_intelligence": {
    "scoped_floors": [
      {
        "mode": "floor",
        "requirement": "frontier",
        "scope": {
          "artifact_kind": "agent",
          "source_path": "agents/security-auditor.md"
        }
      }
    ]
  }
}
```

Paths are portable repository-relative paths, with no globs or traversal. Every policy layer adds
floors; a later layer cannot remove an earlier minimum. The shipped security-agent and
security-review selectors use Frontier minima. They do not impose a global floor on other artifacts.
Resolution receives the canonical source path separately from the runtime output destination.

## Recommendations

`dotbabel models recommend <artifact> --runtime <id> --json` produces advice from the shared
resolver and cached evidence. Use `--requirement deep` instead of an artifact for an explicit
semantic request. Human output includes a native invocation recipe; JSON keeps its command,
arguments and unsupported axes separate. A differing recommendation returns 0. No command runs
that recipe, changes runtime settings, refreshes capability data or submits the user's task.

An optional `--observation-file <path>` supplies a validated runtime observation record. This is
an explicit saved record, not a new live session probe. The command preserves its basis and
reported provider/model/effort fields. A reconstructed probe is not treated as the user's session.
The saved-observation reader currently requires Linux and `/proc/self/fd`. Recommendations
without this flag do not use that filesystem backend.
Without an as-run observation, advice reports unknown comparison. Missing capability evidence
never becomes a model ranking. Escalation and de-escalation compare semantic capability classes
established by exact configuration queries to the same public resolver, with mandatory floors
retained. Names, prices and provider families do not establish a ranking.

The recommendation always has `configurationBasis: advice`. Its executable flag means that the
native renderer can express the complete recipe; it is not evidence that a runtime used it.
Unsupported native axes remain visible and make that flag false. Activation and MAIN routing
remain independent of this explicit diagnostic command.
