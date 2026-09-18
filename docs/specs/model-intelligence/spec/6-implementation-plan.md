# §6 — Implementation Plan

> Phases, workstreams, prompts, tests, migrations, rollback.

**Settled.** The owner decided 6.1, 6.2, 6.4, 6.5, and 6.6 on 2026-09-18. IMPL-1 to IMPL-11 and TEST-1 to TEST-9 live here. The owner approved the 6.3 prompt sequence on 2026-09-18.

## 6.1 Phased Rollout

Decided by the owner on 2026-09-18. Model Intelligence implementation begins after the active `feat/qa-harness-p-c4-mutation` workstream lands (§2, `Urgency`). Each unit reaches `main` through the landing pipeline of IMPL-12, grouped into the pull-request sequence that §6.7 plans. Research that changes adapter contracts may proceed before then because it does not modify the implementation.

- **IMPL-1**: Phase 0 produces evidence and adapter-contract updates only. It does not begin the Model Intelligence implementation before the §2 priority gate is satisfied.

### Phase 0 — Close blocking research

Complete the research items that affect implementation contracts: RQ-1 (official model APIs and Models.dev), RQ-3 (Copilot custom-agent and `.prompt.md` behavior), and RQ-4 (skill-level binding for Codex, Antigravity, and OpenCode). RQ-2 remains optional optimization research under KD-5 and does not block implementation. **Depends on:** nothing. **May run in parallel with:** the current QA/mutation workstream.

### Phase 1 — Canonical requirement and compatibility foundation

Implement `domain/`, `requirement/`, `compat/`, the strict `dotbabel.compute` schema, real YAML parsing for nested Model Intelligence declarations, canonical normalization, dual-declaration conflict detection, `dotbabel models migrate` in analysis/dry-run mode, and JSON output for migration analysis. Replace model/effort parsing in Model Intelligence paths with the shared parser rather than extending the existing hand-written line parser (`plugins/dotbabel/src/validate-skills-inventory.mjs:32-62`). No canonical artifact is rewritten in this phase. **Depends on:** QA/mutation workstream landed. **Parallel internally:** domain types/state vocabulary; schema + requirement parser; legacy compatibility classification; migration-report renderer.

### Phase 2 — Evidence, policy, catalog, and cache

Implement `policy/`, the `sources/` adapter contract, the Claude runtime adapter, the Codex runtime adapter, the knowledge-source adapter(s) supported by completed RQ-1, `catalog/`, field-level provenance, freshness computation, capability-cache persistence, ARCH-59 to ARCH-61 atomic writes and refresh locking, `dotbabel models refresh`, and `dotbabel models status`. Claude and Codex are the first runtime adapters because DOC-2 provides the strongest measured evidence for them. RQ-1 integrations that are not sufficiently understood may remain deferred without blocking the runtime-backed catalog. **Depends on:** Phase 1. **Parallel internally:**

```text
policy/
        ┐
Claude adapter
Codex adapter     → catalog/ → cache/orchestration
RQ-1 source adapters
        ┘
```

Adapter implementations proceed independently once the common source contract and domain types are stable.

### Phase 3 — Resolver and explanation

Implement `resolver/`, typed constraint composition, dynamic/floor/pin/inherit precedence, the four enforcement states, confidence propagation, ordered explanation reasons, diagnostics, runtime representation selection, `dotbabel models resolve`, and resolver contract tests. The resolver remains pure and deterministic (ARCH-56). **Depends on:** Phase 2 catalog and policy contracts. **Parallel internally:** resolver constraint engine; enforcement-state calculation; explanation/diagnostic rendering; CLI integration. The resolver is testable against fixtures without invoking any adapter.

### Phase 4 — Deterministic materialization and release projections

Implement `materialize/`, deterministic projection ids, projection manifests, drift classification, projection-tree locking, generated copies for runtime surfaces that fail ARCH-51's symlink conditions, Claude agent projection, Claude command projection, skill projection/stripping, `snapshot/`, the release capability snapshot, `dotbabel models snapshot`, plugin baseline generation from KD-3, the generated `ai-review.yml` source and KD-6 projection, `build-plugin --check` integration, and `dotbabel-check-project-sync` integration. This phase also defines the ownership contract needed to replace the existing "skip if file exists" behavior for generated agent files (`plugins/dotbabel/src/bootstrap-global.mjs:224-226`) without overwriting genuine user-owned files blindly. **Depends on:** Phase 3. Two major parallel tracks once the resolver result contract is stable:

```text
Track A — local/runtime projection          Track B — deterministic release projection
materialize/                                snapshot/
projection manifest                         plugin baseline
drift                                       ai-review workflow generation
sync/bootstrap integration                  build checks
```

They converge on the same projection/provenance contract.

### Phase 5 — Canonical artifact migration

Enable `dotbabel models migrate --write` and migrate existing model-aware artifacts from legacy metadata to canonical `dotbabel.compute`. Migration follows the classifications and owner decisions from DOC-1 rather than applying one mechanical transformation to every artifact, and it preserves PB-1 through PB-13. Recommended migration order:

1. explicit inherit / already-neutral cases;
2. unambiguous semantic requirements;
3. dynamic requirements;
4. intentional pins and safety floors, preserving their effective behavior;
5. coordinator/worker cases requiring separate binding semantics;
6. class-F / owner-decision cases last and only after explicit resolution.

- **IMPL-2**: Safety-sensitive entries do not lose their existing effective floor during migration. Each migration batch passes schema validation, compatibility checks, projection regeneration, drift checks, and runtime-specific fixture/integration tests.

**Depends on:** Phase 4. The repository does not need to migrate every artifact in one commit; small coherent batches are preferred.

### Phase 6 — Recommendation surfaces and runtime coverage

Complete the user-facing/advisory layer: `recommend/`, `dotbabel models recommend`, runtime/session observation integration, handoff observation fixes (`plugins/dotbabel/scripts/handoff-extract.sh`), remaining runtime adapters, Copilot agent projection if RQ-3 verifies it, Codex/Antigravity/OpenCode binding support where RQ-4 verifies it, the Gemini adapter, richer status/doctor reporting, and stale release-baseline reporting for plugin and initialized workflow copies (ARCH-43, KD-6 evidence notes). Recommendation remains advisory and never changes the active model automatically (ARCH-10). **Depends on:** Phase 3 for recommendation logic. It does **not** need to wait for Phase 5 to begin:

```text
after Phase 3
   ├── Phase 4 projection infrastructure
   └── Phase 6A recommendation/observation work

after Phase 4
   ├── Phase 5 artifact migration
   └── Phase 6B remaining projection-capable adapters
```

The final runtime adapters may also begin during Phases 2–4 once their research item is resolved. Phase 6 is when full supported-runtime coverage becomes a completion requirement, not the first point at which their code may exist.

### Parallelism summary

Critical path:

```text
QA mutation work lands → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
```

Parallel work:

```text
Phase 0 research                 ║ runs alongside QA work
Phase 2 adapter implementations  ║ run alongside one another
Phase 4 local projection         ║ release snapshot/projection
Phase 6 recommendation           ║ may begin after Phase 3 while Phase 4 proceeds
Phase 5 migration                ║ remaining runtime coverage after Phase 4
```

- **IMPL-3**: No recommendation surface introduces independent selection logic merely to progress in parallel; it consumes the Phase 3 resolver (ARCH-57 rule 2). No runtime adapter blocks the critical path unless that runtime is required to preserve an existing behavior being migrated in the current phase.

## 6.2 Workstream Breakdown

Decided by the owner on 2026-09-18. Workstreams are organized around stable interface contracts rather than repository directories alone. Each workstream may progress independently once the contracts it consumes are stable.

| Workstream                                    | Phases                  | Provides                                                                                            | Consumes                                                                           |
| --------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **W0 — Research and Runtime Evidence**        | 0, continuing as needed | Verified runtime/source behavior, closed RQs, adapter-contract evidence                             | DOC-1, DOC-2, external/runtime experiments                                         |
| **W1 — Requirement and Compatibility**        | 1                       | `NormalizedComputeRequirement`, legacy interpretation, migration analysis                           | `dotbabel.compute` schema, `domain/` types                                         |
| **W2 — Sources and Catalog**                  | 2, 6                    | `SourceAdapterDescriptor`, `AdapterResult`, observations, normalized `CatalogEvidence`, cache state | `domain/` types, W0 evidence                                                       |
| **W3 — Policy**                               | 2                       | `EffectivePolicy` with provenance, workload/floor semantics                                         | `domain/` types, shipped/user/project/artifact policy inputs                       |
| **W4 — Resolver**                             | 3                       | `ResolverResult`, enforcement state, reasons, diagnostics                                           | W1 requirement, W2 catalog/runtime contract, W3 policy                             |
| **W5 — Materialization and Local Projection** | 4A                      | Runtime projection contract, projection manifest, drift state, local generated artifacts            | W4 `ResolverResult`, W2 runtime binding contract                                   |
| **W6 — Snapshot and Release Projection**      | 4B                      | Release capability snapshot, plugin baselines, generated workflow projection                        | W2 source evidence, W3 policy, W4 resolver, W5 materialization/provenance contract |
| **W7 — Canonical Migration**                  | 5                       | Migrated canonical artifacts using `dotbabel.compute`                                               | W1 compat/migration logic, W4 resolver semantics, W5/W6 projection guarantees      |
| **W8 — Recommendation and Advisory**          | 6, may start after 3    | Recommendation envelope and human/runtime advice                                                    | W4 `ResolverResult`, W2 observation results                                        |
| **W9 — CLI Integration**                      | 1–6                     | `dotbabel models` verbs, JSON rendering, exit-code mapping                                          | Public contracts from W1–W8                                                        |

### W0 — Research and Runtime Evidence

W0 closes uncertainty before implementation depends on it. Its outputs are evidence, not production selection logic: official model API / Models.dev contracts; Copilot custom-agent and `.prompt.md` behavior; Codex, Antigravity, and OpenCode skill binding; future runtime behavior requiring adapter-contract revision. W0 may run ahead of implementation, but no runtime behavior becomes `supported` in W2 merely because documentation suggests it; evidence must meet the adapter verification standard of §5 (ARCH-44).

### W1 — Requirement and Compatibility

W1 owns the canonical interpretation boundary: artifact YAML/frontmatter in, `NormalizedComputeRequirement` out. W1 does not resolve models. It establishes canonical parsing, schema validation, legacy `model:` / `effort:` interpretation, dual-declaration mismatch detection, and ambiguous legacy-state reporting. W4 and W7 consume W1 output rather than reparsing artifact compute metadata independently (ARCH-58).

### W2 — Sources and Catalog

W2 owns external evidence and normalization. It provides two distinct kinds of data: source/runtime evidence → `CatalogEvidence`, and runtime observation → `ObservedEffectiveConfiguration`. Observation remains part of the runtime adapter contract from §5 (ARCH-13). W8 consumes those observations but does not implement subprocess/network observation independently. This preserves `facts → W2`, `selection → W4`, `advice → W8`. W2 also owns cache concurrency and freshness normalization before data reaches W4.

### W3 — Policy

W3 owns Dotbabel judgment. It provides `EffectivePolicy`, including semantic workload classes, floor rules, safety constraints, user/project overrides, and the provenance of each effective policy contribution. W3 does not know how to invoke a runtime and does not select a concrete model.

### W4 — Resolver

W4 is the central decision boundary. It consumes only explicit data contracts — W1 `NormalizedComputeRequirement`, W2 `CapabilityCatalogSnapshot` / `RuntimeCapabilityContract` / observation, W3 `EffectivePolicy` — and returns `ResolverResult`. W4 performs no I/O. Its contract stabilizes before W5, W6, and W8 depend on it.

### W5 — Materialization and Local Projection

W5 owns runtime artifact generation: the materialization API, deterministic projection id, manifest schema, provenance marker, drift classification, projection ownership, and local bootstrap/sync integration. W5 does not independently call discovery or classify model strength. It consumes a completed `ResolverResult` and a verified runtime binding contract.

### W6 — Snapshot and Release Projection

W6 owns deterministic release-time projections: release snapshot generation/validation, snapshot identity, the Claude plugin baseline, the canonical/generated `ai-review.yml`, and package build integration. W6 shares the **materialization/provenance contract** defined by W5, and it does not depend on the implementation details of local sync. The dependency is the W5 projection contract, not the W5 local filesystem workflow. This allows Phase 4A and 4B to proceed in parallel.

### W7 — Canonical Migration

W7 changes the authored artifacts. It consumes the completed compatibility, resolver, and projection contracts so migration cannot create artifacts that the runtime layer cannot safely materialize. W7 owns migration batching, class mapping from DOC-1, preserved behavior verification, `migrate --write`, and removal of transitional legacy declarations where safe. It does not invent new semantic mappings outside W1/W3 policy.

### W8 — Recommendation and Advisory

W8 is a presentation/advisory layer: `ResolverResult` plus optional `ObservedEffectiveConfiguration` from W2 in, `RecommendationEnvelope` out. It may report the current configuration, the required configuration, the recommended invocation, the enforcement state, and why the recommendation differs. It never runs a second model-selection algorithm, performs its own discovery, or silently changes runtime configuration (ARCH-10, ARCH-57 rule 2).

### W9 — CLI Integration

- **IMPL-4**: W9 is one persistent cross-phase integration workstream. There is no separate CLI workstream per phase. Each phase exposes only the verbs whose underlying library contract has become stable: library capability lands → tests stabilize → CLI verb exposes it. A CLI verb never implements missing library behavior itself.

| Phase   | CLI delivered                                        |
| ------- | ---------------------------------------------------- |
| Phase 1 | `models migrate` dry-run / `--json`                  |
| Phase 2 | `models refresh`, `models status`                    |
| Phase 3 | `models resolve`                                     |
| Phase 4 | `models snapshot`; projection/status extensions      |
| Phase 5 | `models migrate --write`, migration `--check`        |
| Phase 6 | `models recommend`, richer observation/status output |

The CLI is an adapter over library APIs. It owns argument parsing, command orchestration, human-readable rendering, JSON rendering, and exit-code translation. It does not own artifact parsing semantics, source discovery logic, model selection, policy, or projection algorithms.

### Contract stability

- **IMPL-5**: A workstream may depend on another workstream's **interface contract** before that workstream is fully complete, provided the consumed contract has fixture coverage. W4 may develop against fixed W1/W2/W3 fixtures while runtime adapters are still being implemented; W8 may develop against `ResolverResult` and observation fixtures while Phase 4 materialization proceeds independently. This is the primary mechanism for safe parallel implementation (TEST-1).

### Workstream dependency graph

```text
                 W0 Research
                  │      │
                  ▼      ▼
        W1 Requirement   W2 Sources ─────┐
               │            │            │
               │          W3 Policy      │
               │            │            │
               └────────────┼────────────┘
                            ▼
                         W4 Resolver
                        /     |      \
                       ▼      ▼       ▼
                     W5      W6      W8
                      \       /
                       \     /
                         W7

W9 CLI integrates each stable contract incrementally across all phases.
```

W5 and W6 share a projection contract but remain separate parallel execution tracks. W8 can begin once W4 is stable and does not wait for W5–W7. W9 remains thin throughout the rollout.

## 6.3 Prompt Sequence

**Approved by the owner on 2026-09-18**, after a review against §5, §6.1, §6.2, §6.4, and §7. Drafted from §5, §6.1, and §6.2 under the owner's unit sequence and prompt structure. One prompt per module-sized implementation unit: one coherent contract, one primary behavior change, and a test suite that goes red → green without unfinished neighboring modules.

Conventions used by every prompt:

- **Paths.** Library code lives under `plugins/dotbabel/src/model-intelligence/<module>/`. Vitest files live under `plugins/dotbabel/tests/` and are named `model-intelligence-<unit>.test.mjs`. Bats files live under `plugins/dotbabel/tests/bats/` and are named `models-<unit>.bats`. Fixtures live under `plugins/dotbabel/tests/fixtures/model-intelligence/`.
- **Commands.** Narrow test: `npx vitest run plugins/dotbabel/tests/<file>`. Bats: `bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/<file>`. Lint: `npm run lint`. Broader regression: `npm test`, then `npm run build-plugin -- --check` and `node plugins/dotbabel/bin/dotbabel-check-project-sync.mjs` where a prompt touches generated output.
- **Command recommendation.** `/plan` for a unit that adds one module against a fixed contract; `/think` for a unit that composes several contracts or touches shell behavior.
- **Spec reads.** Every prompt reads the §5 contract it implements. The paths below are relative to the repository root, and `docs/specs/model-intelligence/` is written `SPEC/`.
- **Mutation.** A unit named in TEST-3 runs `npx stryker run --mutate '<glob for that unit>'` in its verify step, as the existing `stryker.config.mjs` prescribes, against its break threshold of 85.
- **Tier 2 and Tier 3 gates.** `vitest.config.mjs` includes every `plugins/dotbabel/tests/**/*.test.mjs`, so a real-runtime test lives at `plugins/dotbabel/tests/integration/model-intelligence-<name>.integration.test.mjs` and reports itself as `skipped` without the relevant variable (TEST-4, TEST-5). `DOTBABEL_MODELS_INTEGRATION=1` enables Tier 2 installed-runtime integration tests. `DOTBABEL_MODELS_TIER3=1` enables Tier 3 network/authenticated/model-executing tests and means that the caller has intentionally opted into the external side effects that TEST-5 describes. The prefix is `MODELS` because `models` is the stable public CLI namespace of §5, while `MI` is an implementation abbreviation. A Tier 3 test may additionally require source/runtime-specific credentials or prerequisites; the switch grants permission to attempt the tier, not proof that those prerequisites exist.
- **Temp directories.** Every test that writes files takes its directory from `plugins/dotbabel/tests/fixtures/temp-dir.mjs`, as the suite's tempdir hygiene requires.
- **§7 ownership.** PERF-1 → P-11; PERF-2 → P-13; PERF-3 → P-16; REL-1 → P-5; REL-2, REL-3, REL-4, OPS-2 → P-9; REL-5 → P-9 and P-23; REL-6, REL-7 → P-11; OPS-1, SEC-5 → P-15; OPS-3, SEC-6 → P-23; OPS-4 → P-5 and P-23; SEC-1 → P-6, P-7, P-22; SEC-2, SEC-4 → P-13; SEC-3 → P-8.
- **Landing.** A unit reaches `main` only through `/pr-conductor` (IMPL-12). IMPL-15 states when two units may share one pull request, and IMPL-13 with IMPL-18 fixes how the review fleet is chosen, so neither is an implementer's judgement call.
- **Rules.** TEST-6: each behavior is tested at the lowest deterministic layer that can prove it. IMPL-4: a CLI slice ships in the prompt that makes its verb usable, and the final CLI prompt only consolidates. IMPL-5: a unit may consume a neighbor's contract through fixtures before the neighbor is complete. TEST-1 and TEST-2: no prompt depends on a live provider API or a mutable catalog; live discovery is an integration test only.

### P-1 — Domain vocabulary (`domain/`) — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-domain.test.mjs`
   - `exports frozen enums for workload classes, bindings, modes, support states, result statuses, freshness, refresh states, and enforcement states`
   - `workload classes are ordered mechanical < routine < deep < frontier < exceptional and compare by rank only`
   - `each vocabulary has unique values, and support state, adapter status, and freshness are separate vocabularies` (the first draft of this name required disjoint vocabularies, which contradicts §5: `unsupported` and `unknown` occur in more than one dimension on purpose)
   - `runtime ids come from the RUNTIMES registry and are not redeclared` (ARCH-58)
   - `domain module has no import of node:fs, node:child_process, node:http, or node:os`
   - `Provenance and ResolvedRuntimeConfiguration constructors reject unknown fields`
   - Expected before implementation: the module does not exist; every test fails on import.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (all enums); `SPEC/spec/4-data-flow-components.md` (`Component Boundaries`, `domain/`); `plugins/dotbabel/src/quality/types.mjs` (frozen-vocabulary precedent); `plugins/dotbabel/src/lib/errors.mjs` (error taxonomy to extend); `plugins/dotbabel/src/agents.mjs:96-241` (runtime ids, reused rather than redeclared).
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/domain/index.mjs` with the frozen vocabularies of §5, the `Provenance`, `NormalizedComputeRequirement`, `AdapterResult`, `CatalogEvidence`, `ResolverResult`, and `ResolvedRuntimeConfiguration` shapes, and the Model Intelligence error codes. Runtime ids come from `RUNTIMES` (ARCH-58). Constraints: ARCH-56 (`domain/` has no I/O), ARCH-57. Out of scope: parsing, policy, any adapter.
4. **Commands** — narrow test; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the five named tests pass; no drift check applies; Bats not required.

### P-2 — `dotbabel.compute` schema and requirement parser (`requirement/`) — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-requirement.test.mjs`
   - `parses a dynamic declaration into a NormalizedComputeRequirement with provenance`
   - `rejects an unknown key inside dotbabel.compute (additionalProperties false)`
   - `requires requirement for dynamic, floor, and pin and forbids it for inherit`
   - `requires pin only for mode pin and validates pin.runtime against RUNTIMES ids`
   - `rejects an empty pin.config object`
   - `treats an artifact with no dotbabel key as having no canonical declaration`
   - `reads a nested dotbabel mapping through js-yaml where the line parser would flatten it`
   - Expected before implementation: no schema file and no module; all tests fail.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Artifact Declaration`); `schemas/skill.schema.json`; `plugins/dotbabel/src/build-index.mjs:42-48,441-472` (js-yaml loading and AJV compilation); `plugins/dotbabel/src/validate-skills-inventory.mjs:32-62` (the parser that must not be extended); `plugins/dotbabel/tests/build-index.test.mjs:441-487` (schema test precedent).
3. **Implement** — create `schemas/dotbabel.compute.schema.json` (strict, conditional by mode) and `plugins/dotbabel/src/model-intelligence/requirement/index.mjs` with `parseComputeDeclaration(frontmatter, {sourcePath})` → `NormalizedComputeRequirement | null` and a validation error list. Reference the new schema from the three artifact schemas under the optional `dotbabel` property. Constraints: KD-1, ARCH-56 (parsing over supplied data, no filesystem ownership). Out of scope: legacy `model:`/`effort:` interpretation, conflict detection with legacy keys, any CLI verb.
4. **Commands** — narrow test; `npx vitest run plugins/dotbabel/tests/build-index.test.mjs`; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the seven named tests pass; `node plugins/dotbabel/bin/dotbabel-index.mjs --check` still passes on the unchanged artifacts; Bats not required.

### P-3 — Legacy compatibility and migration analysis (`compat/`, `migrate` dry-run) — `/think`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-compat.test.mjs`
   - `maps a legacy agent model alias to a legacy-derived requirement with provenance kind legacy`
   - `interprets legacy model and effort on a skill as a consumer-binding requirement and never as a native binding` (ARCH-37)
   - `reports a conflict when dotbabel.compute and legacy model disagree in known meaning`
   - `does not report a conflict when the legacy value is a synchronized projection of the declaration`
   - `leaves an ambiguous legacy declaration explicit with an ambiguity code`
   - `migration analysis reports each fixture artifact as mapped, inherit, ambiguous, or conflict, proposes a declaration for the mapped ones, and writes nothing`
   - `plugins/dotbabel/tests/bats/models-migrate-dryrun.bats`: `models migrate: exits 0, prints the analysis, and leaves the tree unchanged`
   - Expected before implementation: module missing; the bats test fails because the verb does not exist.
2. **Read first** — `SPEC/spec/4-data-flow-components.md` (KD-1 dual-declaration rule, ARCH-18); `SPEC/current-state/analysis.md` (PB-1 to PB-13); `docs/audits/model-selection-audit.md` (`Migration Classification`); `plugins/dotbabel/src/model-intelligence/requirement/index.mjs`; `plugins/dotbabel/bin/dotbabel.mjs:30-50` (subcommand registration).
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/compat/index.mjs` (`interpretLegacy`, `detectDualDeclarationConflict`, `analyzeMigration`), `plugins/dotbabel/bin/dotbabel-models.mjs` with the `migrate` verb in dry-run and `--json` only, and register `models` in `plugins/dotbabel/bin/dotbabel.mjs`. Constraints: ARCH-18, ARCH-19, KD-1 rules 1–5, exit codes of §5. Out of scope: `--write`, `--check`, any resolution.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`; `npx stryker run --mutate 'plugins/dotbabel/src/model-intelligence/compat/**/*.mjs'`.
5. **Acceptance evidence** — the six vitest names and the bats test pass; `git status --short` shows no artifact change after the dry run; Bats required.

### P-4 — Policy loading and precedence (`policy/`) — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-policy.test.mjs`
   - `merges shipped, user, project, and artifact layers and records the layer of each effective value`
   - `composes floors by taking the strongest applicable minimum`
   - `keeps a shadowed lower-scope pin in the effective policy with a shadowed marker`
   - `rejects a provider model name inside shipped policy`
   - `reads user policy from configDir() and project policy from .dotbabel.json without mutating either`
   - Expected before implementation: module missing.
2. **Read first** — `SPEC/spec/3-high-level-architecture.md` (`Data Stores`, ARCH-15, ARCH-23); `SPEC/spec/5-interfaces-apis.md` (`Resolver Contract`, `Policy`); `plugins/dotbabel/src/quality/config.mjs:166-189` (layered merge with provenance, precedent only); `plugins/dotbabel/src/lib/paths.mjs:40-51`; `schemas/dotbabel.config.schema.json`.
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/policy/index.mjs` (`loadPolicyLayers` as the only I/O, `mergePolicy` pure) and `plugins/dotbabel/src/model-intelligence/policy/shipped.json` with the five workload classes, the capability rules that satisfy each class, and the resolver preferences; it names no artifact and no provider model. Add the `model_intelligence` object to `schemas/dotbabel.config.schema.json` (§5, `Project configuration namespace`). Constraints: ARCH-15, ARCH-22, ARCH-23, ARCH-57 rule 6. Out of scope: concrete model resolution, catalog reads.
4. **Commands** — narrow test; `npx vitest run plugins/dotbabel/tests/dotbabel-config-schema.test.mjs`; `npm run lint`; `npm test`; `npx stryker run --mutate 'plugins/dotbabel/src/model-intelligence/policy/**/*.mjs'`.
5. **Acceptance evidence** — the five named tests pass; Bats not required.

### P-5 — Source adapter contract and fixtures (`sources/contract`) — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-adapter-contract.test.mjs`
   - `validates a SourceAdapterDescriptor and rejects a binding axis with a value outside supported, unsupported, unverified`
   - `an AdapterResult carries provenance even when status is unavailable`
   - `contract fixture: exit 0 with empty output is unknown, not ok`
   - `contract fixture: a knowledge-source adapter declares binding {} and observation unsupported`
   - `unverified is never coerced to supported by the registry`
   - `an operation with no declared timeout gets 10 seconds for a subprocess and 20 seconds for a network call, and expiry returns unavailable with code timeout and retryable true` (REL-1)
   - `a diagnostic built from a command line or environment that holds a secret is redacted before it leaves the adapter` (OPS-4)
   - Expected before implementation: no contract module; the fixture files do not exist.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Source Adapter Contract`); `plugins/dotbabel/src/quality/adapters/registry.mjs` and `shared.mjs` (registry precedent); `plugins/dotbabel/src/model-intelligence/domain/index.mjs`; `SPEC/spec/3-high-level-architecture.md` (ARCH-12, ARCH-25, ARCH-50).
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/sources/contract.mjs` (descriptor validation, `AdapterResult` helpers, the registry) and the fixture set `plugins/dotbabel/tests/fixtures/model-intelligence/adapter-contract/`. Constraints: the three independent dimensions of §5, ARCH-44. Out of scope: any real adapter.
4. **Commands** — narrow test; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the five named tests pass; Bats not required.

### P-6 — Claude source adapter — `/think`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-adapter-claude.test.mjs`
   - `descriptor: discovery unsupported, observation may-execute-model, agent binding supported for model and reasoning, skill binding unsupported, command binding supported for model`
   - `observe() parses system/init.model and result.modelUsage from a stream-json fixture into ObservedEffectiveConfiguration`
   - `observe() returns unavailable with diagnostic binary_missing when the CLI is absent`
   - `validate() accepts the stable aliases and rejects an unknown alias with the runtime's own rejection text`
   - `renderInvocation() returns structured argv for --model and --effort before any shell string`
   - `the adapter never writes under the runtime configuration root during discover, observe, or validate` (SEC-1)
   - Tier 2, `plugins/dotbabel/tests/integration/model-intelligence-claude.integration.test.mjs`: CLI presence/version, accepted model and effort syntax without a model turn, and the unsupported enumeration classification; the observation case that needs a model turn runs only under Tier 3; it reports the tested CLI version and self-skips when the runtime is absent (TEST-4)
   - Expected before implementation: adapter missing.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Source Adapter Contract`, `Adapter result`); `docs/audits/model-runtime-capability-investigation.md` (`Claude Code` under `Frontmatter Behaviour`, `Model Discovery`, `Precedence, derived`); `plugins/dotbabel/src/model-intelligence/sources/contract.mjs`; `plugins/dotbabel/scripts/handoff-extract.sh:60-100` (existing Claude JSONL reading); `plugins/dotbabel/src/agents.mjs:96-108`.
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/sources/runtime/claude.mjs` and fixtures under `plugins/dotbabel/tests/fixtures/model-intelligence/claude/`. Constraints: ARCH-13, ARCH-17, ARCH-47, ARCH-49; `execution: may-execute-model` on observation. Out of scope: running a billable turn in tests (TEST-2), catalog persistence.
4. **Commands** — narrow test; `npm run lint`; `npm test`; `DOTBABEL_MODELS_INTEGRATION=1 npx vitest run plugins/dotbabel/tests/integration/model-intelligence-claude.integration.test.mjs` where the runtime is installed.
5. **Acceptance evidence** — the five named tests pass on fixtures; Bats not required. The Tier 2 file passes or reports `skipped`, never a silent pass.

### P-7 — Codex source adapter — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-adapter-codex.test.mjs`
   - `descriptor: discovery supported, network never, auth none, cacheable true, execution read-only`
   - `discover() parses the codex debug models fixture into per-model supported_reasoning_levels`
   - `discover() reports models that do not support max so a max requirement can be refused`
   - `observe() reads the resolved model and provider from the exec banner fixture without network`
   - `validate() uses --strict-config recognition and reports version_unsupported when the flag is absent`
   - `the adapter never writes under the runtime configuration root during discover, observe, or validate` (SEC-1)
   - Tier 2, `plugins/dotbabel/tests/integration/model-intelligence-codex.integration.test.mjs`: `codex debug models` parsing, supported reasoning levels, and offline/no-credential behavior; it reports the tested CLI version and self-skips when the runtime is absent (TEST-4)
   - Expected before implementation: adapter missing.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Source Adapter Contract`); `docs/audits/model-runtime-capability-investigation.md` (`Codex CLI` under `Model Discovery`, `Reproduction Commands`); `plugins/dotbabel/src/model-intelligence/sources/contract.mjs`; `plugins/dotbabel/scripts/handoff-extract.sh:260-290` (the provider-in-model-field defect to avoid); `plugins/dotbabel/src/agents.mjs:109-121`.
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/sources/runtime/codex.mjs` and fixtures under `plugins/dotbabel/tests/fixtures/model-intelligence/codex/`. Constraints: ARCH-1 (effort support is per model), ARCH-2 (provider is a field, not the model), ARCH-28. Out of scope: skill binding (RQ-4 leaves it unverified).
4. **Commands** — narrow test; `npm run lint`; `npm test`; `DOTBABEL_MODELS_INTEGRATION=1 npx vitest run plugins/dotbabel/tests/integration/model-intelligence-codex.integration.test.mjs` where the runtime is installed.
5. **Acceptance evidence** — the five named tests pass on fixtures; Bats not required. The Tier 2 file passes or reports `skipped`, never a silent pass.

### P-8 — Knowledge-source adapters from RQ-1 — `/plan`, one prompt per source

Blocked until RQ-1 closes (IMPL-1). Split into `P-8a` Models.dev and `P-8b` official provider APIs if their behavior differs materially.

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-adapter-<source>.test.mjs`
   - `descriptor: kind knowledge-source, discovery network required, observation unsupported, binding {}`
   - `discover() normalizes the recorded response fixture into field-level facts with sourceVersion`
   - `discover() returns unavailable with network_unavailable when the fetch is refused, and never throws`
   - `a catalog fact from this source never carries availability available`
   - `refuses a non-HTTPS source URL outside an injected fixture and sends no Dotbabel credential to a public source` (SEC-3)
   - `rejects or reduces a response that would exceed the 8 MiB per-entry limit` (OPS-2, SEC-3)
   - Expected before implementation: adapter missing.
2. **Read first** — `SPEC/spec/3-high-level-architecture.md` (`External APIs / Dependencies`, ARCH-21, ARCH-24); `SPEC/research/sources.md` (RQ-1 result); `plugins/dotbabel/src/model-intelligence/sources/contract.mjs`; the recorded response fixture; `plugins/dotbabel/src/lib/handoff-remote.mjs` (existing network helper conventions).
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/sources/knowledge/<source>.mjs`. Constraints: ARCH-14, ARCH-21, ARCH-24, no credential handling (§2). Out of scope: cache persistence, authority ranking.
4. **Commands** — narrow test; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the four named tests pass on recorded fixtures (TEST-1); Bats not required.

### P-9 — Catalog normalization, cache, and refresh locking (`catalog/`, `refresh`, `status`) — `/think`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-catalog.test.mjs`
   - `merges two sources for one model and keeps a separate provenance for each field`
   - `derives freshness from observedAt, source policy, and an injected now`
   - `a failed or empty refresh preserves the previous valid cache and marks it stale`
   - `the second concurrent refresh of one key does not start and reports refresh in_progress`
   - `writes the cache with temp file plus atomic rename under cacheDir()/model-intelligence`
   - `a stale lock whose owner pid is dead is recovered only by the conservative rule`
   - `plugins/dotbabel/tests/bats/models-refresh-status.bats`: `models status: exits 0 with no cache and no runtimes` and `models refresh: exits 2 when a required source is unavailable and no cache exists`
   - property (TEST-7): `for any order of refresh outcomes, a failed, malformed, empty, or older candidate never replaces a structurally valid newer entry` (REL-2)
   - `a lock younger than 10 minutes is never removed; an older lock is removed only when the owner pid is dead or the pid was reused; a lock from another host needs manual recovery` (REL-3)
   - `applies the REL-4 default windows per evidence class when a source declares none, and never reports expired evidence as fresh after a failed refresh`
   - `keeps the cache tree at or under 64 MiB after maintenance without evicting the last valid evidence, and refuses an entry above 8 MiB` (OPS-2)
   - torture (TEST-8): `many simultaneous refreshes of one key run exactly one discovery`
   - `with the network down and no cache, a Dotbabel command outside Model Intelligence behaves as before` (REL-5)
   - Expected before implementation: module missing; the two verbs do not exist.
2. **Read first** — `SPEC/spec/4-data-flow-components.md` (`Shared State`, ARCH-59 to ARCH-65); `SPEC/spec/5-interfaces-apis.md` (`Catalog evidence envelope`, `Freshness is separate`, `Refresh state is separate`); `plugins/dotbabel/src/lib/handoff-preflight.mjs:93-110` (`writeCacheAtomic`); `plugins/dotbabel/src/lib/paths.mjs:45-55`; `plugins/dotbabel/src/model-intelligence/sources/contract.mjs`.
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/catalog/index.mjs`, `catalog/cache.mjs`, `catalog/lock.mjs`; add the `refresh` and `status` verbs to `plugins/dotbabel/bin/dotbabel-models.mjs`. Constraints: ARCH-28, ARCH-30, ARCH-59, ARCH-60, ARCH-61, ARCH-65. P-9 consumes adapter output through fixtures and does not wait for P-8 (IMPL-3, IMPL-5). Out of scope: resolution, snapshot, drift of generated files.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the six vitest names and the two bats tests pass; Bats required.

### P-10 — Resolver: constraint composition (`resolver/`) — `/think`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-resolver-composition.test.mjs`
   - `inherit contributes no constraint and keeps a user pin effective`
   - `a dynamic requirement accepts a user pin that satisfies it and reports conflict when it does not`
   - `floors compose to the strongest applicable minimum across shipped, project, and artifact`
   - `an artifact pin overrides a user or project pin and records the shadowed pin` (ARCH-66)
   - `an invocation pin below an artifact floor returns conflict with enforcement unsatisfied` (ARCH-67)
   - `an unavailable pin returns unresolved and never substitutes`
   - `identical inputs produce a deep-equal result across 100 runs`
   - `the module imports nothing from node:fs, node:child_process, or the sources directory`
   - property (TEST-7): `floor monotonicity — strengthening a floor never makes a previously too-weak configuration valid`
   - property (TEST-7): `pin safety — a pin below an effective floor is never a successful resolution, for any precedence`
   - property (TEST-7): `inheritance neutrality — adding an inherit declaration changes no requirement`
   - Expected before implementation: module missing.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Resolver Contract`, whole section); `SPEC/spec/4-data-flow-components.md` (`Component Boundaries`, ARCH-56, ARCH-57); `plugins/dotbabel/src/model-intelligence/policy/index.mjs`; `plugins/dotbabel/src/model-intelligence/domain/index.mjs`; fixtures under `plugins/dotbabel/tests/fixtures/model-intelligence/catalog/`.
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/resolver/compose.mjs` and `resolver/index.mjs` with `resolve(input)` returning `status` and `configuration` only; enforcement and explanation are stubbed to `unknown` and `[]` for this unit. Constraints: ARCH-16, ARCH-56, ARCH-66, ARCH-67, no `now` input. Out of scope: enforcement states, reasons, CLI.
4. **Commands** — narrow test; `npm run lint`; `npm test`; `npx stryker run --mutate 'plugins/dotbabel/src/model-intelligence/resolver/**/*.mjs'`.
5. **Acceptance evidence** — the eight named tests pass on fixtures; Bats not required.

### P-11 — Resolver: enforcement, confidence, explanation, `resolve` verb — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-resolver-explain.test.mjs`
   - `reports enforced with basis artifact-binding when the runtime contract binds the axis at the artifact kind`
   - `reports satisfied-not-enforced with basis session-observation when only the observed session satisfies a skill requirement`
   - `reports unsatisfied when the observed session is below a floor`
   - `reports unknown when neither binding nor observation exists, and never upgrades it`
   - `lowers confidence when stale evidence is used and records stale_evidence_used`
   - `explanation is ordered and every reason has a code`
   - `plugins/dotbabel/tests/bats/models-resolve.bats`: `models resolve: --json emits a ResolverResult and exit 1 on conflict`
   - performance (PERF-1): `resolve() p95 is at most 10 ms over 1,000 warmed calls on the 500-record six-runtime fixture, explanation included`
   - `provider-churn fixture: adding or removing a discoverable model changes the resolution with 0 source changes` (REL-6)
   - `every valid fixture case returns a structured result with no uncaught exception and no silent fallback` (REL-7)
   - Expected before implementation: enforcement is the P-10 stub.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Enforcement states`, `Confidence`, `Explanation`, `Diagnostics`, `CLI Surface` for `resolve`); `SPEC/spec/4-data-flow-components.md` (KD-4, ARCH-48); `plugins/dotbabel/src/model-intelligence/resolver/index.mjs`; `plugins/dotbabel/bin/dotbabel-models.mjs`; `plugins/dotbabel/src/quality/reporters.mjs` (rendering precedent).
3. **Implement** — create `resolver/enforcement.mjs` and `resolver/explain.mjs`; complete `resolver/index.mjs`; add the `resolve` verb with `--runtime`, `--requirement`, and `--json`. Constraints: ARCH-48, ARCH-49, exit codes of §5. Out of scope: recommendation prose, materialization.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`; `npx stryker run --mutate 'plugins/dotbabel/src/model-intelligence/resolver/**/*.mjs'`.
5. **Acceptance evidence** — the six vitest names and the bats test pass; Bats required.

### P-12 — Local materialization core (`materialize/`) — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-materialize-core.test.mjs`
   - `produces byte-identical output for identical inputs and contains no timestamp`
   - `writes the generated marker as the first line inside the frontmatter with projection id and source path`
   - `strips dotbabel.compute from the runtime-visible frontmatter unless the adapter contract permits it`
   - `projectionId changes when the runtime contract hash changes and the source does not`
   - `manifest entries carry the seven required provenance fields`
   - Expected before implementation: module missing.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Materialization and Provenance Contract`); `SPEC/spec/4-data-flow-components.md` (KD-5, ARCH-51, ARCH-52); `plugins/dotbabel/src/copilot-frontmatter.mjs:19-66,160-210` (marker and frontmatter rendering precedent); `plugins/dotbabel/src/model-intelligence/resolver/index.mjs`; `plugins/dotbabel/src/model-intelligence/sources/contract.mjs`.
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/materialize/render.mjs`, `materialize/manifest.mjs`, `materialize/index.mjs` (`materialize(inputs)` pure, returning files and manifest entries; no filesystem writes in this unit). Constraints: ARCH-45, ARCH-51, ARCH-68, ARCH-70. Out of scope: drift, locking, filesystem transaction, Claude-specific rules.
4. **Commands** — narrow test; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the five named tests pass; Bats not required.

### P-13 — Materialization drift and transaction; `project-sync` and check integration — `/think`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-materialize-drift.test.mjs`
   - `classifies clean, user drift, stale, diverged, missing, and orphan from output and input hashes`
   - `holds the projection-tree lock for the whole transaction and commits the manifest last`
   - `an interrupted transaction is detected and repaired on the next run`
   - `a user-edited generated file is reported as drift and never read back as policy`
   - `plugins/dotbabel/tests/bats/models-projection-sync.bats`: `project-sync: writes generated copies where a symlink fails ARCH-51 and check-project-sync reports drift after a manual edit`
   - torture (TEST-8): `two equivalent syncs racing`, `two syncs with different canonical inputs`, `interruption before the manifest commit`, `stale lock recovery`, and `file replacement while status reads` each end in one coherent generation
   - `refuses a destination that leaves its owning root through .., an absolute path, a symlink, or a manifest entry, and refuses a file not proven Dotbabel-owned` (SEC-2)
   - `never reads an edited generated file back into a requirement, policy, snapshot, or resolver constraint` (SEC-4)
   - performance (PERF-2): `project-sync p95 is at most 1.5 seconds over 10 warmed runs on the sync fixture with a warm cache and no network`
   - Expected before implementation: drift module missing; `check-project-sync` does not know the manifest.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Drift classification`, `Materialization transaction`); `SPEC/spec/4-data-flow-components.md` (`Shared State`, ARCH-62, ARCH-69); `plugins/dotbabel/src/project-sync.mjs`; `plugins/dotbabel/src/check-project-sync.mjs`; `plugins/dotbabel/tests/bats/project-sync.bats` (existing shell expectations).
3. **Implement** — create `materialize/drift.mjs`, `materialize/transaction.mjs`; extend `project-sync.mjs` and `check-project-sync.mjs` to call the library. Constraints: ARCH-52, ARCH-59, ARCH-62, ARCH-69. Out of scope: bootstrap user-scope changes, release snapshot.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`; `node plugins/dotbabel/bin/dotbabel-check-project-sync.mjs`; `npx stryker run --mutate 'plugins/dotbabel/src/model-intelligence/materialize/drift.mjs'`.
5. **Acceptance evidence** — the four vitest names and the bats test pass; `check-project-sync` passes on the unchanged repository; Bats required.

### P-14 — Claude runtime projections: agents, commands, skills — `/think`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-claude-projection.test.mjs`
   - `an agent with a dynamic requirement gets model and effort projected into the generated copy`
   - `a dynamic or floor command gets no model in the generated copy`
   - `a pinned command keeps its native model in the generated copy`
   - `a skill gets neither model nor effort and loses dotbabel.compute`
   - `an inherit declaration produces no concrete projection`
   - `plugins/dotbabel/tests/bats/models-bootstrap-claude.bats`: `bootstrap: replaces an agent copy that the manifest proves Dotbabel-owned and does not overwrite one that it cannot prove` (IMPL-6) and `bootstrap: a migrated skill is installed as a generated copy, not a symlink`
   - Tier 2, `plugins/dotbabel/tests/integration/model-intelligence-claude-projection.integration.test.mjs`: Claude Code accepts the generated agent, command, and skill frontmatter, and no runtime copy carries `dotbabel.compute`; any case that needs an inference turn runs only under Tier 3
   - Expected before implementation: projections do not exist; bootstrap still skips existing files.
2. **Read first** — `SPEC/spec/4-data-flow-components.md` (KD-2, KD-5, and the evidence notes); `SPEC/current-state/analysis.md` (PB-4, PB-7, PB-8, PB-10); `plugins/dotbabel/src/bootstrap-global.mjs:150-240`; `bootstrap.sh:170-200`; `plugins/dotbabel/tests/bats/bootstrap.bats`.
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/materialize/runtime/claude.mjs`; change the agent copy in `bootstrap-global.mjs` and `bootstrap.sh` to the ownership contract of ARCH-52 (generated copies replaced, user-owned files refused). Constraints: KD-2, ARCH-10, ARCH-37, ARCH-38, ARCH-51, PB-10. Out of scope: plugin templates, other runtimes.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`; `npx vitest run plugins/dotbabel/tests/bootstrap-sh-registry-parity.test.mjs`.
5. **Acceptance evidence** — the five vitest names and the two bats tests pass; Bats required because `bootstrap.sh` changes. The Tier 2 file passes or reports `skipped`.

### P-15 — Release snapshot (`snapshot/`, `snapshot --check/--write`) — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-snapshot.test.mjs`
   - `snapshotId is identical for two generations with the same facts and different observedAt`
   - `the snapshot rejects refresh_in_progress, TTL, and computed freshness fields`
   - `snapshot --write fails when a required Claude fact is unavailable and leaves the committed file untouched`
   - `snapshot --check reproduces the committed snapshotId with no network`
   - `plugins/dotbabel/tests/bats/models-snapshot.bats`: `models snapshot: default prints the diff and writes nothing; --check and --write are mutually exclusive (exit 64)`
   - `snapshot --check and status --check fail when a required release projection depends on evidence older than 7 days, and plain status still exits 0` (OPS-1)
   - `a snapshot whose declared snapshotId differs from the computed one is rejected and never rewritten by the build` (SEC-5)
   - Expected before implementation: module and file missing.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Release-Time Capability Snapshot`); `SPEC/spec/4-data-flow-components.md` (KD-3, ARCH-64); `plugins/dotbabel/src/model-intelligence/catalog/index.mjs`; `plugins/dotbabel/src/model-intelligence/catalog/lock.mjs`; `schemas/` (schema placement).
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/snapshot/index.mjs`, `schemas/dotbabel.release-capabilities.schema.json`, the first committed `plugins/dotbabel/src/model-intelligence/snapshot/release-capabilities.json` with the Claude section; add the `snapshot` verb. Constraints: ARCH-39, ARCH-64, ARCH-71, ARCH-72. Out of scope: template generation.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the four vitest names and the bats test pass; Bats required.

### P-16 — Plugin baseline generation (`build-plugin` integration) — `/think`

1. **Tests first** — `plugins/dotbabel/tests/build-plugin.test.mjs` (extend)
   - `writes a baseline model into a template agent whose requirement is a floor or pin`
   - `writes no model into a template agent whose requirement is dynamic with no floor`
   - `fails the build when the snapshot cannot satisfy a floor` (ARCH-41)
   - `--check is stable across two runs with no network`
   - `the manifest for templates/claude records snapshotId for every baseline`
   - performance (PERF-3): `the Model Intelligence phase adds at most 1.0 second to one build-plugin --check on the performance fixture`
   - Tier 2 post-release (TEST-9), `plugins/dotbabel/tests/integration/model-intelligence-plugin-baseline.integration.test.mjs`: Claude loads the built plugin, and `models status` names the shipped `snapshotId` and reports a fresher local resolution as distinct
   - Expected before implementation: `build-plugin` copies `model:` verbatim (`tests/build-plugin.test.mjs:372` passes today and must be revised, not deleted).
2. **Read first** — `SPEC/spec/4-data-flow-components.md` (KD-3, ARCH-39 to ARCH-43); `scripts/build-plugin.mjs`; `plugins/dotbabel/.claude-plugin/plugin.json`; `plugins/dotbabel/src/model-intelligence/snapshot/index.mjs`; `plugins/dotbabel/src/model-intelligence/materialize/runtime/claude.mjs`.
3. **Implement** — extend `scripts/build-plugin.mjs` to resolve each template agent against the committed snapshot and write the baseline through `materialize/`; add a `plugins/dotbabel/templates/claude/.dotbabel-projection.json` manifest. Constraints: ARCH-39, ARCH-41, ARCH-42, ARCH-43. Out of scope: workflow generation, local sync.
4. **Commands** — narrow test; `npm run build-plugin -- --check`; `npm run lint`; `npm test`; `bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/plugin-manifest.bats`.
5. **Acceptance evidence** — the five named tests pass; `build-plugin --check` exits 0 twice in a row; the existing `plugin-manifest.bats` still passes; Bats required for the manifest test only.

### P-17 — AI-review workflow generation (KD-6) — `/think`

1. **Tests first** — `plugins/dotbabel/tests/workflow-templates.test.mjs` (extend) and `plugins/dotbabel/tests/model-intelligence-workflow-projection.test.mjs`
   - `ai-review.compute.yml parses through requirement/ to binding session, and the generated ai-review.yml carries --model from the snapshot`
   - `ai-review.source.yml is valid workflow YAML with no model flag and no dotbabel key, and the generated file has no dotbabel key`
   - `the build fails rather than omitting --model when the snapshot cannot satisfy the requirement` (ARCH-55)
   - `the generated workflow keeps ANTHROPIC_API_KEY and @anthropic-ai/claude-code unchanged` (PB-6)
   - `examples/minimal-consumer receives the same generated copy`
   - `every action in the generated workflow stays pinned to a full commit SHA` (existing invariant)
   - post-release (TEST-9): `a repository initialized from the built package receives the generated workflow, status names its shipped baseline, and a later release does not claim that the installed copy changed`
   - Expected before implementation: no canonical source exists; the template is hand-authored.
2. **Read first** — `SPEC/spec/4-data-flow-components.md` (KD-6 and its evidence notes); `plugins/dotbabel/templates/workflows/ai-review.yml`; `examples/minimal-consumer/.github/workflows/ai-review.yml`; `plugins/dotbabel/tests/workflow-templates.test.mjs`; `plugins/dotbabel/src/init-harness-scaffold.mjs:1-30`.
3. **Implement** — create the two adjacent canonical inputs `plugins/dotbabel/src/model-intelligence/workflows/ai-review.source.yml` and `ai-review.compute.yml` (§5, `Declaration for an artifact without frontmatter`), and generate `plugins/dotbabel/templates/workflows/ai-review.yml` and the example consumer copy through `materialize/` in `build-plugin`. The source file is valid GitHub Actions YAML with no concrete model and no Dotbabel-private metadata. The sidecar holds the exact KD-1 declaration with `binding: session`; its `requirement` and `mode` come from the approved migration/policy decision, and the prompt does not invent them from a concrete Claude model. The generated workflow contains no `dotbabel.compute` metadata. Constraints: ARCH-53, ARCH-54, ARCH-55, PB-6. Out of scope: any runtime other than Claude, consumer re-init behavior (§6.5).
4. **Commands** — narrow tests; `npm run build-plugin -- --check`; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the five named tests pass; `build-plugin --check` exits 0; Bats not required.

### P-18 — Canonical migration write path (`migrate --write`, `--check`) — `/think`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-migrate-write.test.mjs`
   - `--write rewrites only unambiguous artifacts and leaves class-F artifacts untouched`
   - `--write keeps the legacy model on a floor artifact as a synchronized projection until KD-2 projection exists`
   - `--write never converts an omitted model or inherit into a concrete requirement` (PB-8)
   - `--check exits 1 when policy requires a migration that has not happened and 0 when the tree is compliant`
   - `--check and --write together exit 64`
   - `plugins/dotbabel/tests/bats/models-migrate-write.bats`: `models migrate --write: a batch passes index --check, validate-skills, build-plugin --check, and check-project-sync`
   - Expected before implementation: `--write` and `--check` are unknown flags.
2. **Read first** — `SPEC/spec/6-implementation-plan.md` (§6.1 Phase 5, IMPL-2, §6.5); `SPEC/current-state/analysis.md` (PB-1 to PB-13); `plugins/dotbabel/src/model-intelligence/compat/index.mjs`; `plugins/dotbabel/bin/dotbabel-models.mjs`; `plugins/dotbabel/src/validate-skills-inventory.mjs:260-320` (the gate that must keep passing).
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/compat/migrate.mjs` with batch selection by class and the write path; extend the `migrate` verb. Constraints: ARCH-18, IMPL-2, PB-7, PB-8. Out of scope: migrating the artifacts themselves (P-19).
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the five vitest names and the bats test pass on a fixture tree; the repository artifacts are unchanged after this prompt; Bats required.

### P-19 — Artifact migration batches — one prompt per batch, `/plan`

Each batch prompt has the same structure and differs in the artifact list. Batches in order: `P-19a` inherit and already-neutral (`local-attest` and the class-E entries of DOC-1); `P-19b` unambiguous semantic requirements (class C agents); `P-19c` dynamic requirements (class C skills and commands, class D); `P-19d` floors and pins (`security-auditor`, `security-engineer`, `security-review`, `veracity-audit`, `rollback-prod`; PB-1, PB-2, PB-3); `P-19e` coordinator/worker cases (`post-pr-review`, `agents-search`, `veracity-audit` topology); `P-19f` class-F owner decisions, only after each has an explicit decision recorded in §6.5.

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-migration-batches.test.mjs` (one `describe` per batch)
   - `<batch>: every artifact in the batch parses to the expected NormalizedComputeRequirement`
   - `<batch>: resolve() for claude reproduces the pre-migration effective model for every artifact` (the behavior-preservation oracle)
   - `P-19d: the security agents resolve to a floor of frontier and their generated copies still carry a strong model` (PB-1)
   - `P-19d: rollback-prod keeps the typed confirmation text unchanged` (PB-3)
   - `P-19a: local-attest still has no requirement and no projection` (PB-4)
   - Expected before implementation: the artifacts still carry legacy keys only.
2. **Read first** — `SPEC/current-state/analysis.md` (the PB list); `docs/audits/model-selection-audit.md` (`Migration Classification`, the batch's rows); the batch's artifact files; `plugins/dotbabel/src/model-intelligence/compat/migrate.mjs`; `SPEC/spec/6-implementation-plan.md` (§6.5).
3. **Implement** — run `dotbabel models migrate --write` restricted to the batch, review the diff by hand against the PB list, and regenerate projections. Constraints: IMPL-2, PB-1 to PB-13. Out of scope: any code change.
4. **Commands** — narrow test; `node plugins/dotbabel/bin/dotbabel-index.mjs --check`; `node plugins/dotbabel/bin/dotbabel-validate-skills.mjs`; `npm run build-plugin -- --check`; `node plugins/dotbabel/bin/dotbabel-check-project-sync.mjs`; `npm test`.
5. **Acceptance evidence** — the batch's named tests pass; all four generated/drift checks exit 0; Bats not required.

### P-20 — Recommendation layer (`recommend/`, `recommend` verb) — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-recommend.test.mjs`
   - `builds a recommendation envelope from a ResolverResult and an observation without calling resolve internals`
   - `reports escalation when the observed session is below the requirement and de-escalation when above`
   - `a differing recommendation exits 0 and changes nothing`
   - `the module imports nothing from sources or catalog`
   - `plugins/dotbabel/tests/bats/models-recommend.bats`: `models recommend: prints the invocation recipe and never writes a file`
   - Expected before implementation: module and verb missing.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`CLI Surface`, `recommend`); `SPEC/spec/3-high-level-architecture.md` (component 7, ARCH-10); `plugins/dotbabel/src/model-intelligence/resolver/index.mjs`; `plugins/dotbabel/src/model-intelligence/sources/runtime/claude.mjs` (`renderInvocation`); `plugins/dotbabel/bin/dotbabel-models.mjs`.
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/recommend/index.mjs`; add the `recommend` verb. Constraints: ARCH-10, ARCH-47, ARCH-57 rule 2, PB-9. Out of scope: observation collection.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the four vitest names and the bats test pass; Bats required.

### P-21 — Handoff observation integration — `/think`

1. **Tests first** — `plugins/dotbabel/tests/bats/handoff-extract.bats` (extend) and `plugins/dotbabel/tests/model-intelligence-handoff-observation.test.mjs`
   - `handoff-extract: claude reports the observed model from init.model instead of null`
   - `handoff-extract: codex reports the model and the provider in separate fields`
   - `handoff-extract: antigravity and opencode report observation unsupported rather than failing`
   - `the observation consumed by recommend equals the adapter observe() result for the same fixture`
   - Tier 2, `plugins/dotbabel/tests/integration/model-intelligence-handoff-observation.integration.test.mjs`: for each installed runtime whose adapter declares observation `supported`, the extracted model equals the adapter observation; model-executing cases run only under Tier 3
   - Expected before implementation: `handoff-extract.sh:84` writes `model: null` and `:275` writes the provider into `model`.
2. **Read first** — `SPEC/spec/2-scope.md` (`Boundaries`, the handoff paragraph); `SPEC/spec/3-high-level-architecture.md` (ARCH-13); `plugins/dotbabel/scripts/handoff-extract.sh`; `plugins/dotbabel/tests/bats/handoff-extract.bats`; `plugins/dotbabel/src/model-intelligence/sources/runtime/claude.mjs` and `codex.mjs`.
3. **Implement** — make `handoff-extract.sh` a consumer of the adapters' observation output (through a small node bridge) and add `provider` as its own field. Constraints: ARCH-13, ARCH-31, ARCH-58. Out of scope: handoff features unrelated to the model field.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`; `bash plugins/dotbabel/scripts/run-bats.sh plugins/dotbabel/tests/bats/handoff-regression.bats`.
5. **Acceptance evidence** — the four named tests pass; the existing handoff bats suite stays green; Bats required.

### P-22 — Remaining runtime adapters — one prompt per runtime, `/plan`

`P-22a` Gemini, `P-22b` Copilot, `P-22c` Antigravity, `P-22d` OpenCode. Each implements only the binding behavior that RQ-3 or RQ-4 established; everything else stays `unverified` or `unsupported`.

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-adapter-<runtime>.test.mjs`
   - `descriptor matches the measured capability row of DOC-2 for <runtime>`
   - `discover() parses the recorded fixture with the defensive rules of DOC-2` (Antigravity TSV with stderr banner; OpenCode exit 0 empty output → unknown; Copilot help text → human-only; Gemini none)
   - `binding for skill stays unsupported or unverified unless the RQ result says supported`
   - `renderInvocation() returns structured argv before any shell string`
   - `the adapter never writes under the runtime configuration root` (SEC-1)
   - Tier 2, `plugins/dotbabel/tests/integration/model-intelligence-<runtime>.integration.test.mjs`: the cases that §6.4 lists for the runtime, with OpenCode's exit-0/empty-output case as a named test (ARCH-30)
   - Expected before implementation: adapter missing.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`Source Adapter Contract`); `docs/audits/model-runtime-capability-investigation.md` (the runtime's `Model Discovery` and grammar sections); `SPEC/research/sources.md` (RQ-3 or RQ-4 result); `plugins/dotbabel/src/model-intelligence/sources/contract.mjs`; `plugins/dotbabel/src/agents.mjs` (the runtime's registry entry).
3. **Implement** — create `plugins/dotbabel/src/model-intelligence/sources/runtime/<runtime>.mjs` and, only where RQ-3 verified it, `materialize/runtime/copilot.mjs` for custom agents. Constraints: ARCH-17, ARCH-44, ARCH-46, ARCH-50. Out of scope: any binding without evidence.
4. **Commands** — narrow test; `npm run lint`; `npm test`.
5. **Acceptance evidence** — the four named tests pass on fixtures; Bats not required.

### P-23 — CLI consolidation (`dotbabel models`) — `/plan`

1. **Tests first** — `plugins/dotbabel/tests/model-intelligence-cli.test.mjs` and `plugins/dotbabel/tests/bats/models-cli.bats`
   - `every verb maps its domain state to the shared exit codes 0, 1, 2, and 64 as §5 defines`
   - `every read verb supports --json and the JSON parses to the documented envelope`
   - `dotbabel models and dotbabel-models produce identical output for the same arguments`
   - `--help lists the seven verbs with the same descriptions as the spec`
   - `models-cli.bats: an unknown runtime id exits 64 and a resolver conflict exits 1`
   - `every diagnostic the CLI can emit has a documented code, and the recorded --json envelopes of the previous patch release still parse with the same field meanings` (OPS-3)
   - `no verb adds a repository to the trust allowlist, and an operation that would run a project-controlled command without trust returns a structured trust-required result and runs nothing` (SEC-6)
   - `human and JSON output of every verb contain no credential, token, or account identifier from the fixtures that hold them` (OPS-4)
   - `with no network and no cache, every dotbabel subcommand outside models exits as it did before` (REL-5)
   - Expected before implementation: the verbs exist with per-verb rendering; parity and help text differ.
2. **Read first** — `SPEC/spec/5-interfaces-apis.md` (`CLI Surface`, `Exit codes`, `JSON contract`); `plugins/dotbabel/bin/dotbabel-models.mjs`; `plugins/dotbabel/bin/dotbabel.mjs`; `plugins/dotbabel/src/lib/argv.mjs` (argument parsing precedent); `plugins/dotbabel/tests/criteria-cli.test.mjs` (CLI test precedent).
3. **Implement** — factor shared parsing and rendering into `plugins/dotbabel/src/model-intelligence/cli/`; add the standalone bin to `package.json`. Constraints: IMPL-4 — no new domain behavior. Out of scope: any library change.
4. **Commands** — narrow test; bats file; `npm run lint`; `npm test`; `npx vitest run plugins/dotbabel/tests/bin-symlink.test.mjs`.
5. **Acceptance evidence** — the five named tests pass; the bin-symlink test still passes; Bats required.

§6.7 groups these units into the planned pull-request sequence and makes `/pr-conductor` the landing pipeline for each one. A prompt stays the unit of TDD and acceptance evidence even when two prompts ship together (IMPL-16).

## 6.4 Testing Strategy

Constraints set by the owner on 2026-09-17 (§3, `Deployment`, CI):

- **TEST-1**: CI supports deterministic operation without depending on live provider APIs or mutable external catalogs. Tests and validation use fixtures/golden snapshots for source-adapter behavior and resolver contracts.
- **TEST-2**: Live discovery tests, where retained, are integration tests. They are not a prerequisite for deterministic unit/contract validation.

Decided by the owner on 2026-09-18. Model Intelligence uses layered tests so deterministic decision logic remains fast and reproducible while runtime-specific assumptions are checked against real CLIs separately. TEST-1 and TEST-2 above remain the governing CI principles.

### Test matrix

| Test kind        | Required?                         | Scope                                                                                           |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| Unit             | Yes                               | Pure modules, parsers, policy composition, resolver, drift classification, renderers            |
| Contract         | Yes                               | Adapter descriptors/results, catalog envelopes, projection/snapshot schemas, JSON CLI contracts |
| Integration      | Selective                         | Installed runtime behavior, bootstrap/sync filesystem behavior, real CLI parsing                |
| Bats             | Selective                         | Shell/bootstrap/handoff/user-scope materialization behavior                                     |
| Golden / fixture | Yes where generated output exists | Projection bytes, manifests, snapshot serialization, generated workflow/plugin templates        |
| Statistical      | N/A                               | Resolver is deterministic and §2 excludes model scoring/ranking                                 |
| Mutation         | Yes for high-risk decision logic  | Resolver, compatibility, policy, drift logic; requirement normalization when non-trivial        |

The template's nine kinds map onto the units of §6.3 as follows. The owner set the property, load/torture, and post-release rows on 2026-09-18 (TEST-7 to TEST-9).

| Unit                                    | Kinds applied                                                                                                                           | N/A + reason                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P-1 domain, P-2 requirement, P-4 policy | unit, contract                                                                                                                          | statistical — deterministic; load — no scale dimension; post-deploy — library only |
| P-3 compat, P-18 migrate write          | unit, contract, mutation, golden (migration analysis output)                                                                            | statistical — deterministic                                                        |
| P-5 adapter contract                    | contract, golden (fixture set)                                                                                                          | mutation — no decision logic                                                       |
| P-6, P-7, P-8, P-22 adapters            | contract, golden (recorded CLI output), integration (Tier 2), post-deploy (Tier 2 scheduled compatibility job)                          | mutation — parsing dominated by external CLIs; statistical — deterministic         |
| P-9 catalog and cache                   | unit, contract, property (a failed refresh never replaces a valid cache, for any failure), load/torture (concurrent refresh of one key) | statistical — deterministic                                                        |
| P-10, P-11 resolver                     | unit, contract, property (identical inputs → identical result; floors compose monotonically), mutation                                  | integration — no I/O; statistical — deterministic selection with no ranking        |
| P-12 materialize core                   | unit, golden (projection bytes and manifest)                                                                                            | mutation — rendering only                                                          |
| P-13 drift and transaction              | unit, mutation (`drift.mjs`), load/torture (two concurrent syncs), integration (filesystem), Bats                                       | statistical — deterministic                                                        |
| P-14 Claude projections                 | golden, integration (Tier 2), Bats                                                                                                      | mutation — rule table, covered by contract                                         |
| P-15 snapshot                           | unit, contract, golden (serialization)                                                                                                  | mutation — no decision logic                                                       |
| P-16 plugin baseline, P-17 workflow     | golden, integration (Tier 2 smoke for P-16), post-deploy (`dotbabel models status` reports the shipped baseline after release)          | mutation — generated templates                                                     |
| P-19 migration batches                  | golden (post-migration artifacts), integration (the four repository checks)                                                             | unit — no code                                                                     |
| P-20 recommend                          | unit, contract                                                                                                                          | integration — fixtures only; mutation — presentation                               |
| P-21 handoff observation                | integration (Tier 2), Bats                                                                                                              | mutation — shell                                                                   |
| P-23 CLI                                | contract (exit codes, JSON), Bats                                                                                                       | mutation — thin rendering                                                          |

### Statistical tests

**N/A — deterministic selection with no probabilistic scoring or ranking.** Model Intelligence does not benchmark models, estimate probabilities, or assign numeric quality scores. For identical explicit inputs, `resolver(input)` returns an identical result, so confidence intervals, repeated-trial variance, ranking stability, and sample-size thresholds do not apply. External AI model behavior itself is outside this test boundary. If a future version introduces learned heuristics, probabilistic classification, model benchmarking, or score-based ranking, this row is revisited rather than extending the current N/A assumption automatically.

### Mutation testing

- **TEST-3**: Mutation testing targets logic where a superficially passing suite could still permit a dangerous semantic inversion. Required targets: `model-intelligence/resolver/**`, `model-intelligence/compat/**`, `model-intelligence/policy/**`, `model-intelligence/materialize/drift.mjs`, and `requirement/` normalization code if implementation adds non-trivial handwritten logic beyond schema/AJV validation. The package already configures Stryker with the vitest runner (`package.json:73`); mutation runs against focused files rather than the entire package.

High-value mutations: reversing floor comparisons; allowing a weaker pin through a floor; changing artifact-pin precedence; treating `unknown` as satisfied; collapsing `unverified` into supported; ignoring dual-declaration conflicts; changing inherit into an active requirement; swapping stale/output-drift classifications; allowing failed/empty evidence to replace valid cache state.

Mutation coverage is not required on source adapters dominated by external CLI parsing, thin CLI argument/rendering code, generated templates, snapshot JSON serialization with no decision logic, or pure boilerplate/schema declarations. Those surfaces are better protected by contract, golden, and integration tests.

### Real runtime integration tests

- **TEST-4**: A unit receives a real-runtime integration test only when its contract makes a factual claim about behavior of an installed runtime that fixtures alone cannot prove. Real-runtime tests are separate from deterministic unit tests. They run in an isolated temporary HOME/config root wherever the runtime permits; avoid modifying the user's actual runtime configuration; avoid network/model execution unless that behavior is specifically under test; report `skipped` when the required runtime is not installed or required existing auth is unavailable; never convert a missing optional runtime into a normal unit-test failure; pin/report the tested CLI version in test output; and preserve raw evidence on failure sufficiently to diagnose runtime drift.

| Unit                        | Real-runtime integration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P-6 Claude adapter          | **Required when Claude Code is installed.** Test read-only/non-billable behavior: CLI presence/version detection; accepted model/effort syntax where observable without a model turn; unsupported enumeration behavior; adapter classification of unavailable discovery; frontmatter/runtime loading behavior testable without inference. Observation that requires a model turn is a separate explicit integration test (DOC-2 established that Claude observation may execute a model) and does not run in ordinary PR CI automatically. |
| P-7 Codex adapter           | **Yes, high priority.** `codex debug models`; model-list parsing; supported reasoning levels; offline/no-credential behavior where preserved by the installed version; resolved configuration inspection where read-only. Suitable for regular integration environments because DOC-2 established a non-billable discovery surface.                                                                                                                                                                                                        |
| P-8 knowledge sources       | **Not a real-installed-runtime test.** Fixture/contract tests by default; optional network integration tests against official APIs / Models.dev after RQ-1 defines them, separate from runtime integration.                                                                                                                                                                                                                                                                                                                                |
| P-9 catalog/cache           | **No real runtime required.** Adapter outputs come from fixtures. Cache locking, stale evidence, failed refresh preservation, and concurrency are deterministic filesystem tests. One higher-level test may compose P-9 with P-6/P-7, but it is not required for P-9 correctness.                                                                                                                                                                                                                                                          |
| P-12 / P-13 materialization | **No real runtime required.** Golden files, isolated filesystem trees, concurrency tests, and manifest fixtures. Materialization correctness does not depend on the runtime being installed.                                                                                                                                                                                                                                                                                                                                               |
| P-14 Claude projections     | **Yes, plus Bats.** Against an actual Claude Code installation: generated agent frontmatter is accepted; generated command frontmatter is accepted; generated skill projection does not rely on inert `model`/`effort`; Dotbabel-private metadata is absent from runtime projection; bootstrap/sync creates the expected generated copies. Bats covers the bootstrap/user-scope filesystem behavior. Any test requiring an inference turn is opt-in.                                                                                       |
| P-15 snapshot               | **No real runtime required for normal tests.** Parsing, identity, deterministic serialization, and check behavior use fixtures. The explicit snapshot-refresh path is covered by source-adapter integration tests.                                                                                                                                                                                                                                                                                                                         |
| P-16 plugin baseline        | **Targeted Claude smoke test recommended.** The deterministic build remains fixture/golden tested. When Claude Code is available, verify that the generated plugin artifact is accepted/loaded and that its generated agent metadata is structurally valid. The existing `build-plugin.test.mjs:372` assertion that `model:` survives is revised to assert the projected value/behavior, not removed.                                                                                                                                      |
| P-17 workflow               | **No live Claude execution in normal tests.** Golden workflow generation and YAML assertions for the explicit projected `--model`, the preserved Anthropic authentication path, deterministic output, and the coordinator requirement separate from worker floors. A full workflow smoke test may exist separately as an expensive/manual integration test.                                                                                                                                                                                |
| P-20 recommend              | **No real runtime required.** Observed-configuration fixtures from W2; deterministic over `ResolverResult + observation`.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P-21 handoff observation    | **Yes, plus Bats.** Exercise every runtime adapter that claims a read-only observable configuration. Bats covers shell behavior and fallback/error paths. Tests requiring model execution remain opt-in.                                                                                                                                                                                                                                                                                                                                   |
| P-22 Gemini                 | Installed/version detection; model flag/interface detection; absence of user-facing effort binding; any verified discovery/observation behavior from W0. No fabricated enumeration where none exists.                                                                                                                                                                                                                                                                                                                                      |
| P-22 Copilot                | Installed/version detection; current model/effort CLI surfaces; custom-agent binding if RQ-3 confirms it; skill/instructions behavior; `.prompt.md` behavior only if RQ-3 establishes Copilot CLI consumption. Isolated configuration root where supported.                                                                                                                                                                                                                                                                                |
| P-22 Antigravity            | `agy models` parsing; opaque selector preservation; supported CLI effort values; skill binding only if RQ-4 verifies it. Network/auth-dependent cases skip when unavailable.                                                                                                                                                                                                                                                                                                                                                               |
| P-22 OpenCode               | Warm/configured model enumeration; the exit-0/empty-output case as a named test, because ARCH-30 derives from it; config-scoped discovery; opaque `provider/model#variant` handling; skill binding only if RQ-4 verifies it.                                                                                                                                                                                                                                                                                                               |
| P-23 CLI                    | **No new real-runtime requirement.** Fixtures/fake adapters; a small smoke matrix (`status`, `refresh --runtime <installed>`, `resolve …`) may run against installed adapters without duplicating P-6/P-7/P-22.                                                                                                                                                                                                                                                                                                                            |

### Property tests

- **TEST-7**: Property tests apply where the invariant is broader than a finite example table. They complement, rather than replace, the named example-based tests for the exact precedence cases in ARCH-66 and ARCH-67. Other units are N/A unless implementation introduces a similarly useful invariant.

Required initial targets:

- **P-9 — Catalog/cache.** Invariant: a failed, malformed, empty, older, or otherwise unusable refresh never replaces a structurally valid newer cache entry (ARCH-30, ARCH-61). Exercise varying operation order, timestamps/evidence ordering, and refresh outcomes rather than only one hand-written race case.
- **P-10 — Resolver constraint composition.** At minimum: (1) determinism — identical normalized inputs → identical `ResolverResult`; (2) floor monotonicity — strengthening an applicable floor may preserve or narrow the valid result set, but never makes a previously-too-weak configuration valid; (3) pin safety — a pin below an effective floor is never returned as a successful resolution regardless of pin precedence; (4) inheritance neutrality — adding an `inherit` declaration does not introduce a stronger or weaker requirement of its own.

### Load / torture tests

- **TEST-8**: Load/torture tests are required for concurrency-sensitive state transitions rather than throughput benchmarking. Pass criteria are state coherence and absence of mixed-generation projections, not requests-per-second. No artificial high-volume performance benchmark is required unless implementation evidence later shows scale-related failure modes.

- **P-13 — Materialization drift and transaction.** Exercise concurrent processes attempting to synchronize the same projection tree. Cover at least: two equivalent syncs racing; two syncs with different canonical inputs; interrupted materialization before manifest commit; stale lock recovery; generated-file replacement while another process is reading status (ARCH-62, ARCH-65, ARCH-69).
- **P-9 — Catalog/cache** may also receive a focused concurrency torture test for multiple simultaneous refresh attempts against one cache key, validating ARCH-61's single-refresh behavior.

### Post-release / post-install verification

- **TEST-9**: For this package, the template's "post-deploy" category means verification after a Dotbabel release or installation has produced the actual consumer-visible runtime artifacts. It uses Tier 2 installed-runtime integration where appropriate. These checks detect ecosystem/runtime drift; they do not replace deterministic build and golden tests.

Required initial cases:

- **P-16 — Plugin baseline.** After building/installing the release artifact: Claude can load the generated plugin; the shipped baseline projection is structurally accepted; `dotbabel models status` identifies the shipped `snapshotId` / projection provenance; a fresher local resolution, when present, is reported as distinct from the shipped baseline (ARCH-43).
- **P-17 — Generated `ai-review.yml`.** After initialization from the built package: the consumer receives the generated workflow; its projected coordinator model matches the release projection; status can identify that consumer copy as originating from the shipped baseline; a later Dotbabel release does not falsely claim the already-initialized consumer copy has been updated.
- **Runtime adapters.** Tier 2 compatibility tests after release verify that adapter assumptions still match supported installed CLI versions.

### Runtime integration matrix

| Unit                       | Claude         | Codex          | Gemini         | Copilot        | Antigravity    | OpenCode       |
| -------------------------- | -------------- | -------------- | -------------- | -------------- | -------------- | -------------- |
| P-6 Claude adapter         | Yes            | —              | —              | —              | —              | —              |
| P-7 Codex adapter          | —              | Yes            | —              | —              | —              | —              |
| P-14 Claude projection     | Yes            | —              | —              | —              | —              | —              |
| P-16 plugin baseline smoke | Yes            | —              | —              | —              | —              | —              |
| P-21 handoff observation   | When supported | When supported | When supported | When supported | When supported | When supported |
| P-22 runtime adapters      | —              | —              | Yes            | Yes            | Yes            | Yes            |

P-21 tests only capabilities that the corresponding adapter declares `supported`.

### CI placement

- **TEST-5**: Three test tiers.
  - **Tier 1 — pull-request deterministic**, required on every PR: Vitest unit, contract tests, golden tests, Bats with mocked/isolated external CLIs, lint, shellcheck, and focused mutation gates where configured. No live provider network and no model inference.
  - **Tier 2 — installed-runtime integration**, run when the relevant binaries are available in a controlled environment (Claude, Codex, Gemini, Copilot, Antigravity, OpenCode). These detect CLI/runtime drift and may run manually, on a dedicated CI job/image, or as a scheduled compatibility job. A skipped missing runtime is reported explicitly rather than masquerading as a pass.
  - **Tier 3 — network / authenticated / model-executing**, only for behaviors that cannot be verified otherwise: Claude effective-model observation requiring a turn; authenticated provider/source APIs; Antigravity behavior requiring OAuth; other runtime operations that incur network/model execution. Opt-in or scheduled, never required for deterministic package correctness.

### Test ownership principle

- **TEST-6**: Every behavior is tested at the lowest deterministic layer capable of proving it: pure semantic rule → unit / mutation; adapter parsing contract → fixture / contract; actual CLI behavior → installed-runtime integration; shell installation/materialization → Bats; provider/network behavior → opt-in external integration. A higher test tier supplements the lower tier; it does not replace it.

## 6.5 Migration Sequence

Decided by the owner on 2026-09-18. The migration is additive and keeps every intermediate repository state usable.

1. **Land Model Intelligence without changing canonical artifacts.** Add the domain and requirement schemas, compatibility parsing, policy/catalog/resolver infrastructure, and the Model Intelligence CLI read paths. Existing `model:` / `effort:` declarations remain authoritative through the compatibility layer. No artifact behavior changes in this step.
2. **Introduce `dotbabel.compute` alongside legacy metadata.** Begin adding canonical semantic declarations only where the mapping is unambiguous. During this dual-declaration period, `dotbabel.compute` is canonical Model Intelligence intent; retained native `model:` / `effort:` continue protecting current runtime behavior; validation checks that the two known meanings do not conflict. This is the compatibility bridge from KD-1.
3. **Establish generated-file ownership before changing delivery topology.** Before replacing existing copies or symlinks, implement generated markers, projection manifests, output/source drift classification, transaction locks, deterministic regeneration, and ownership detection.
   - **IMPL-6**: The existing behavior where bootstrap skips an agent file merely because it already exists (`plugins/dotbabel/src/bootstrap-global.mjs:224-226`) is replaced with an ownership-aware decision. A file is not considered Dotbabel-generated solely because its path matches a Dotbabel destination.
4. **Migrate Claude agent delivery.** Agents already have a copy/materialization boundary, so they migrate first: canonical semantic artifact → resolver → generated Claude projection (KD-2). Existing concrete safety pins remain the initial compatibility projection where PB-1/PB-13 require it. Existing files that cannot be proven Dotbabel-owned are not overwritten silently.
5. **Replace shared skill/command symlinks only when projection requires it.** KD-5 changes the edit loop, so the symlink-to-copy transition happens only after projection and drift tooling exists. For migrated artifacts: canonical source remains the editing surface; the generated runtime copy becomes the consumption surface; `project-sync` / bootstrap regenerates it; status/check reports stale copies after canonical edits. Because edits are no longer immediately visible through a symlink, migration documentation and diagnostics explicitly tell the user when synchronization is required. Protected `.claude/**` paths and trust rules remain enforced during this transition.
6. **Establish release-time baseline generation.** Add the committed release capability snapshot and deterministic generation of the Claude plugin template agents, other plugin runtime projections required by KD-3, and the canonical/generated `ai-review.yml` from KD-6. This happens before removing legacy safety metadata from canonical sources. The build demonstrates that required floors remain satisfiable from the committed release snapshot (ARCH-41, ARCH-55).
7. **Preserve initialized consumer copies as independent installed state.** Existing consumer repositories may already contain copied workflows such as `.github/workflows/ai-review.yml` (`plugins/dotbabel/src/init-harness-scaffold.mjs:10`). A new Dotbabel release does not claim that those copies changed automatically. Status/drift reporting distinguishes the current shipped baseline from the consumer-installed copy and reports staleness where applicable. Updating an initialized consumer remains an explicit sync/force/migration operation according to the owning scaffold contract. The same rule applies to the example consumer fixture (`examples/minimal-consumer/`): generated examples are refreshed deliberately and checked in CI.
8. **Migrate canonical artifacts in low-risk batches**, in the Phase 5 order: explicit inherit / neutral cases; unambiguous semantic requirements; dynamic requirements; known floors and intentional pins; coordinator/worker cases; unresolved owner-decision cases. Each batch satisfies IMPL-2 before merge, and the three safety-sensitive batches P-19d, P-19e, and P-19f ship one per pull request with the explicit full review fleet (IMPL-14, IMPL-17). No batch removes a working native declaration until the replacement runtime projection that preserves its behavior is proven.
9. **Class-F owner-decision gate.**
   - **IMPL-7**: Unresolved DOC-1 class-F entries are never guessed. Immediately before P-19f: (1) enumerate the remaining class-F artifacts; (2) remove entries whose disposition KD-1 through KD-6 or earlier migration work already decided; (3) present each remaining item with its current declaration, observed binding behavior, migration alternatives, preserved behavior affected, and the recommended semantic representation where evidence supports one; (4) require an explicit owner decision; (5) record the decision in the spec/migration mapping before changing the artifact. P-19f is blocked until this list reaches zero unresolved entries. This is an owner-decision gate, not a reason to block Phases 1–4 or the unambiguous Phase 5 migration batches. DOC-1 lists 13 class-F entries today (DOC-1, "Migration Classification").
10. **Remove legacy declarations only after projection parity.**
    - **IMPL-8**: Legacy `model:` / `effort:` leave a canonical source only when its semantic declaration is complete; all relevant runtime projections are defined; preserved behavior tests pass; generated outputs reproduce deterministically; and no unresolved compatibility consumer still requires the canonical legacy field. Explicit pins may remain as runtime projections even after they disappear from canonical semantic source.
11. **Retire `compat/` incrementally.**
    - **IMPL-9**: `compat/` remains while supported repositories/artifacts may still contain legacy declarations. It is not deleted immediately after Dotbabel's own repository is migrated. Retirement requires a separately defined compatibility/version boundary and evidence that supported inputs no longer depend on legacy interpretation. Until then it remains transitional code with tests, not a second policy system (ARCH-19).

## 6.6 Rollback Plan

Decided by the owner on 2026-09-18. Model Intelligence is introduced additively so that most failures can be rolled back by reverting the affected implementation or migration while retaining the previous compatibility path. Until IMPL-9 retires `compat/`, legacy declarations remain a supported recovery path.

### Rollback scenarios

| Scenario                                                                  | Action                                                                                                                                                                                                                                                             | Notes                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolver or policy defect selects an incorrect configuration              | Revert the offending resolver/policy change and ship a corrective patch release through the normal release-please flow. Consumers needing immediate recovery may pin the previous Dotbabel package version.                                                        | Canonical artifacts normally require no rollback because semantic declarations remain valid; the defective interpretation is reverted.                                                 |
| Generated runtime projection is rejected by a runtime                     | Revert the materializer/runtime-contract change or restore the previous verified projection behavior, then ship a corrective patch. Local consumers may temporarily reinstall/pin the previous Dotbabel release and regenerate Dotbabel-owned projections from it. | Tier 2 runtime integration should catch this before release. During the compatibility window, an affected artifact may restore its previous native legacy declaration where necessary. |
| Release snapshot selects a model/selector that becomes invalid or retired | Generate and commit a corrected release snapshot and ship a patch release. If the previous Dotbabel release still projects a valid selector, consumers may temporarily pin it.                                                                                     | Do not blindly roll back to the previous snapshot: a provider retirement may make the old release invalid too. This is the bounded market-churn exception recorded in KD-3.            |
| A canonical artifact migration batch breaks preserved behavior            | Revert that migration batch and, if already published, ship the revert as a corrective patch. Reintroduced legacy declarations are read by `compat/`.                                                                                                              | Migration batches remain small and independently deployable under IMPL-2.                                                                                                              |
| Symlink-to-copy migration breaks the edit loop                            | Run explicit sync to regenerate a stale copy. If the projection topology itself is defective, revert the affected artifact to the previous delivery strategy only where the artifact satisfies the safe symlink conditions from KD-5/ARCH-51.                      | Do not globally restore symlinks for artifacts requiring metadata stripping or runtime-specific projection.                                                                            |
| Generated file was manually edited and sync would destroy desired work    | Drift detection stops treating the generated file as canonical. Recover/copy the user edits elsewhere, restore canonical intent in the source artifact if appropriate, then regenerate.                                                                            | Projection manifests identify canonical source versus modified generated output.                                                                                                       |
| Projection transaction fails midway                                       | Re-run sync/materialization. Because the manifest commits last, the incomplete generation is detected rather than accepted as complete.                                                                                                                            | ARCH-69 makes interrupted generation recoverable.                                                                                                                                      |
| Capability cache is corrupt or unusable                                   | Delete the affected Model Intelligence cache entry/tree and rediscover. A valid older cache must not have been overwritten by the corrupt refresh.                                                                                                                 | Cache is reconstructible and contains no canonical state (ARCH-22, ARCH-30).                                                                                                           |
| Cache refresh lock is stale                                               | Apply the conservative stale-lock recovery rule from ARCH-65; recover only when ownership can safely be considered dead.                                                                                                                                           | Arbitrary timeout expiry alone is not proof that the owner is gone.                                                                                                                    |
| Release snapshot file is corrupt or non-reproducible                      | Restore the last known-good committed snapshot or regenerate an accepted replacement with `dotbabel models snapshot --write`; verify with `--check` before release.                                                                                                | The snapshot is version-controlled, so Git history supplies the previous known-good input.                                                                                             |
| `models recommend` gives poor advice while resolution remains correct     | Disable/revert the recommendation presentation change without changing the resolver or active runtime configuration.                                                                                                                                               | Recommendation is advisory and never owns selection logic (ARCH-57 rule 2).                                                                                                            |
| Runtime adapter behavior drifts after an upstream CLI release             | Mark the affected capability `unverified` or `unavailable` as appropriate, revert unsafe assumptions, and ship an adapter fix. Do not claim enforcement until compatibility is reverified.                                                                         | Other runtimes and deterministic resolver behavior remain available independently.                                                                                                     |
| New CLI behavior has an orchestration/rendering defect                    | Revert the thin CLI integration while retaining the backing library capability.                                                                                                                                                                                    | IMPL-4 keeps domain behavior outside the CLI, limiting rollback scope.                                                                                                                 |

### Release rollback procedure

- **IMPL-10**: Dotbabel does not replace or mutate an already-published npm version. A defect found after publication is corrected by a **roll-forward patch containing the rollback/fix**: identify the offending change → revert/fix it on the normal development branch → run normal validation and release gates → release-please creates the corrective version/changelog/tag (`.github/workflows/release-please.yml`) → merge the release PR through the existing release process → `release.yml` publishes the new tag to npm via OIDC (`.github/workflows/release.yml:52-53`). The repository's existing ownership remains unchanged: release-please owns the version, `CHANGELOG`, and the release tag; `release.yml` owns npm publication from the tag. No Model Intelligence-specific release mechanism is introduced.

**npm deprecation.** `npm deprecate` is not the normal rollback path. It may be used as an explicitly approved incident-containment action when a published version is sufficiently unsafe or broken that users should receive a warning when selecting it, for example `3.x.y` deprecated with "Model Intelligence projection defect; upgrade to >=3.x.z". Deprecation does not repair installed copies, does not replace the bad package contents, does not create the corrective release, and does not substitute for release-please. The normal order is: corrective release → optionally deprecate the known-bad exact version when warranted. Not every reverted release is deprecated automatically.

**Pre-publication rollback.** If the defect is found before npm publication, no package rollback is required. Revert/fix the offending change before the release PR is merged or before the release is published, then allow the normal release-please process to regenerate the release state as appropriate. No published rollback version is created merely to mirror an internal reverted commit.

### Coexistence strategy

Old and new declarations coexist throughout the migration window:

```text
legacy model:/effort:
        │
        ▼
      compat/
        │
        ├──────────────┐
        ▼              ▼
normalized intent   dotbabel.compute
        \              /
         \            /
          ▼          ▼
             resolver
```

- **IMPL-11**: The rules during coexistence are: (1) canonical `dotbabel.compute` is introduced additively; (2) known dual declarations must agree, and disagreement is a validation error rather than silent precedence (KD-1); (3) legacy declarations remain readable through `compat/`; (4) runtime-native values may continue to exist in generated projections even after canonical artifacts become semantic; (5) migration removes a canonical legacy declaration only after IMPL-8 projection parity; (6) a migration rollback may reintroduce the previous legacy declaration while `compat/` exists; (7) `compat/` is not removed merely because Dotbabel's own artifacts have finished migrating, because IMPL-9 requires an explicit compatibility boundary.

This creates a rollback window in which a failing new semantic path is handled by reverting the affected change/batch while the previous legacy representation remains interpretable, without removing all Model Intelligence infrastructure.

### Rollback boundary after `compat/` retirement

After IMPL-9 eventually removes legacy compatibility, rollback changes character: old legacy declarations are no longer a guaranteed recovery mechanism; rollback relies on Git/package version rollback plus deterministic regeneration; and the compatibility-removal release must itself define its support/version boundary and recovery procedure. `compat/` retirement is therefore a deliberate compatibility milestone, not ordinary cleanup.

## 6.7 PR Sequence and Landing Pipeline

Decided by the owner on 2026-09-18, after P-1 and P-2 landed. §6.3 defines the implementation units; this subsection defines how they reach `main`. It is an execution layer above the unit contracts and changes none of them.

- **IMPL-12**: Every Model Intelligence pull request intended to land goes through `/pr-conductor` (`skills/pr-conductor/SKILL.md`). The pipeline is the standard one-PR landing path, not a treatment reserved for high-risk changes. It handles one pull request at a time, and it never merges: merging stays a separate, explicit human action. The phase order is not restated here: `CONDUCTOR_PHASES` in `plugins/dotbabel/src/pr-gates.mjs` is the authority, the skill document mirrors it under a bats contract test, and a copy in this spec would drift out of that test's reach. At the time of writing it runs `pre-pr`, `open-pr`, `post-pr-review`, `review-pr`, `local-attest`, then stops. IMPL-19 states what the pull request body must declare for the criteria step inside that pipeline to cover the specs the diff implicates.
- **IMPL-13**: `post-pr-review` selects its own review fleet from the diff profile. An implementer does not pass `--agents` unless the profile is clearly wrong for the diff. The profiles are: a protected-path change gets the full fleet; a docs-only change gets `documentation-writer` plus `security-auditor`; a small non-protected code diff gets `security-auditor` plus `architect-reviewer`; a larger code diff gets the full fleet. Because `plugins/dotbabel/src/**`, `plugins/dotbabel/bin/**`, and `plugins/dotbabel/templates/**` are protected paths (`docs/repo-facts.json`), most implementation PRs receive the full fleet by rule rather than by choice.
- **IMPL-17**: The migration batches P-19d, P-19e, and P-19f take the full review fleet explicitly, by passing `--agents`. They are the exception IMPL-13's profile cannot infer: `agents/**` and `skills/**` are absent from the protected paths in `docs/repo-facts.json`, so a batch that only rewrites artifact frontmatter is an all-Markdown diff and falls to the docs-only profile. That profile drops `compliance-auditor`, whose declared-versus-enforced audit is exactly what PB-1 to PB-3 need, on the pull requests that change the security agents' capability floor, the `veracity-audit` floor, and the `rollback-prod` confirmation boundary. IMPL-14 isolates those units for closer review, and this keeps the mechanism pointing the same way as that intent.
- **IMPL-18**: An explicit `--agents` value may only widen the fleet the profile selected, and it always retains `security-auditor`. `post-pr-review` honours an explicit value verbatim, and `pre-pr --conductor` narrows its own security step to a secrets grep on the assumption that the authoritative pass runs in phase 3, so a narrowed override would leave an IMPL-12 pipeline with no security review at any stage.
- **IMPL-19**: A Model Intelligence pull request may change a file that another spec's `linked_paths` also covers. Its `## Spec ID` section then names both spec ids, and `dotbabel criteria verify --pr <N> --post` runs before the merge gate. Most implementation units meet this condition, because `qa-verification-harness` links `plugins/dotbabel/src/quality/**`, `plugins/dotbabel/bin/dotbabel.mjs`, and `schemas/dotbabel.config.schema.json`. The declaration is load-bearing for one reason, and that reason is not the scope of the gate. The merge gate scopes criteria to the **union** of the declared ids and the ids the diff implicates through `linked_paths` at the base ref (`plugins/dotbabel/src/criteria/gate-inputs.mjs:131,147`). Silence therefore never removes a spec from scope. But `criteria verify --pr <N>` reads the body alone (`plugins/dotbabel/src/criteria/preconditions.mjs:60`). An undeclared spec is required by the gate and skipped by the verifier. The verifier then exits 0, and the merge gate blocks with `CRITERIA_EVIDENCE_INCOMPLETE` (`plugins/dotbabel/src/pr-gates.mjs:470`) under the default `enforcement: "block"` (`plugins/dotbabel/src/criteria/config.mjs:16`). **The gap is fail-closed: it costs a round trip, not a bypass.** Declaring both ids is what lets the verifier produce the evidence the gate already demands. PR #393 failed this way. Two limits bound the obligation. First, both commands are local and advisory. No workflow in `.github/workflows/` runs the merge gate, and `.dotbabel.json` declares no `criteria` key, so `require_ci_check` keeps its default `false` (`plugins/dotbabel/src/criteria/config.mjs:18`). An author who names both ids and runs neither command lands a pull request with no evidence and nothing objects. Second, scope follows the base-ref `linked_paths`, so a changed file that no spec links carries no criteria obligation at all (`gate-inputs.mjs:148`). Keeping each spec's `linked_paths` current is part of this obligation, not separate from it.

### Planned PR sequence

An implementation unit is not mechanically one pull request. The planning target is ~25 PRs rather than the 32 that one-PR-per-sub-prompt would imply. Ship the §6.3 units in this order:

| PR    | Units       | PR    | Units         |
| ----- | ----------- | ----- | ------------- |
| PR-01 | P-1 + P-2   | PR-14 | P-17          |
| PR-02 | P-3         | PR-15 | P-18          |
| PR-03 | P-4         | PR-16 | P-19a + P-19b |
| PR-04 | P-5         | PR-17 | P-19c         |
| PR-05 | P-6 + P-7   | PR-18 | P-19d         |
| PR-06 | P-8a + P-8b | PR-19 | P-19e         |
| PR-07 | P-9         | PR-20 | P-19f         |
| PR-08 | P-10 + P-11 | PR-21 | P-20          |
| PR-09 | P-12        | PR-22 | P-21          |
| PR-10 | P-13        | PR-23 | P-22a + P-22b |
| PR-11 | P-14        | PR-24 | P-22c + P-22d |
| PR-12 | P-15        | PR-25 | P-23          |
| PR-13 | P-16        |       |               |

Why each group exists:

- **P-1 + P-2** — the domain vocabulary and the canonical requirement/schema are one foundation. Landed as PR #387 and PR #389; the split was incidental, not a precedent.
- **P-6 + P-7** — the Claude and Codex adapters implement the same stabilised adapter contract and keep separate tests.
- **P-8a + P-8b** — the knowledge-source implementations share one boundary. Split this PR if the official-provider adapter proves materially larger than expected.
- **P-10 + P-11** — P-10 deliberately leaves enforcement and explanation stubbed, and P-11 completes the resolver. Grouping avoids merging that artificial intermediate state.
- **P-19a + P-19b** — both are low-risk, unambiguous migration batches.
- **P-22a + P-22b** and **P-22c + P-22d** — adapter-only runtime coverage under the current scope. These PRs do not introduce cross-runtime agent fan-out, which §2 puts out of scope.

### Deliberately isolated units

- **IMPL-14**: These units ship one per pull request: P-9, P-13, P-14, P-15, P-16, P-17, P-18, P-19d, P-19e, P-19f, P-21, and P-23. The three migration batches among them also carry the explicit full fleet of IMPL-17, because their diffs would otherwise select the smallest one. Each contains concurrency or state transitions, shell and bootstrap behavior, deterministic release artifacts, a safety-sensitive migration, or a compatibility boundary, and focused review is worth more there than a shorter queue. P-19f may split into several pull requests when the remaining class-F owner decisions (IMPL-7) produce a large or heterogeneous diff.

### Grouping rule

- **IMPL-15**: Two units may share a pull request only while all five of these hold: they share the same dependency boundary; each unit keeps its named TDD tests and acceptance evidence from §6.3; the combined pull request remains one coherent review topic; failure and revert semantics stay understandable; and the grouping does not hide a safety-sensitive migration inside unrelated work. When one stops holding during implementation, split the pull request rather than forcing this table. The number of pull requests is never reduced merely to lower review cost.
- **IMPL-16**: The §6.3 implementation prompt stays the unit of TDD and acceptance evidence even when two prompts ship in one pull request. A grouped pull request runs both prompts' named tests and reports both sets of evidence; the prompts' contents are not rewritten to merge their tests.
