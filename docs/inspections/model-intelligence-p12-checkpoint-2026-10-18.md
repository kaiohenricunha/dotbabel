# Model Intelligence P-12 checkpoint — 2026-10-18

## Full assignment and ownership

The full original Model Intelligence and linked Adaptive Session Routing assignment remains open. Autonomous merge authorization starts 2026-10-18 03:23:34 UTC and expires 15:23:34 UTC. Activation #496, resolver #499, classifier #501 and routing core #502 are merged. Codex boundary #503 remains a separate reviewed unit. This worktree starts from main 6e53b38 and implements only the deliberately isolated P-12 pure materialization contract. It does not combine P-13 transactions or P-14 runtime-specific projections.

## Grounded contract and chosen interface

The governing contract is `docs/specs/model-intelligence/spec/5-interfaces-apis.md:879`; P-12 and its five named tests are in §6.3. The existing `parseFrontmatter` function in `plugins/dotbabel/src/build-index.mjs:84` already supplies parsed YAML, warnings and unchanged body text. The shared requirement parser validates compute metadata. The materializer consumes a completed resolver result and an explicit adapter-owned emission allowlist; it introduces no second chooser or runtime model table.

The new materialize/, render and manifest modules return runtime file bytes plus a deterministic manifest. SHA-256 identities cover meaningful canonical, requirement, policy, resolution, runtime/emission contract, capability and snapshot inputs. Operational envelope data is excluded. Object and allowlist order normalize. The source body and source hash remain faithful to canonical bytes. Source/target traversal and duplicate ownership fail before any write; filesystem/symlink ownership and locking remain P-13.

The renderer removes private metadata, validates authored compute before stripping it, emits only verified allowlisted keys and independently supported axes backed by the resolver's enforced artifact-binding assessment. Consumer recommendations and explicit inheritance produce no invented native binding. A known unsatisfied resolution fails. Optional compute retention requires explicit support and a named consumer.

## TDD and proof

The initial import-red baseline is `/tmp/mi-p12-red.log`. A missing effective-requirement hash test then fails before that input enters the identity. Five additional tests fail before implementing allowlist normalization, explicit inheritance, consumer-binding preservation, strict compute validation and known-unsatisfied rejection. The final suite passes 26 tests, including all five named P-12 cases, agent and skill stripping, negative data/path cases, and static reviewed runtime/manifest golden bytes. Golden files do not update during tests.

Fast quality exits 0 with warning verdict and all executions passing. PR quality also exits 0 with warnings, no environment error and all configured executions passing: 5,157 tests pass and 14 skip; changed lines are 100%, changed branches 91.74%. The existing large interface document causes a file-size warning. Unconfigured measurements are not passes. P-12 explicitly excludes mutation as rendering-only in the spec verification matrix; no mutation success is claimed or substituted. The P-13 drift gate remains mandatory later.

Eight active original criteria pass, including newly active AC-12/13. Ten specs validate and 22 document stamps pass. The public function feature run produces one runtime file, repeats byte-identically without mutating canonical inputs, verifies outputHash independently and performs no filesystem write. Logs: `/tmp/mi-p12-golden-green.log`, `/tmp/mi-p12-quality-fast.json`, `/tmp/mi-p12-quality-pr.json`, `/tmp/mi-p12-criteria.json`, `/tmp/mi-p12-feature.json`.

## Remaining work

Complete this unit's required four-role protected-path review, posted exact-head criteria and CI before merge. Do not close the initiative. P-13 through P-23, applicable P-8b, native user-facing setup/status/managed routing, Claude integration and the final full-spec audit remain open. Runtime-specific binding and transaction behavior are not claimed from pure generated objects.

## Canonical inheritance boundary

Two further regressions initially fail: an artifact without any compute declaration must preserve native inheritance, and a supplied inherited result must not conceal a canonical floor. The shared YAML/requirement reader now parses canonical source once before identity and status validation, supplying the same parsed data to rendering. The materializer uses the supplied effective requirement or falls back to the authored requirement. Inheritance is allowed only when both authored and effective declarations are absent/inherited and the resolver explicitly reports runtime inheritance preservation. All 28 tests pass, and the static golden bytes remain unchanged. Full quality is rechecked after this focused correction; no pending native binding is claimed.

Final follow-up PR quality exits 0 with WARN and no environment error: 5,159 tests pass, 14 skip, changed lines are 100% and changed branches are 92.80%. Every configured execution succeeds. The warning does not convert unavailable measurements into passes.
