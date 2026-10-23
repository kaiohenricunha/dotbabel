# §5 — Interfaces and APIs

## Configuration

Use `.dotbabel.json`:

```json
{
  "model_intelligence": {
    "enabled": true,
    "adaptive_routing": { "enabled": true }
  }
}
```

Both default to false. A routing preference alone does not enable the engine. Disabling the engine retains the routing preference but makes it ineffective. No command changes global Claude/Codex configuration.

`dotbabel models enable|disable [--routing] [--repo-root <path>] [--json]` changes only these flags under the project configuration lock. `status` reports requested/effective activation separately from whether a verified runtime integration is actually active. Diagnostic `refresh`, `resolve` and `recommend` remain explicit operations even when automatic behavior is disabled.

## Data contracts

`classify({prompt, context})` returns semantic requirement, separate effort intent, confidence, characteristics and stable reason codes. No native model name appears in classification output.

The initial local classifier accepts at most 16,384 prompt bytes and a strict supplied context object
bounded to 4,096 serialized bytes. Context fields are `componentCount` (0–64), `priorFailures` (0–20),
`specification` (`present|absent|unknown`), `risk` and `consequence` (`low|medium|high|unknown`),
`ambiguity` (`low|medium|high|unknown`), and `verification` (`simple|integration|adversarial|unknown`).
It does not load that context from a repository or infer missing fields as verified facts.

`status` is `classified`, `uncertain` or `invalid`. A classified result carries a normalized dynamic
session requirement and a separate semantic `effortIntent` (`low|medium|high`). These effort labels
are not assumed to be native runtime values. Adapters must map them against verified support.
Confidence describes rule/input certainty; it is not calibrated task-success or model-quality
probability. Structured diagnostics never echo rejected prompt/context contents. Quoted examples and
negated clauses do not automatically raise demand; relevant failure facts belong in supplied context.

`route({activation, classification, resolverInput, current, manual, runtimeCapability})` returns a decision, selected configuration, observed configuration, confidence, reasons and diagnostics. `current` is not automatically manual: `manual` tracks explicit selections per axis where the harness exposes provenance. Unknown provenance preserves the affected axis.

Routing delegates modality, operation capability, ordinary-selection, semantic effort and per-axis override constraints to
the existing resolver. An automatic current-model retention probe must still require ordinary listed
eligibility. Retention cannot smuggle an internal/hidden model into an automatic choice. Runtime
control application and effective-state observation remain separate from successful resolution.

`prepareRoute(request, dependencies)` reads project activation before accessing the prompt or loading
capabilities. Unsupported mechanisms and uncertain classifications also stop before capability
loading. Dependency failures return coded fallback without copying rejected input or exception text.
A proposal remains distinct from an applied or observed configuration. Hysteresis uses a second
shared-resolver probe and cannot shadow an existing model pin.

`current.turnExecuted: false` identifies a verified cold thread with no completed turn. It skips
current-model retention because no conversation cache exists yet. A true, absent or unverified
value keeps conservative retention. Explicit manual axes and all floors still apply on a cold turn.

`apply(decision, originalSubmission)` is runtime-specific and called once before execution. Requested, accepted and observed effective configurations are separate states. A successful submission acknowledgement alone does not prove the actual model.

## Runtime contracts

The shared source descriptor accepts an optional `capabilities.mainSession` table keyed by execution
mechanism. Each entry carries support/axis states, an observation support/axis block, and optional
manual-selection provenance support. Existing five-block descriptors remain valid. Unknown mechanisms
and absent axes stay unverified; a supported invocation recipe alone never proves per-turn control.
The registry snapshots and freezes this metadata. The runtime integration must still verify the
installed interface before proposing or applying a control change.

Claude: `models session --runtime claude [--model auto|<native-value>] [--effort auto|<native-value>]` opens the native terminal with a private, session-only Mods plugin on measured builds 2.1.302, 2.1.304, 2.1.307 and 2.1.309. No per-prompt command is required. `prompt.submit` forwards the original input once. MAIN `turn.step` changes only model and effort before the first request and retains that decision through the tool loop; worker events remain untouched. A private Unix socket delegates classification, evidence joining and selection to the existing Node modules. Native authorization stays in the host, used only for fixed official Models API metadata GETs. No additional classifier inference occurs.

**Persistent Claude plugin (opt-in, user scope).** `dotbabel models enable --routing --claude-plugin` installs the same Mods module as a user-scope Claude Code plugin, so plain `claude` sessions route without the launcher. The command registers a local directory marketplace that dotbabel owns and runs `claude plugin install <plugin>@<marketplace> --scope user`. Claude Code then records the plugin in `enabledPlugins` of the user's Claude settings. This is the only change to shared Claude configuration, and it happens only on this explicit command. `dotbabel models disable --routing --claude-plugin` reverses it with `claude plugin marketplace remove`, which removes the plugin and its `enabledPlugins` entry. No other setting, credential or file of the user is touched.

The module stays a no-op in every session whose project has not enabled routing. At `turn.start` it reads the project's activation through one local `dotbabel models` command (`$.process.run`, an argument list without a shell). In an enabled project, the same command returns the routing decision for that turn. The command is `dotbabel models route`, and it reads its one request on standard input, never in its arguments. To avoid three runtime probes on each turn, it keeps the verified native catalog in one private file per Claude session (directory mode 0700, file mode 0600) under the user cache directory, keyed by the session id and the Claude release. The file holds no prompt, decision, policy or credential, and it expires with the provider freshness window. `turn.step` applies that decision to each MAIN request of the turn and never to a subagent request. The measured-version gate, manual-selection precedence, modality rules, fallback and diagnostics are the same as for the launcher. A new install loads at the next session start or after `/reload-plugins`, and the documentation says so.

Organization controls win. When managed settings set `allowManagedModsOnly`, `disableAllHooks` or `allowManagedHooksOnly`, the plugin's hooks do not run. `models status` reports the integration as `blocked_by_policy`, and never as active. The launcher remains available and unchanged.

The integration remains experimental until the real provider criterion passes. The running native diagnostic emits `ClaudeRouting` version 1: `intended` is the request passed onward; `accepted` stays unknown; `effective.axes.model` requires returned native usage, while reasoning requires correlated native Stop effort evidence. An absent observation stays unknown. Unknown versions, native policy/alias overrides, unsupported input modalities and unknown manual lineage preserve native configuration. A native fallback stops further rewrites in that turn. A known floor conflict answers locally without executing a provider request. No failure replays a submission.

`models status --json` adds `mainSessionIntegrations`, separate from project activation. It identifies each mechanism, implementation state, measured versions and unknown effective session configuration. Status does not attach to another process or infer activity from opt-in flags. Claude uses the native UI, so its `session --json` option is a usage error. The [Claude guide](../../../../experiments/adaptive-session-routing-claude/README.md) documents setup, limits and recovery. Regular settings hooks and frontmatter do not establish MAIN routing support.

Codex: verify installed `turn/start` `model` and `effort`, persistent defaults on subsequent turns, `thread/resume`, model/effort observation, approval requests and exact input preservation. `turn/steer` is not the routing boundary. A client must not silently supply permissive sandbox or approval overrides.

### Managed Codex terminal

`models session --runtime codex [--model auto|<native-id>] [--effort auto|<native-value>]`
starts an explicitly enabled project's managed App Server terminal. Each ordinary input line becomes
one MAIN prompt on one retained thread. EOF closes it. Without an axis option, native user/project
settings remain manual and unknown provenance remains conservative. An explicit `auto` releases
only that axis for this managed session; a concrete value pins it. Native permission settings remain
unchanged. Missing approval handlers and noninteractive input cannot approve native tool execution.

`session --json` is an explicit streaming interface: newline-delimited session, assistant-text and
turn-result records. Existing diagnostic verbs still emit one JSON document. Requested, accepted
and observed axes remain separate. A native reroute or missing post-completion observation leaves
effective state unknown. Policy blocks exit 1; failed/uncertain native turns exit 2 without replay.
This text-line terminal does not claim transparent stock-CLI interception, full interaction parity,
thread resume or attachment entry. The public client preserves supplied native input arrays.

## Diagnostics

JSON fields are additive and reason codes retain meaning. Codes include `intelligence_disabled`, `routing_disabled`, `classification_uncertain`, `manual_selection_preserved`, `routing_unsupported`, `routing_unverified`, `routing_apply_failed`, `effective_configuration_unknown`, `pin_floor_conflict` and `stale_capability_evidence`. Follow existing CLI exits: 0 completed, 1 policy conflict, 2 required environment unavailable, 64 invalid usage.
