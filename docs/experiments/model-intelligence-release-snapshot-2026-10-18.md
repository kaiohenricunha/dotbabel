# Release snapshot source proof — 2026-10-18

## Measured native support

Installed Claude Code is 2.1.302. The existing isolated source adapter observes haiku, sonnet and opus with no credential, a scratch configuration root, and a dead-port network proxy. Each probe stops at system/init before a model turn. The aliases resolve to claude-haiku-5-5, claude-sonnet-5-5 and claude-opus-5-5. The sanitized selector recording is `plugins/dotbabel/tests/fixtures/model-intelligence/release-source-proof.json`; all three turnExecuted values are false. Full identifiers and aliases appear as six accepted release selectors. No account entitlement or quota claim follows.

## Accepted public facts

The provider source uses the P-8b sanitized Models API fixture, passed through the actual shared Anthropic adapter. Its source version is the hash of those exact recorded bytes, not the different hash of the later complete native API response. Its original observation date remains 2026-10-18T05:18:08.353389+00:00. The adapter supplies input context limits. It does not assert native availability, native default effort or ordinary tool support.

The explicitly reviewed documentation bundle identifies exactly the three current model identifiers above. The [native model configuration contract](https://code.claude.com/docs/en/model-config) lists all five effort values and the medium native default for those models. This is separate from API defaults and from a user's manual preferences. The [models overview](https://platform.claude.com/docs/en/models/overview) supplies ordinary tool support for that documented current set. The native effort description supplies reasoning support. The accepted fact bundle includes both source URLs; its canonical content digest is the documentation sourceVersion. The same sanitized fixture records its exact scope and accepted values. No provider prose, SDK code or credential is copied.

## Boundaries and first failures

The initial snapshot tests fail because the module is absent. A later test fixture accidentally shares its mutable provenance object; a negative case changes that shared object and makes later cases fail. The fixture now returns independent cloned inputs. The first real native-backed public dry run finds a different clock defect: the check time precedes the collected observation. The grounded diagnosis and regression are in `docs/inspections/model-intelligence-release-snapshot-2026-10-18.md`. The corrected dry run succeeds, writes nothing and keeps the same snapshotId while observation dates differ.

A release-only catalog cannot enter ordinary adaptive routing. Source rechecks preserve the original documentation/provider dates and fail on changed mappings or versions. A separate reviewed accepted candidate can update those facts; failed source, schema, identity, age or supplied-floor checks preserve the committed file. Descriptor-anchored I/O rejects symlinks, serializes collection and protects another writer's changed bytes. Actual ordinary Claude MAIN routing remains unverified because the prior native inference admission attempt returns the weekly limit; none of this release proof claims a successful MAIN inference.

## Remaining consumers

P-16 plugin baseline generation and P-17 workflow generation must consume this snapshot and check their actual release floors. This unit does not mark those consumers complete. Local project activation, native global settings, approval rules, sandbox settings, credentials and manual axes are unchanged.
