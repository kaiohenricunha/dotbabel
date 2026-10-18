# Claude MAIN implementation inspection

## Grounded scope and choice

The existing `adaptive-session-routing/prepare.mjs:14-26` gates classification and shared resolution by project activation. `route.mjs:36-76` preserves independent manual axes and binding constraints. `client.mjs:34-113` integrates Codex. No Claude production entry exists at the base `6303cc8`; the existing native host experiment only tests a stub rewrite. The selected implementation adds a native MAIN boundary, session-only launcher and private local resolver bridge. It does not create a second resolver or registry.

One candidate explanation for missing Claude routing was an unsupported override interface. Installed 2.1.302 types and the current host test reject that explanation: `turn.step` accepts model and effort while preserving pinned turn/history fields. The other explanation is the missing production integration. The base source tree confirms that gap. The native plugin validator also requires API helpers at module scope; the first validation rejects a nested reporting helper. The corrected production boundary passes the actual installed host test.

## Real metadata failure

The first production native metadata run crosses the private Unix socket, reads the native model menu, performs native-authorized Models API GETs and isolated zero-inference selector probes. Native output reports zero turns, zero inference duration and zero cost. It returns `effort_intent_unavailable`; this is a failed route, not a successful MAIN execution.

Candidate one is unsupported native effort. The provider response and accepted exact-model native documentation advertise low, medium and high controls, which argues against that explanation. Candidate two is missing semantic annotations: `resolver/index.mjs:69-73` requires both `intent` and bounded `order`, while the initial `claude-input.mjs:66-70` intersection retains only `effort`. This directly explains the observed failure. Add a Claude-specific annotation function at the native runtime boundary and a failing real-resolver regression before correcting the loader. Retain unknown future controls without inventing semantics. The autonomous owner grant authorizes this scoped correction.

## Integration fixture failure

The oversized Unix-socket test initially reports EPIPE. A response-side error handler does not fix it. A separate Node reproduction instruments the error emitter and identifies a client Socket with no error listener after its HTTP request completes; the server is not the emitter. The fixture's default persistent client connection conflicts with immediate session teardown. Its owner now uses `agent:false`. All eight socket tests pass without suppressing Vitest errors or changing production size checks.

## Limits retained

Host tests prove the installed middleware contract. Metadata requests prove transport and proposals. Neither proves an effective provider configuration. The original native weekly admission limit remains to be rechecked with one controlled ordinary MAIN prompt. Organization-managed Claude can omit person-installed `classic.*` handlers; absent effective effort evidence remains unknown. Unknown manual provenance is conservative. Audio and document inputs preserve the native configuration until compatibility is verified; image-capable selection is required for automatic routes. The module does not read attachment bytes, rewrite tools, authorize native approvals, mutate global settings, replay input or restart a failed request.
