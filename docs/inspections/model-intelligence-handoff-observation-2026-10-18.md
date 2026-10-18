# Handoff observation integration

## Grounded diagnosis

`plugins/dotbabel/scripts/handoff-extract.sh:84` assigns a constant null Claude model.
Candidate one is unavailable native observation. The existing Claude adapter accepts bounded
caller-supplied stream JSON at `sources/runtime/claude.mjs:258` and reads system/init.model at
`:144`; this rules out a universal observation limitation. Candidate two is missing consumption:
the shell metadata path never calls that adapter. Add a bounded read-only consumer bridge.

`handoff-extract.sh:275` assigns model_provider to model. Candidate one is a runtime model alias
named after its provider. The existing Codex adapter explicitly separates axes.model from provider
at `sources/runtime/codex.mjs:334`, so the shell mapping is wrong. Candidate two is missing
transcript-specific observation. Extend the same adapter with a bounded stream path for explicit
session_meta provider and turn_context model/effort values. These are reconstructed configuration,
not proof of the model used for inference. Missing model stays unknown; never infer it from provider.

The autonomous contract authorizes these corrections. Preserve prompts, turns, todos, session
identity and metadata extraction. Read only the explicitly supplied transcript. Start no runtime,
network request, provider inference or discovery on this path. Reuse the source-adapter registry;
missing Antigravity/OpenCode observation is unsupported, not invented support or a command failure.
Keep existing Copilot/Gemini metadata behavior until their separate P22 adapters exist.

## Implementation and proof

The bridge requires an explicit data-only `observeStream` export. Native `observe({stream})`
delegates to the same implementation. This prevents a future registry adapter from ignoring a
stream option and starting a native probe. Explicit invalid stream types return unknown without
configuration reads or native execution. The existing source-adapter contract fixtures stay green.

The completed focused suite passes 82 cases; all 37 handoff extraction/regression shell cases pass.
An explicitly enabled installed-runtime test passes for both installed runtimes with zero additional
inference. Codex reads only the controlled thread created by the earlier two-prompt proof, through a
native `thread/read` path. Its actual transcript fields match the completed native configuration,
and the shell, adapter and recommendation consumer agree. Claude emits an actual native stream-json
initialization from a local metadata command; it reports Sonnet 5.5 with no executed inference,
no model usage, API duration or cost. This is observation proof, not Claude MAIN routing proof.
The first scratch fixture has no Git repository, so SessionEnd emits a git-root diagnostic.
Initializing the isolated fixture removes that diagnostic; no global hook changes occur.

The first two-module mutation measurement fails at 77.60%: 149 killed, 41 survived and two uncovered
among 192 mutants, with 70 semantic tests executing. It exposes weak file-boundary verification.
Add tests for independent size/mtime/ctime changes after reads, short reads, descriptor release,
exact size limits, missing no-follow protection, invalid encoding before adapter dispatch, unsupported
and unverified adapters, useful diagnostics and reconstruction sources. File-system mocks preserve
real descriptor I/O and model the public OS metadata contract; they do not replace the parser or
runtime observation. The second measurement passes the unchanged 85% gate at 97.92%: 188 killed,
four survived, zero uncovered, zero timeouts and zero errors. Both complete modules remain measured.
