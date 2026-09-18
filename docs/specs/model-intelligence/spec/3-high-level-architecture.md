# §3 — High-Level Architecture

> System view: components, data stores, external dependencies, deployment.

**Settled.** The owner decided every subsection on 2026-09-17. ARCH-1 to ARCH-36 live here; [DOC-1](../research/sources.md) and [DOC-2](../research/sources.md) supply the evidence pointers.

## Design Constraints

The owner set these constraints on 2026-09-17, before the design began. They bind every later section.

- **ARCH-1**: Model and effort are not assumed to be universally separate axes. Antigravity fuses effort into the listed identifier, and Codex effort support varies per model (DOC-2, finding 4, and the section "`agy models` Grammar and Stability").
- **ARCH-2**: A runtime is not assumed to map to one model vendor (DOC-2, Runtime vs Model Vendor Evidence).
- **ARCH-3**: Runtime-native model/configuration identifiers are opaque.
- **ARCH-4**: Semantic workload requirements are distinct from the concrete runtime configuration that ultimately executes them.
- **ARCH-5**: Session, command, agent/worker, skill, and inherited binding scopes are distinct (DOC-2, finding 1).
- **ARCH-6**: Intentional safety-critical pins and operational safety fences are preserved.
- **ARCH-7**: New models, new effort types, new runtime capabilities, and stale capability data do not require a Dotbabel release for every provider change.
- **ARCH-8**: The spec defines source precedence and trust. It prefers runtime discovery where reliable and official provider metadata where available, and it uses external catalogs such as Models.dev only as appropriate fallback/input sources. No one source is universally authoritative.
- **ARCH-9**: The design accounts for runtimes where discovery is partial, unavailable, account-scoped, config-scoped, or unreliable.
- **ARCH-10**: Recommendations are advisory. The system must not silently change the user's active model or reasoning configuration (§2, in-scope item 6).
- **ARCH-11**: The confirmed constraints in DOC-2 bind the design unless new repository or runtime evidence disproves them.

## System Overview

The owner set this component model on 2026-09-17. The permanent flow is:

```text
Requirement → Policy + Capability Catalog → Resolver → Runtime Materialization
```

Discovery feeds the catalog, and the recommendation surfaces consume the resolver.

### 1. Requirement vocabulary

Artifacts and recommendation callers express stable semantic intent rather than provider-specific model names. A requirement can include:

- a semantic capability requirement;
- a binding scope (ARCH-5);
- a resolution mode: `dynamic`, `pin`, `floor`, or `inherit`;
- additional constraints where needed, without assuming every runtime exposes the same axes (ARCH-1).

### 2. Source adapters

Adapters acquire model/runtime facts from multiple authorities. There are two source classes:

- **Runtime adapters** describe the locally installed harness. Depending on runtime capability, they may discover locally available models/configurations, validate runtime-native identifiers, observe the effective configuration, and translate resolved configurations into runtime-native form.
- **Knowledge-source adapters** consume official provider metadata and external catalogs such as Models.dev when runtime discovery cannot supply the required facts (ARCH-8).

Constraints:

- **ARCH-12**: Adapter capabilities are explicit. An adapter may report a capability as unsupported, unavailable, stale, or unknown rather than fabricating an answer. The state vocabulary of the quality layer is the in-repo precedent (`plugins/dotbabel/src/quality/types.mjs:14`).
- **ARCH-13**: Effective-model observation belongs to the runtime-adapter contract, because support and semantics differ by runtime. It is not a standalone component. `plugins/dotbabel/scripts/handoff-extract.sh` becomes one consumer/implementation surface of that capability rather than the architecture itself.

### 3. Capability catalog

A normalized catalog combines facts from those sources while preserving their origin. It records at least:

- opaque model/configuration identity (ARCH-3);
- runtime and, where known, model vendor (ARCH-2);
- supported capabilities and configuration axes;
- local availability separately from global existence;
- provenance;
- freshness;
- confidence;
- discovery state.

Constraints:

- **ARCH-14**: Global catalog presence is never interpreted as proof that the current user or runtime can invoke a model.

### 4. Dotbabel policy and classification

This is the stable decision framework owned by Dotbabel. It defines:

- semantic workload classes such as mechanical, routine, deep, frontier, and exceptional. DOC-1 already places the 24 agents and 37 skills on this ladder (DOC-1, "Agents and Subagents" and "Skills");
- what capabilities satisfy those classes;
- Dotbabel-specific classifications where external metadata is insufficient;
- safety-critical minimum floors and intentional pins (ARCH-6);
- resolver preferences and invariants.

Constraints:

- **ARCH-15**: Provider model names and today's market catalog do not belong in policy.

### 5. Resolver and explainer

The resolver takes:

- a semantic requirement;
- the target runtime;
- the current capability catalog;
- Dotbabel policy;
- applicable pin/floor/inheritance constraints.

It returns either:

- a concrete runtime-native configuration plus an explanation; or
- an explicit unresolved/unavailable result explaining why safe resolution was not possible.

Constraints:

- **ARCH-16**: Resolution does not silently guess through missing or stale evidence.

### 6. Runtime materialization

The resolved configuration is converted into the representation appropriate for the target runtime. This includes fan-out behavior such as `project-sync`: emit native model/configuration metadata where the runtime supports it, transform it where necessary, and omit it where the runtime does not consume it.

Constraints:

- **ARCH-17**: Runtime-native identifiers remain opaque. Dotbabel does not derive semantics by parsing their spelling unless the runtime explicitly guarantees that structure. This refines ARCH-3.

### 7. Recommendation surfaces

The same resolver powers two user-facing contexts:

- **Design time:** recommend requirements or concrete configurations while creating/configuring agents, commands, workflows, and similar artifacts.
- **Runtime advisory:** compare the work requirement with the observed/current configuration and explain when escalation or de-escalation would be appropriate.

Runtime advice is advisory only. It never silently changes the user's active model or reasoning configuration (ARCH-10).

### 8. Legacy compatibility and migration

During migration, Dotbabel continues to understand existing `model:` and `effort:` declarations and maps them into the new representation where their semantics are known.

Constraints:

- **ARCH-18**: Unknown or ambiguous legacy declarations remain explicit migration cases rather than being guessed.
- **ARCH-19**: This component is transitional. The target architecture does not require legacy Claude-shaped metadata once migration is complete. Feeds §6.5.

## Data Stores

The owner set the first four stores on 2026-09-17 and added the fifth through KD-3 (§4). No database is required.

| Store                                     | Role                                                                                                                                                                                                                                                                                                                                                                                         | Access Pattern                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Shipped Model Intelligence policy**     | Version-controlled semantic requirement vocabulary, resolver invariants, safety floors/policies, source definitions, and bootstrap defaults. It must not contain a hardcoded catalog of today's provider model names (ARCH-15).                                                                                                                                                              | Read-only at runtime; changes with a Dotbabel release.                                                                            |
| **User Model Intelligence configuration** | User-level preferences and policy overrides that apply across repositories. Stored under `${XDG_CONFIG_HOME:-$HOME/.config}/dotbabel/`, following the existing `configDir()` convention (`plugins/dotbabel/src/lib/paths.mjs:40`).                                                                                                                                                           | Read at resolution time; explicitly changed by the user or by Dotbabel configuration commands.                                    |
| **Project configuration**                 | Repository-specific Model Intelligence policy under `.dotbabel.json`, such as project requirements, allowed overrides, or project-level floors.                                                                                                                                                                                                                                              | Read from the repository; version-controlled with the project.                                                                    |
| **Capability/discovery cache**            | Reconstructible snapshots from runtime discovery, official provider metadata, Models.dev, or other knowledge sources. Each snapshot includes source version, fetched/observed time, expiry/freshness state, provenance, and discovery result. Stored under `${XDG_CACHE_HOME:-$HOME/.cache}/dotbabel/model-intelligence/`, following `cacheDir()` (`plugins/dotbabel/src/lib/paths.mjs:51`). | Read frequently; refreshed according to source-specific freshness rules; safe to delete and rebuild.                              |
| **Release-time capability snapshot**      | Versioned, normalized Claude capability evidence that an explicit refresh step fixes before a Dotbabel release. The build resolves each semantic requirement against it to generate the baseline projections in the Claude plugin templates (§4, KD-3). It is market data/provenance, not policy (ARCH-15).                                                                                  | Written only by the explicit pre-release refresh step; read by the build; version-controlled; no network at build time (ARCH-39). |

The existing path helpers already define the canonical XDG config and cache roots, so Model Intelligence reuses them rather than introducing another storage convention. The quality layer is also useful precedent: it resolves shipped defaults, user configuration, project configuration, and operational inputs while retaining per-key provenance (`plugins/dotbabel/src/quality/config.mjs:166-189`). Model Intelligence reuses that pattern where its semantics match, rather than coupling to the quality implementation itself (§2, `Does Not Redesign`).

Constraints:

- **ARCH-20**: Resolved recommendations are not durable canonical state. A disposable generated projection is allowed under ARCH-38 (§4, KD-2). Dotbabel does not persist "use model X" as a cacheable decision merely because the resolver chose it once. Resolution depends on task requirement, runtime, local availability, freshness, and policy at that moment, so Dotbabel recomputes it from current inputs. A concrete model becomes durable only when the user intentionally creates a pin or another persistent declaration.
- **ARCH-21**: External catalogs are sources, not authoritative local stores. Models.dev, official provider APIs, runtime enumeration, and any future Dotbabel-maintained classification feed flow through source adapters into the capability cache. Their raw existence data remains distinguishable from locally verified availability (ARCH-14).
- **ARCH-22**: All Model Intelligence state is version-controlled policy/configuration, explicit user configuration, disposable cached discovery data, or the version-controlled release-time capability snapshot (§4, KD-3).
- **ARCH-23**: Policy precedence follows the existing Dotbabel shape where applicable: `shipped defaults → user config → project config → explicit artifact/invocation constraint`. The resolver contract in §5 specifies the exact interaction of `pin`, `floor`, `inherit`, and `dynamic`; it is not inferred solely from storage precedence.

## External APIs / Dependencies

The owner accepted these dependencies on 2026-09-17.

| Dependency                                                                                                               | Purpose                                                                                                                                                                          | Network / Auth Expectation                                                                                                                                                                           | Authority                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Installed runtime CLIs** — Claude Code, Codex, Gemini CLI, Antigravity, Copilot CLI, OpenCode                          | Discover locally exposed models/configurations, validate native identifiers where possible, and observe effective configuration where supported.                                 | Varies by runtime. Dotbabel does not assume that invoking a discovery command is offline; each adapter declares its behavior. Existing runtime authentication is owned by the runtime, not Dotbabel. | Highest authority for **local runtime availability and effective configuration** when the runtime exposes that information reliably. |
| **Official model/catalog APIs** — for example the Anthropic Models API, the Gemini Models API, and the OpenAI Models API | Provider-owned evidence about API model existence, lifecycle, capabilities, and availability where exposed.                                                                      | Network-required. May require provider credentials. These adapters are optional and never require Dotbabel to create, copy, or manage credentials.                                                   | Highest authority for the facts that the provider endpoint actually defines, but **not proof of availability in a coding runtime**.  |
| **Models.dev**                                                                                                           | Broad provider/model metadata when runtime or official sources are incomplete; useful for model identity, capabilities, context, release/update metadata, and provider coverage. | Network-required to refresh; no network required when a usable cached snapshot exists. No credentials expected.                                                                                      | Secondary/global knowledge source. Never authoritative for local entitlement or runtime support.                                     |
| **Dotbabel-shipped policy/classification**                                                                               | Stable semantic workload vocabulary, safety floors, resolver rules, and curated classifications that external sources cannot provide.                                            | No network. Ships with Dotbabel.                                                                                                                                                                     | Authoritative for **Dotbabel policy**, never for current market availability.                                                        |

DOC-2 measured the runtime CLI row (DOC-2, "Discovery Suitability"). `codex debug models` is structured, offline, deterministic, and credential-free. `agy models` is parseable text that needs the network. `opencode models` repeatedly returns exit 0 with no output. Copilot exposes its model list as help text only. Claude Code and Gemini CLI have no enumeration command, and Claude Code observation requires a billable turn. Neither DOC-1 nor DOC-2 measured the official model APIs or Models.dev; their shape, stability, and limits are open research before §5 fixes the knowledge-source adapter contracts.

Constraints:

- **ARCH-24**: Provider documentation scraping is not a runtime dependency. Documentation may be research evidence when maintaining adapters or classifications, but normal resolution consumes defined machine-readable sources or shipped/cached data rather than scraping web pages.

### Network rule

Network access is **optional at the system level, not at every source level**.

- **ARCH-25**: A source adapter declares enough behavior for the orchestrator to know whether it requires network, may require existing authentication, supports offline execution, supports cached results, can authoritatively answer local availability, and can fail as `unsupported`, `unavailable`, `stale`, or `unknown` (ARCH-12).
- **ARCH-26**: Normal resolution does not fail merely because the network is unavailable. It resolves from sufficient locally available and cached evidence when possible. If evidence is insufficient, the resolver returns an explicit unresolved or lower-confidence result rather than making a network-dependent guess (ARCH-16).
- **ARCH-27**: A cold offline machine with no usable discovery source and no cache is a valid state. Model Intelligence may be unable to recommend a concrete configuration, but Dotbabel itself remains functional.

### Source authority is field-specific

- **ARCH-28**: No one global source "wins" the whole model record. Authority is decided per field, and source conflicts preserve provenance rather than overwriting conflicting facts into one unattributed value.

Examples:

- whether `codex` can invoke model X locally → Codex discovery;
- whether Anthropic currently exposes model X through its API → Anthropic;
- broad metadata missing from the runtime → official source, then Models.dev as fallback;
- whether model X satisfies Dotbabel's `deep` workload requirement → Dotbabel policy/classification;
- whether the user is entitled to model X in a particular harness → only locally verified runtime evidence, when available.

### Network execution policy

- **ARCH-29**: The resolver hot path does not require a network round trip. Network-backed refresh belongs in an explicit or freshness-triggered discovery step whose result is cached. Resolution consumes the best currently usable snapshot.
- **ARCH-30**: A refresh failure preserves the previous cache with a `stale` state when it is still structurally valid. It never replaces a previously valid cache with an empty or failed result. The measured `opencode models` behavior, exit 0 with zero lines, is the concrete case (DOC-2, "`opencode models` Grammar and Stability").

## Deployment

Model Intelligence ships as part of the existing `@dotbabel/dotbabel` npm package and runs in-process on the machine where Dotbabel is invoked. The owner set this model on 2026-09-17.

### Runtime placement

- Implementation lives under `plugins/dotbabel/src/`, preferably as a cohesive `model-intelligence/` module rather than distributing resolver logic across runtime-specific files.
- User-facing operations are exposed through the existing `dotbabel` CLI surface. Exact subcommands belong in §5, but the architecture supports discovery/refresh, inspection/doctor, recommendation, resolution explanation, and migration workflows.

Constraints:

- **ARCH-31**: Existing consumers such as `project-sync`, artifact validation, handoff extraction, and future design-time tooling call the same Model Intelligence library rather than implementing independent model-selection logic.

### Execution model

- **ARCH-32**: Model Intelligence is on-demand and local. It has no daemon, no long-running background process, no hosted Dotbabel control plane, no required remote Dotbabel service, no local database (ARCH-22), and no automatic periodic network job.
- **ARCH-33**: Discovery or catalog refresh runs only when explicitly requested or when a caller invokes a policy-defined freshness check. Network-backed source adapters may refresh their cache at that point, subject to ARCH-25 through ARCH-30.

Resolution itself runs synchronously against current local policy, configuration, runtime evidence, and usable cached capability data. It does not require a network round trip (ARCH-29).

### User environment

Model Intelligence inherits Dotbabel's existing platform/runtime requirements:

- Node.js `>=20` and ESM modules (`package.json`);
- the existing Dotbabel installation and filesystem permissions;
- supported AI runtimes only when their corresponding adapter functionality is requested.

Constraints:

- **ARCH-34**: A missing runtime, unavailable network, unavailable provider API, or empty cache is represented as a normal capability/discovery state rather than preventing Dotbabel from starting (ARCH-27).

### CI

The same library runs in CI. The testing rules that follow from this are TEST-1 and TEST-2 in §6.4.

- **ARCH-35**: Repository validation may inspect Model Intelligence declarations and migration state without requiring installed AI runtimes or network access, unless a specific integration test explicitly provisions them.

### Packaging

Model Intelligence remains part of the existing Dotbabel package rather than becoming a separately versioned package or service. Its shipped policy therefore follows the Dotbabel release lifecycle, while volatile capability/catalog information is refreshed independently through the discovery/cache architecture. This separation is intentional:

```text
Dotbabel release  → code + stable policy
Discovery refresh → volatile model/runtime facts
```

- **ARCH-36**: No Dotbabel release is required merely because a provider introduces, renames, or retires a model. This makes ARCH-7 concrete.
