# Controlled Codex main-session routing — 2026-10-18

## Result

Installed Codex 0.163.0 completes two ordinary engineering prompts in one retained App Server thread. The shared local classifier and resolver select native model/effort before turn/start. On the verified cold first turn, automatic routing changes gpt-6.1-sol/high to gpt-5.6-luna/low. The second task retains that model and changes effort to high. These names are observed runtime results, not fixed preferences or a model-quality ranking.

The native thread/read metadata after each turn/completed matches both selected axes. The initial acknowledgement reports effective state unknown. No reroute notification occurs. Each original user message appears exactly once, verified against native userMessage items by text hash. Both input objects remain unchanged. No transcript is replayed, no classifier model call runs, and no native tool or permission request receives automatic approval. The test uses an ephemeral read-only project with on-request approvals; production routing must preserve its caller's existing native permission parameters.

The JSON evidence includes native thread/turn identifiers, field sources, message hashes, native notification counts and hashes of the four implementation modules. It contains no authentication material or account-specific model catalog. The native harness retains credential ownership. The read-only account probe confirms only account type; no credential is read or copied.

## Reproduction

Run `node experiments/adaptive-session-routing-codex/real-turn.mjs --live` explicitly. This executes two primary model turns through the existing native account and prints bounded evidence. Without --live, it exits 64 before starting a runtime. It creates its own temporary Git project, never changes native global configuration, and preserves installed hooks. Cold-thread status comes from the new native thread's empty turn list. Default app-server credentials remain native-owned.

The boundary source passes 83 submission/protocol tests. They cover input/attachment preservation, deduplication, uncertain writes without retry, native completion boundaries, manual changes racing preparation, independent explicit axes, floors, modality constraints, Unicode transport, permission-handler delegation, missing/failing handlers, bounded reads/timeouts and coded observer failures. The mutation run passes at 88.43%: 489 killed, eight timeouts, 59 surviving, six uncovered and one invalid runtime mutant. Excluding all timeout credit still gives 87.01%, above the unchanged 85% gate. Whole-protocol failure mutations can intentionally prevent completion; their timeout outcomes remain explicit. The PR quality profile exits 0 with warning verdict and all configured executions passing. Review and managed-client integration still follow; this report does not close the initiative or claim stock CLI interception.

The final source run repeats both native turns after integrating the reviewed core and the attachment-modality correction. Its source hashes accompany the evidence.

For acceptance evidence use `DOTBABEL_MODELS_TIER3=1 node plugins/dotbabel/bin/dotbabel-criteria.mjs verify --spec adaptive-session-routing --allow-project-commands --pass-env DOTBABEL_MODELS_TIER3 --json`. The runner intentionally sanitizes environment variables; setting the flag without --pass-env leaves AC-12 skipped and unconfirmed. Both the environment opt-in and the explicit pass-through are required. No repository policy or environment filter is weakened.

## Investigation and failed probes

A non-Git temporary fixture initially prevents native completion. Candidate A is unavailable provider authentication, but account/read reports an existing ChatGPT account and the native stream emits model responses. Candidate B is the installed user Stop hook: native hooks/list identifies dotbabel-peer.mjs, and its repository check fails outside Git. A direct reproduction exits 2 outside Git and 0 after git init in the same isolated directory. Choose B and fix the test fixture. No hook, trust, native setting or permission is disabled or changed.

A later probe completes two turns with routing preserved because the fixture places adaptive_routing at the wrong JSON level. The implementation correctly leaves routing disabled. The corrected fixture uses model_intelligence.adaptive_routing.enabled, supplies only actual policy layers to mergePolicy, and uses the existing workflow consumer target. It verifies a local proposal before inference. That run proves low/high effort routing; the final run also proves automatic model application on the verified cold first turn. Failed or disabled-path probes are not counted as routing acceptance.

## Uncertain native writes

A stale completion from a prior turn initially releases an uncertain submission. The new failing regression confirms the consumer defect; the transport makes no retry. The correction clears only a matching known active turn. An uncertain acknowledgement remains a barrier even after uncorrelated completion events. Inspect native state before explicitly creating another boundary, and never automatically replay the uncertain original input. This conservative recovery limit preserves turn boundaries rather than inventing proof of cancellation or completion. See the uncertain completion audit.

## Scope and limits

This evidence covers the managed App Server boundary on the installed version. It does not establish stock Codex CLI pre-submit interception, a production terminal UI, effective provider fallback beyond native-reported metadata, manual selections in another client, real image understanding, or Claude routing. AC-5 covers the retained-thread submission contract. AC-12 has a real Tier 3 integration test which starts two primary turns only when DOTBABEL_MODELS_TIER3=1; without that opt-in it skips and cannot satisfy the criterion. Main-session capability descriptors and user-facing activation remain separate from this boundary. Preserve the original P-12 through P-23 workstream.

Official contracts: [Codex App Server](https://learn.chatgpt.com/docs/app-server). Installed protocol schemas are generated from Codex 0.163.0; actual mutable turn fields, thread model/reasoningEffort and model/rerouted notifications are inspected before the controlled run.
