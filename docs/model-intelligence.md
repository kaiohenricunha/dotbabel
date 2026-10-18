# Model Intelligence

_Last updated: v4.2.0_

Model Intelligence is an optional project capability. Installation does not enable it. The current
activation interface stores project flags. Explicit resolution uses cached capability evidence;
adaptive runtime integrations use separate execution modes. An enabled routing preference alone does not prove a runtime is routing prompts.

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

## Google runtime policy

Antigravity is the preferred Google project fan-out target. Gemini CLI remains an optional
legacy/enterprise runtime. The `antigravity` and `gemini` runtime identifiers stay distinct;
Gemini model identifiers do not imply Gemini CLI. Existing explicit fan-out lists remain authoritative.

The default change does not activate Model Intelligence or adaptive routing and does not alter
models or reasoning settings. The runtime registry recognizes both Google runtimes independently.
The shipped live discovery adapters currently cover Claude and Codex; this policy adds no adapter.
The [capability investigation](audits/model-runtime-capability-investigation.md) records Antigravity’s
`agy models` discovery separately from Gemini CLI’s lack of an equivalent verified command.
Those differences remain intact. See the [migration guidance](quickstart.md#google-runtime-migration).

## Runtime availability

The [adaptive routing spec](specs/adaptive-session-routing/README.md) defines the runtime integrations.
The managed Codex terminal uses App Server `turn/start`. Claude mods remain a separate integration.
The stock Codex interactive CLI has no verified transparent interception mechanism in this work.

The activation commands currently change only the project flags. They do not install or reload a
runtime integration. Any later adapter must document its startup/reload requirements. Do not expect
an existing session to route prompts merely because the flags changed.

### Managed Codex terminal

After enabling both project flags, start this separate execution mode:

```bash
dotbabel models session --runtime codex --model auto --effort auto
```

Enter an ordinary prompt at each `You>` prompt. No slash command is required. Each input line is
one prompt; EOF closes the session. The client retains one native thread and forwards each input
once. It uses the shared local classifier and resolver. Native discovery runs locally, and the
native model list supplies eligibility. The client starts no additional classifier inference.

The launch options control model and effort independently. `auto` explicitly releases that axis
for this managed session. A concrete native value pins that axis. Without an option, native user
and project selections remain authoritative. Unknown selection provenance stays conservative.
The client writes no native configuration file. It inherits the native approval and sandbox policy;
the session report shows those policies. Command and file approvals require an explicit terminal
answer. Piped input never approves tools. Other native interaction requests remain unsupported.

`--json` emits newline-delimited session, assistant-text and turn-result records. Diagnostic verbs
retain their existing single-document JSON contract. Each turn separates requested axes, native
acceptance and the post-completion observation. A native reroute or unavailable observation leaves
the effective configuration unknown. Failed or uncertain submissions are never replayed. Policy
blocks exit 1; an uncertain or failed native turn exits 2. Acknowledgement alone proves no effective
configuration.

The terminal currently accepts text lines. The public client API also preserves structured native
input arrays, including attachments. It does not provide the stock CLI's full editor and interaction
surface. The real managed-terminal proof runs on Codex 0.163.0 under Linux/WSL; it completes two
ordinary prompts at Low and High effort in one thread. Native thread inspection confirms exactly
one original user message per prompt. Other native versions report routing as unverified and preserve
automatic axes until their interface is measured. Run the controlled proof explicitly with
`node experiments/adaptive-session-routing-codex/real-client.mjs --live`; it executes two primary
model turns using the native account, with a temporary read-only native invocation wrapper.

Disable routing with `dotbabel models disable --routing`. Each later prompt rechecks the project
flags before classification and discovery. Close the managed terminal to end its native session.
Starting a new terminal creates a new thread; this interface does not resume a previous thread.

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
