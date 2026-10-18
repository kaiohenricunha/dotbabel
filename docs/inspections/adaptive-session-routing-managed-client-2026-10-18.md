# Managed Codex MAIN client closure

## Grounded gap and selected boundary

`plugins/dotbabel/src/adaptive-session-routing/codex.mjs:9` assigns transport, approvals,
observation and the session UI to its caller. The existing real-turn experiment supplies that caller,
but `plugins/dotbabel/bin/dotbabel-models.mjs` has no ordinary-prompt session verb on base 56a7f66.
Candidate one is unsupported App Server per-turn overrides. The existing real two-turn proof rejects
that explanation: the native boundary already changes configurations inside one thread. Candidate
two is a missing product caller. Implement that caller around the existing router and transport;
keep the resolver, classifier, credential ownership and native permission system unchanged.

The installed Codex 0.163.0 generated schema exposes `config/read` origins per setting. A real
zero-inference query reports separate user origins for model and reasoning effort. Preserve those
explicit selections independently. `--model auto` and `--effort auto` explicitly release the selected
axis for this managed session. Unknown provenance stays conservative. Do not edit native settings.

## Scope and proof plan

1. Write client tests first for activation, one retained thread, original input/attachments,
   manual axes, native permissions, early completion, observation and failed initialization.
2. Add `models session` with ordinary newline prompts and independent launch-time axis controls.
   Reject unsupported runtimes and irrelevant flags before I/O. Keep existing CLI contracts intact.
3. Exercise the public CLI through a real subprocess fixture, then two actual native model turns.
   Read the native thread afterward and compare controlled prompt hashes and exact message counts.
4. Measure the unchanged mutation and quality gates, run the protected four-role review, and use
   exact-head Node 20/22 CI as merge evidence.

## Current implementation boundaries

`client.mjs:38` gates both project opt-ins before a native process starts. Its session-start request
supplies only the project directory; approval and sandbox settings remain native. The terminal
accepts command/file approval only through an explicit interactive answer. Missing handlers and
piped input never approve tools. Other native interaction requests remain unsupported and fail
through the existing transport. This terminal does not claim full stock-CLI interface parity.

Native discovery uses the existing adapter and catalog. Freshness uses the shared evidence policy;
native eligibility is checked on every classified turn. Neither capability classes nor native effort
semantics are copied into the client. The existing router still owns manual precedence, floors,
hysteresis, modality checks and the uncertain-submission barrier. No task is automatically replayed.

The first public CLI proof completes two ordinary prompts on one real thread. The first uses Low
effort; the second uses High effort while retaining the model. A separate native `thread/read`
confirms exactly two user messages with hashes equal to the two original prompts. The native
permission report is read-only with network disabled and on-request approvals. These policies come
from explicit native arguments in an isolated test wrapper, not changes to global configuration.

This proves the managed client on installed Codex. Stock interactive Codex interception and actual
Claude MAIN inference remain separate, unverified integration boundaries. The initiative stays open.

The public CLI rejection test catches exit 0 after a correctly blocked unsupported-effort request.
Candidate one is lost policy enforcement; the native fixture's submission log remains unchanged,
and the result is blocked. Candidate two is missing terminal exit handling at `terminal.mjs:43`.
Set exit 1 for policy blocks and exit 2 for uncertain or failed native outcomes. Keep the blocker,
the unchanged native submission count and the nonzero exit assertions.

A second boundary test catches a completed thread still marked cold after observation fails.
Candidate one is a missing native completion; the fixture emits a correlated completed turn and
the first result reports completion. Candidate two is coupling context warmth to successful axis
observation in `client.mjs` after `thread/read`. Mark the context as executed independently, with
unknown axes, then replace those axes only when the native observation is valid. Requested axes
cannot substitute for unknown effective axes. The regression fails before this correction.

The initial fast quality run reports native subprocess timing failures under the concurrent mutation
load, plus a real architecture violation in `model-intelligence-catalog.test.mjs:643`. Candidate one
is an obsolete disabled-path rule; its dynamic check still protects ordinary unrelated commands.
Candidate two is placing catalog construction directly in the routing client. Preserve the gate:
move the coherent native discovery/catalog/policy loader into the Model Intelligence CLI boundary.
The routing client requests resolver input through that existing architectural boundary. This is not
a second chooser or a second registry. Rerun timing-sensitive quality serially; retain the failures.

The loader's transient-failure regression finds an unavailable result retained as if fresh on the
next call. Candidate one is repeated native failure; the supplied next result is valid. Candidate
two is assigning the session-local cache before checking status. Keep the last valid discovery and
assign only accepted results; a later ordinary prompt can retry discovery without replaying a turn.

The completed-observation integration test then exposes a missing enforcement input. After policy
tightens to Frontier, a known Routine native session completes another turn instead of blocking.
Candidate one is absent capability evidence; the fixture has explicit class facts for that model.
Candidate two is an omitted as-run observation. `resolver/enforcement.mjs:25` needs that input to
diagnose the known violation when no safe replacement exists. Supply the actual completed native
observation through the input loader. Clear it after execution until a new native read succeeds;
never substitute a requested configuration. The public resolver remains the only floor judge.

Partial-observation tests also distinguish unavailable evidence from an unreported effort. The
native thread schema permits a null reasoningEffort while still reporting a model. Candidate one
is no model evidence; the fixture explicitly reports it. Candidate two is requiring both axes in
the observation guard. Preserve the known model and omit the unknown effort. Normalize a reported
provider through the existing shared toProviderId helper and keep its own field source.
