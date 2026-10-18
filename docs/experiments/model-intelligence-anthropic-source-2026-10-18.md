# Anthropic capability source proof — 2026-10-18

The applicable P-8b adapter consumes official provider facts through a caller-owned native transport. It never reads credential stores or receives an authorization handle. Its fixed HTTPS endpoint, manual redirect policy, shared operation deadline, ten-page limit and aggregate 8 MiB response limit constrain acquisition. Normalization keeps explicit reasoning support, effort values, context limits and optional display names. It asserts no ordinary tool support, default effort, model quality rank or runtime availability from the Models API response.

The credential-free contract suite composes the adapter with the existing cache and catalog. A later authorization failure or malformed response preserves the exact earlier cache entry. Knowledge facts do not create a runtime entry or availability=available. The existing Models.dev adapter uses the extracted shared bounded reader with its previous response and cache limits unchanged. Six Bats cases exercise public status/refresh behavior, including the explicit Anthropic request returning native_transport_unavailable when no runtime-owned transport exists.

## Native proof

The opt-in Tier 3 test uses Claude Code 2.1.302 in a temporary Git project with a session-scoped plugin. Native session.authorize returns an opaque handle consumed only by native HTTP. A fixed argument-vector process call passes only the response body to the real Node source adapter. The source normalizes fourteen models, twelve with reported effort values. Source version: sha256:02a9188989a823990a206aff15d97647. The native result records zero turns, zero inference duration, zero tokens, empty modelUsage and zero cost. No credential or authorization handle is logged, copied into Node, saved in a fixture, or stored in evidence.

The native CLI labels the local command's returned text. The first integration assertion wrongly treats that labeled string as raw JSON and fails. The corrected assertion extracts the one-line status payload and independently checks every zero-inference counter. The passing evidence contains aggregate counts and provenance only; it asserts no native selector compatibility, entitlement or effort binding.

Run the external proof only when its existing-native-authorization prerequisites are intended:

```bash
DOTBABEL_MODELS_TIER3=1 DOTBABEL_MODELS_EVIDENCE_PATH=/tmp/mi-p8b-native-proof.json npm test -- plugins/dotbabel/tests/integration/model-intelligence-anthropic.integration.test.mjs
```

The evidence path is optional, created exclusively with mode 0600, and must not already exist. Without Tier 3 the integration test skips before starting Claude. A missing runtime or unavailable native authorization reports a skip. The production source has no default fetch and therefore performs no unauthenticated request or credential lookup. CLI-to-native transport setup and ordinary MAIN routing remain separate initiative work.

[Models API contract](https://platform.claude.com/docs/en/api/models/list), [native mod APIs](https://code.claude.com/docs/en/plugins/mods/reference).
