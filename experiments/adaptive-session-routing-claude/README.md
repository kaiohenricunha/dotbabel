# Claude MAIN native integration proof

This directory verifies the production module on the installed Claude Code 2.1.302, 2.1.304, 2.1.307 and 2.1.309. The integration is experimental. One live MAIN execution on 2.1.304 proves the model axis; the effort axis remains unverified.

## Setup and ordinary use

From the project to enable:

```bash
dotbabel models enable
dotbabel models enable --routing
dotbabel models session --runtime claude --model auto --effort auto
```

The last command opens the native Claude terminal with a temporary session-only Mods plugin. Enter ordinary prompts in that terminal. No per-prompt command is required. Claude retains input, attachments, conversation history, tools, approvals, sandbox and subagent configuration. The launcher changes no global settings. Plugin files and the private Unix socket are removed when the native process exits. The default session runtime remains the managed Codex App Server client; `--runtime claude` selects the native Claude UI.

Each `auto` explicitly releases one axis. Omit an option to preserve native initial selections. A manual model or effort remains independent of the other axis. Native picker intent or an unattributed native change preserves the affected axis conservatively. Restart the launcher with the required `auto` options to release a latched manual selection again. A native `/effort auto` clears Claude's own setting; it does not grant this router permission to replace an unknown selection.

Native model restrictions, effort caps, provider mappings and alias override environments cause `native_policy_unverified`. The router preserves native controls instead of implementing a second native policy interpreter. Alternate provider authorization is unavailable to this first-party Models API path. Unknown Claude versions cause `routing_unverified`. Windows-native Unix-socket operation is unsupported; this implementation runs under Linux/WSL and other Unix hosts subject to their own measured runtime contract.

Image-capable model evidence is mandatory for automatic selection. The router never reads attachment bytes. Audio or document attachments make automatic compatibility unknown for the rest of the conversation, so native configuration is preserved. Discovery and local classification failure preserve native configuration. A known binding conflict answers locally without sending an unsafe model request. A failed or interrupted native request is never replayed.

## Inspect, disable and recover

```bash
dotbabel models status --json
dotbabel models disable --routing
dotbabel models disable
```

Status distinguishes project opt-ins from integration implementation and effective session state. It does not attach to another running native session; effective axes remain unknown there. The running native UI emits `ClaudeRouting` version 1 JSON records through its own diagnostic log. `intended` names the configuration forwarded to the next native handler. `accepted` remains unknown because Mods has no distinct provider acknowledgement. `effective` uses `turn.step` response `usage.model`, and only adds reasoning when correlated native `classic.Stop` effort evidence exists. A requested effort never becomes observed effort by assertion. Native model fallback stops further automatic rewrites in the current tool loop.

The launcher checks opt-ins at each new MAIN turn. A change applies to the next turn; it does not change a running operation. Disabling removes no user file or credential. Exit the wrapper and run `claude` directly to return to the native launcher. The native UI is not an NDJSON terminal: `session --runtime claude --json` is a usage error. JSON inspection remains available through `models status --json` and native diagnostic records.

## Reproduce the evidence

```bash
python3 experiments/adaptive-session-routing-claude/verify-host.py
node experiments/adaptive-session-routing-claude/verify-native.mjs
node experiments/adaptive-session-routing-claude/verify-native.mjs --live
```

The first command validates the actual production source and runs the installed host's no-network test kit. Its model stream is a stub; this is not provider execution. The second command uses an actual native local command, native opaque authorization and the fixed official Models API, the real private Unix socket, isolated zero-inference runtime probes, the existing source/catalog/snapshot facts and the shared resolver. It is metadata-only and asserts zero inference duration, cost and usage. It neither sends the fixture prompt to a classifier service nor transfers authorization to Node.

The last command attempts one ordinary, tool-free native MAIN prompt through the production launcher and module. It retains native authentication and safety controls. On 2026-10-18 the measured native response reports the weekly limit and the reset at October 19, 9pm America/Fortaleza. MAIN diagnostics show the proposed Haiku/Low route before that failure; accepted and effective axes stay unknown. There is no automatic retry, alternate account or quota workaround. The original real-Claude acceptance criterion stays planned.

On 2026-10-20 the same command runs on 2.1.304 after the weekly reset. The first metadata run returns `preserved` with `stale_capability_evidence`: the reviewed release documentation was more than 24 hours old. The owner approves a REL-4 amendment that keeps reviewed release documentation valid for its release. After that change the metadata run proposes `claude-haiku-5-5` with `low` effort at zero inference cost. The live run then completes one turn in 2,226 API ms for USD 0.00326. Native `modelUsage` and `turn.step` `usage.model` both report `claude-haiku-5-5`, so the model route applies. The `ClaudeRouting` record shows intended effort `low`, but `classic.Stop` reports `effort.level` `medium`. The hooks reference defines that field as the level in effect when the hook runs, so it cannot show whether the per-request `turn.step` effort applied. The record reports `medium` as the observed effort and makes no claim of `low`. Effort routing stays unverified until a discriminating measurement exists.

The first metadata attempt exposes missing native effort intent annotations; the corrected shared runtime adapter resolves the same task. The inspection records both candidate causes and the failing regression. The first proof fixture used a `.git` placeholder, which made the existing native SessionEnd hook fail its git query. The fixture now runs `git init --quiet`; the final metadata proof has empty stderr and zero inference cost. The earlier live attempt, including that fixture error, remains failed evidence.

On 2026-10-22 the six acceptance steps run on 2.1.307. Plugin validation and the host relay test pass. The metadata run proposes `claude-haiku-5-5` with `low` effort at zero turns, zero API time and zero cost. The live turn applies the model: intended and native `usage.model` are both `claude-haiku-5-5`. That turn costs USD 0.258, because it writes 257,723 cache-creation tokens with no cache read: the live proof loads the full user configuration, and no cache was warm. `classic.Stop` reports `effort.level` `xhigh`, which equals the user's `effortLevel` setting at that time. On 2.1.304 the setting was `medium` and the report was `medium`. The report therefore follows the session setting, which supports the second effort explanation above; it still does not show the effort that the request used, so effort routing stays unverified.

On 2026-10-23 the acceptance steps run on 2.1.309. The host relay test passes. Plugin validation now also reports two plugin-directory submission checks (README and LICENSE missing); they concern a public directory listing, not this session-only plugin, and validation still exits 0. The metadata run proposes `claude-haiku-5-5` / `low` at zero cost, and the live turn applies `claude-haiku-5-5` (USD 0.0036 with a warm cache). A separate measurement (`docs/experiments/adaptive-session-routing-claude-effort-2026-10-23.md`) gives moderate evidence that the `turn.step` effort override applies.

## Verify a new Claude Code release

Routing runs only on an exact Claude Code release listed in `VERIFIED_MAIN_VERSIONS` (`plugins/dotbabel/src/model-intelligence/sources/runtime/claude.mjs`). Each Claude Code update can change the Mods contract, so a new release stays unverified until it passes these checks.

On an unlisted release, `dotbabel models session --runtime claude` stops with `routing_unverified` before Claude Code starts. The failure is explicit, and nothing changes silently. `dotbabel models status --json` lists the accepted releases in `mainSessionIntegrations[].verifiedHostVersions`. Run `claude` directly to keep working without routing.

To accept a new release:

1. Install the release, and confirm the exact version with `claude --version`.
2. Run `python3 experiments/adaptive-session-routing-claude/verify-host.py`. Plugin validation and the host test must pass.
3. Run `node experiments/adaptive-session-routing-claude/verify-native.mjs`. The metadata run must return `configuration_proposed` with zero turns, zero API time and zero cost. A `preserved` result needs a diagnosis first.
4. Run `node experiments/adaptive-session-routing-claude/verify-native.mjs --live`. One ordinary turn must report the intended model in `usage.model`. Record the observed effort without a claim beyond the evidence.
5. Add the version to `VERIFIED_MAIN_VERSIONS`, test-first. Add an accept row for the new release, and keep a reject row for an unmeasured neighbor, in the bridge, input, launcher and status tests.
6. Open a pull request that names the release and pastes the output of steps 2 to 4. A failed step keeps the release unverified, and the pull request records the failure and its diagnosis.

## Sources and limits

The [Mods events contract](https://code.claude.com/docs/en/plugins/mods/events) defines the MAIN request boundary and stream forwarding. The [Mods test guide](https://code.claude.com/docs/en/plugins/mods/test) distinguishes host tests from live execution. The [model configuration guide](https://code.claude.com/docs/en/model-config) documents per-model effort and native restrictions. Installed type generation and actual CLI validation bind the experiment to 2.1.302. On 2.1.304, plugin validation, the host relay test, the metadata run and one live run pass; other releases return `routing_unverified`.

An organization-managed installation can omit `classic.*` events from person-installed plugins. Missing observations remain unknown. Other installed Mods can rewrite requests and results later in the native chain; the diagnostic distinguishes our intent from what returns through that chain. Native quota, account entitlement and unsupported combinations are not waived by a local proposal. No claim ranks model quality, cost or universal task accuracy.
