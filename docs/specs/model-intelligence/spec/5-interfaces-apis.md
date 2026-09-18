# §5 — Interfaces and APIs

> External APIs, internal endpoints, database schemas.

**Settled.** The owner decided every contract on 2026-09-18. ARCH-66 to ARCH-72 live here. `External APIs` waits for RQ-1.

## Artifact Declaration: `dotbabel.compute`

Decided by the owner on 2026-09-18. `dotbabel.compute` is the canonical, provider-neutral compute requirement for a Dotbabel artifact (§4, KD-1). It states the semantic workload requirement and never the concrete runtime configuration that executes it (ARCH-4).

```yaml
dotbabel:
  compute:
    requirement: deep
    binding: self
    mode: dynamic
    rationale: "Complex architectural reasoning."
```

### Fields

| Field         | Type   | Required             | Permitted values / meaning                                 |
| ------------- | ------ | -------------------- | ---------------------------------------------------------- |
| `requirement` | string | Conditional          | `mechanical`, `routine`, `deep`, `frontier`, `exceptional` |
| `binding`     | string | Yes                  | `self`, `session`, `consumer`                              |
| `mode`        | string | Yes                  | `dynamic`, `floor`, `pin`, `inherit`                       |
| `pin`         | object | Only for `mode: pin` | Exact runtime-native configuration                         |
| `rationale`   | string | No                   | Human-readable reason for the requirement                  |

No other keys are accepted inside `dotbabel.compute` in v1.

### `requirement`

The semantic workload class: `mechanical`, `routine`, `deep`, `frontier`, `exceptional`. The values are ordered by required reasoning capability but are not numeric model scores (§2, "Universal model scoring" is out of scope). `requirement` is required for `dynamic`, `floor`, and `pin`. It is forbidden for `inherit`.

### `binding`

`binding` describes **where the requirement applies**, independently of the artifact's file type or any runtime-specific syntax.

- **`self`** — The artifact creates or owns a compute context whose configuration may be bound independently. Primary example: an agent.

  ```yaml
  dotbabel:
    compute:
      requirement: frontier
      binding: self
      mode: floor
  ```

- **`session`** — The requirement applies to the enclosing/coordinator session. Primary examples: commands whose work executes in the current session; headless workflow coordinators such as `ai-review` (KD-6); other session-level orchestration.

  ```yaml
  dotbabel:
    compute:
      requirement: deep
      binding: session
      mode: dynamic
  ```

- **`consumer`** — The artifact does not itself bind compute. Its requirement applies to the compute context consuming it. Primary example: a skill. This is the schema representation of ARCH-37.

  ```yaml
  dotbabel:
    compute:
      requirement: deep
      binding: consumer
      mode: dynamic
  ```

Artifact names such as `agent`, `command`, or `skill-consumer` are not binding values. Artifact kind is already known independently; binding expresses execution semantics. `inherit` is not a binding value; it is a mode.

### `mode`

- **`dynamic`** — Resolve the semantic requirement against current usable capability evidence and policy. The resolver may choose among concrete configurations satisfying the requirement. This is the normal mode for artifacts that should track the model market without carrying concrete model names.

  ```yaml
  dotbabel:
    compute:
      requirement: deep
      binding: self
      mode: dynamic
  ```

- **`floor`** — Treat `requirement` as a minimum capability bound. A stronger effective requirement may win, but a weaker user/project/default preference must not lower the artifact below this class. This is the preferred representation for safety-sensitive artifacts such as the security agents once their legacy pins are migrated (PB-1, PB-13).

  ```yaml
  dotbabel:
    compute:
      requirement: frontier
      binding: self
      mode: floor
      rationale: "Security review; false negatives have high downstream cost."
  ```

- **`pin`** — Require one exact runtime-native configuration. A pin is an intentional exception to dynamic market resolution (PB-7). `requirement` remains required even for a pin: the semantic requirement records **why** that pinned configuration exists and allows Dotbabel to detect when a pin no longer satisfies its intended floor where sufficient capability evidence exists. No silent substitute is permitted for an unavailable pin.

  ```yaml
  dotbabel:
    compute:
      requirement: exceptional
      binding: self
      mode: pin
      pin:
        runtime: claude
        config:
          model: opus
          effort: max
  ```

- **`inherit`** — Declare that the artifact introduces no compute requirement of its own and delegates configuration to its enclosing/runtime context (PB-8). `requirement` and `pin` are forbidden; `rationale` remains optional.

  ```yaml
  dotbabel:
    compute:
      binding: consumer
      mode: inherit
  ```

Omitting `dotbabel.compute` entirely also remains valid. During migration, absence continues to mean "no canonical Model Intelligence declaration"; `compat/` may still derive meaning from legacy metadata. An explicit `mode: inherit` is useful when the owner wants that absence of policy to be intentional rather than merely undeclared.

### `pin`

`pin` has exactly two fields:

```yaml
pin:
  runtime: <dotbabel-runtime-id>
  config: <runtime-native-object>
```

- **`runtime`** — Required string identifying a runtime from Dotbabel's runtime registry. The initial supported ids are `claude`, `codex`, `gemini`, `antigravity`, `copilot`, and `opencode`, which are the `id` values of `RUNTIMES` (`plugins/dotbabel/src/agents.mjs:100-230`). The runtime registry is authoritative; Model Intelligence does not create another independently maintained runtime enum. `runtime` identifies the execution harness, not the model vendor (ARCH-2).
- **`config`** — Required non-empty object containing opaque runtime-native configuration (ARCH-3, ARCH-17). Examples may contain different axes, such as `{model: opus, effort: high}` or `{model: some-model, reasoningEffort: xhigh, contextTier: large}`. Model Intelligence does not assume that every runtime has `model + effort` (ARCH-1), nor generically parse meaning out of opaque identifiers. The runtime adapter owns validation and interpretation of `config`.

### Conditional validation

```text
mode = dynamic
  require: requirement, binding
  forbid: pin

mode = floor
  require: requirement, binding
  forbid: pin

mode = pin
  require: requirement, binding, pin

mode = inherit
  require: binding
  forbid: requirement, pin
```

`rationale` is permitted in every mode.

### Strictness

Although the artifact schemas currently allow unknown top-level properties for compatibility (`additionalProperties: true` at `schemas/agent.schema.json:8`, `schemas/skill.schema.json:8`, `schemas/command.schema.json:8`), `dotbabel.compute` itself is strict: `additionalProperties: false`. This prevents a misspelling such as `requrement: deep` from silently becoming inert policy. The surrounding `dotbabel` namespace may remain extensible for future Dotbabel-owned metadata.

### Validation ownership

The hand-written frontmatter parser in `plugins/dotbabel/src/validate-skills-inventory.mjs:32-62` is not extended to parse this nested structure. Canonical parsing and validation move through the shared YAML/AJV path (`plugins/dotbabel/src/build-index.mjs:441-472`) and `model-intelligence/requirement/`. `requirement/` is responsible for parsing `dotbabel.compute`, schema validation, conditional mode validation, canonical normalization, and reporting conflicts with legacy declarations through `compat/` (KD-1, dual-declaration rule 4). All consumers receive the normalized internal representation rather than independently reading nested YAML (ARCH-58).

### Additional semantic constraints

v1 has no generic field such as `constraints: {anything: anything}`. When Model Intelligence gains a concrete provider-neutral constraint with defined semantics — for example a required capability that the catalog can actually represent — it is added as a versioned, typed extension to this schema. This keeps the canonical contract smaller than the provider/runtime configuration space and avoids recreating runtime-native configuration under a supposedly provider-neutral key.

### Declaration for an artifact without frontmatter

Decided by the owner on 2026-09-18 for KD-6. An artifact format that has no frontmatter location in which the declaration can safely live carries its declaration in an adjacent sidecar file that holds the exact `dotbabel.compute` object and nothing else. No second syntax such as `x-dotbabel:` exists. The sidecar is not a separate policy system, and `requirement/` parses it with the same schema. This is the bounded exception to the sidecar rejection in KD-1, which applies to formats that do have frontmatter.

The first case is the `ai-review` workflow:

```text
plugins/dotbabel/src/model-intelligence/workflows/
  ai-review.source.yml     valid GitHub Actions YAML: name, on, permissions, jobs, steps, the Anthropic
                           authentication path, and the Claude invocation; no concrete model;
                           no Dotbabel-private metadata
  ai-review.compute.yml    dotbabel.compute with binding: session; requirement and mode come from the
                           approved migration/policy decision, never from a concrete Claude model
```

Generation: `ai-review.source.yml` + `ai-review.compute.yml` + shipped policy + release capability snapshot → resolver → materializer → `plugins/dotbabel/templates/workflows/ai-review.yml`. The generated workflow injects the concrete release-time session configuration selected under KD-6 and contains no `dotbabel.compute` metadata. This avoids depending on GitHub Actions unknown-key tolerance, making the workflow source runtime-private metadata-aware, and duplicating compute semantics outside the requirement parser.

### Project configuration namespace

Decided by the owner on 2026-09-18. `model_intelligence` is the project-level namespace for Model Intelligence configuration in `.dotbabel.json`. It follows the snake_case convention of the existing multiword keys (`fan_out`, `fan_out_layout`, `rule_floor_source`, `cli_substitutions`; `.dotbabel.json:6-7`). A top-level `models` key is not used, because it could be read as a literal model catalog or model-definition map. The object contains policy/configuration overrides only. It is never a persistent store for discovered models, resolved recommendations, cache evidence, generated projections, or release snapshot data; those remain in the stores of §3 (ARCH-20, ARCH-22). A command that mutates this object follows the read-modify-write lock of ARCH-63.

## Source Adapter Contract

Decided by the owner on 2026-09-18. Every runtime and external knowledge source implements the same descriptor envelope (ARCH-12, ARCH-25, ARCH-50). The quality layer's adapter registry is the in-repo precedent for a descriptor with explicit availability and source fields.

```ts
interface SourceAdapterDescriptor {
  id: string;
  kind: "runtime" | "knowledge-source";

  capabilities: {
    discovery: OperationCapability;
    observation: OperationCapability;

    binding: Record<
      ArtifactKind,
      {
        support: SupportState;
        axes: Record<string, SupportState>;
      }
    >;

    invocation: {
      support: SupportState;
      axes: Record<string, SupportState>;
    };

    validation: OperationCapability;
  };
}
```

### Support state

Static adapter capability uses exactly `supported`, `unsupported`, and `unverified`:

| State         | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `supported`   | Dotbabel has a verified adapter contract and implementation for this capability. |
| `unsupported` | The runtime/source is known not to expose this capability at this scope.         |
| `unverified`  | Dotbabel does not yet have sufficient evidence to claim support or non-support.  |

`unverified` is never treated as `supported` (ARCH-44). The three states are how the contract accounts for runtimes where discovery is partial, unavailable, account-scoped, config-scoped, or unreliable (ARCH-9).

### Operation capability

Discovery, observation, and validation use:

```ts
interface OperationCapability {
  support: SupportState;

  network: "never" | "optional" | "required";

  auth: "none" | "optional-existing" | "required-existing";

  cacheable: boolean;

  execution: "read-only" | "may-execute-model";
}
```

Enums replace `requiresNetwork: boolean` and `requiresAuth: boolean`. Some runtime operations work offline when local state exists but may use the network in another condition. Likewise, Dotbabel may use existing runtime credentials without owning them (§2, `Does Not Mutate`).

`execution` is required because observation is not always passive. An adapter whose only way to observe effective state requires running a model turn declares `may-execute-model`, and callers do not treat it like free read-only discovery. Claude Code is the measured case: observation requires a billable turn (DOC-2, "Discovery Suitability").

`cacheable` means the result may be persisted by `catalog/`. The adapter itself does not own cache I/O (ARCH-56).

### Artifact kinds

`binding` is keyed by the canonical artifact kinds known to Dotbabel, initially `agent`, `command`, `skill`, and `workflow`. Additional artifact kinds may be added without changing the adapter contract. Binding support is evaluated independently for each artifact kind:

```yaml
binding:
  agent:
    support: supported
    axes:
      model: supported
      reasoning: supported

  skill:
    support: unsupported
    axes:
      model: unsupported
      reasoning: unsupported
```

### Configuration axes

Axis identifiers belong to the runtime adapter contract. They are **not** a universal Dotbabel enum. Examples include `model`, `reasoning`, `contextTier`, and `selector`, but the domain layer does not infer semantic equivalence merely from an axis name. An Antigravity selector that fuses model and effort remains one opaque runtime axis rather than being synthetically split into `model` and `reasoning`. This preserves ARCH-1, ARCH-17, and the measured runtime differences from DOC-2.

### Invocation capability

Invocation configuration is also per axis:

```yaml
invocation:
  support: supported
  axes:
    model: supported
    reasoning: unsupported
```

This is different from artifact binding. A runtime can support selecting a model on its CLI while having no verified way to bind that model to a skill (ARCH-50).

### Adapter calls

Supported adapters expose operations conceptually equivalent to:

```ts
discover(context): Promise<AdapterResult<DiscoveryEvidence>>

observe(context): Promise<AdapterResult<ObservationEvidence>>

validate(input, context): Promise<AdapterResult<ValidationEvidence>>

renderInvocation(resolvedConfig, context): InvocationResult
```

Artifact materialization is not performed by the source adapter. `materialize/` consumes the adapter's binding contract and runtime-native translation helpers. The exact JavaScript export shape may be chosen during implementation, but all adapters expose the same semantic contract.

### Adapter result

```ts
interface AdapterResult<T> {
  status: "ok" | "unsupported" | "unavailable" | "unknown";

  evidence?: T;

  provenance: {
    sourceId: string;
    sourceKind: "runtime" | "knowledge-source";
    sourceVersion?: string;
    adapterVersion?: string;
  };

  observedAt?: string;

  diagnostic?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}
```

| Result        | Meaning                                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`          | The operation completed and produced usable evidence.                                                                                          |
| `unsupported` | The capability is not available for the detected source/runtime contract.                                                                      |
| `unavailable` | The capability exists, but it cannot be used now: missing binary, network failure, missing existing auth, runtime failure, and similar causes. |
| `unknown`     | The operation ran or evidence was inspected, but Dotbabel cannot make a reliable determination.                                                |

A successful exit code alone does not imply `ok`. The measured OpenCode case of exit `0` with empty output (DOC-2, "`opencode models` Grammar and Stability") is classified according to adapter semantics, not automatically converted into an empty successful model catalog (ARCH-30).

### Diagnostics

`diagnostic.code` is machine-readable and adapter-specific enough to preserve the real failure mode. Examples: `binary_missing`, `auth_required`, `network_unavailable`, `timeout`, `nonzero_exit`, `empty_output`, `malformed_output`, `version_unsupported`, `insufficient_evidence`. Consumers may render these differently, but they do not infer capability facts from diagnostic text.

### Freshness is separate

`fresh`, `stale`, and expiry are **not** adapter-result states. The adapter reports when evidence was observed. `catalog/` combines that timestamp with source policy and the current normalized time input (the resolver cannot read the clock, ARCH-56) to derive:

```ts
type Freshness = "fresh" | "stale" | "expired" | "unknown";
```

Valid catalog evidence can therefore be `status: usable` with `freshness: stale`, rather than the ambiguous flat state `status: stale`. Stale evidence may remain structurally valid and usable under some resolver policies while still requiring an explicit warning (ARCH-43).

### Refresh state is separate

`refresh_in_progress` is not returned by the external adapter. It is produced by the cache/discovery orchestration defined by ARCH-61. The catalog/cache layer exposes:

```ts
type RefreshState = "idle" | "in_progress";
```

A caller may see `cached evidence: available`, `freshness: stale`, `refresh: in_progress` and continue using the stale snapshot explicitly. If no usable cache exists, `evidence: unavailable` with `refresh: in_progress` may be surfaced to the user as `refresh_in_progress`. This prevents lock coordination from leaking into every source adapter.

### Catalog evidence envelope

After adapter evidence enters `catalog/`, it becomes a normalized envelope:

```ts
interface CatalogEvidence<T> {
  value: T;

  provenance: Provenance;

  observedAt?: string;

  freshness: Freshness;

  confidence: Confidence;

  availability: "available" | "unavailable" | "unknown";

  refresh: RefreshState;
}
```

Field-level facts retain their individual provenance as required by ARCH-28. A merged catalog record does not assign one global winning source to the entire model.

### Authority

The adapter descriptor does not declare itself globally authoritative. Authority is field-specific and is applied by `catalog/` according to the source rules in §3 (ARCH-28): local Codex invokability comes from Codex runtime discovery, provider API model existence comes from the provider API for that fact, and Dotbabel workload classification comes from Dotbabel policy. A source adapter supplies evidence and provenance. It does not decide how its evidence ranks for unrelated fields.

### Knowledge-source adapters

Knowledge-source adapters use the same descriptor. Capabilities that make no sense for them are explicit:

```yaml
kind: knowledge-source

capabilities:
  discovery:
    support: supported
    network: required
    auth: none
    cacheable: true
    execution: read-only

  observation:
    support: unsupported

  binding: {}

  invocation:
    support: unsupported
    axes: {}

  validation:
    support: unsupported
```

This keeps one adapter contract without pretending that runtime and catalog sources expose the same operations.

### Invariant

The interface maintains three independent dimensions: static support ≠ current operation outcome ≠ freshness / refresh state. No consumer may collapse those dimensions into a single boolean such as `available`.

## Resolver Contract

Decided by the owner on 2026-09-18. `resolver/` is a pure deterministic decision engine (ARCH-56, ARCH-57 rule 1). For identical explicit inputs, it produces an identical result.

```ts
resolve(input: ResolverInput): ResolverResult
```

### Input

```ts
interface ResolverInput {
  requirement?: NormalizedComputeRequirement;

  policy: EffectivePolicy;

  target: {
    runtimeId: RuntimeId;
    artifactKind: ArtifactKind;
  };

  catalog: CapabilityCatalogSnapshot;

  runtimeContract: RuntimeCapabilityContract;

  observed?: ObservedEffectiveConfiguration;
}
```

`now` is **not** a resolver input. Freshness is computed before resolution by `catalog/`, which supplies already-normalized `fresh | stale | expired | unknown` evidence. The resolver consumes that state rather than interpreting timestamps itself.

**Requirement.** `requirement` is the normalized representation produced by `requirement/` and `compat/`:

```ts
interface NormalizedComputeRequirement {
  requirement?: WorkloadClass;
  binding: "self" | "session" | "consumer";
  mode: "dynamic" | "floor" | "pin" | "inherit";
  pin?: RuntimePin;
  rationale?: string;

  provenance: Provenance;
}
```

Absence means the artifact supplies no canonical requirement of its own. Compatibility-derived requirements retain provenance identifying them as legacy-derived (ARCH-18).

**Policy.** `policy` is already merged from `shipped → user → project → artifact / explicit invocation` (ARCH-23), but the resolver does **not** interpret this as generic last-write-wins. Each layer contributes typed constraints or preferences, preserving the source layer, the declaration type, the semantic requirement, the pin if any, the rationale, and the provenance. The resolver composes those declarations according to their semantics.

**Target.** `target.artifactKind` is required because binding support is scoped by `runtime × artifact kind × configuration axis` (KD-4). For example, `copilot + agent` and `copilot + skill` can have different model-binding capabilities.

**Catalog.** `catalog` contains only already-loaded evidence. The resolver performs no discovery, subprocess execution, network request, cache read, cache write, or clock read. It consumes field-level provenance, availability, freshness, confidence, classifications, and concrete runtime configurations supplied by `catalog/`.

**Runtime contract.** `runtimeContract` supplies the verified binding and invocation capabilities required to compute enforcement state. It is data, not an adapter call.

**Observed configuration.** `observed` is optional. When available, it describes the effective runtime/session configuration currently observed by the runtime adapter. It is used particularly when the artifact cannot enforce configuration itself but Dotbabel wants to determine whether the current environment nevertheless satisfies the requirement. Absence of observation remains distinguishable from observed non-compliance.

### Result

```ts
interface ResolverResult {
  status: "resolved" | "unresolved" | "conflict" | "invalid";

  configuration?: ResolvedRuntimeConfiguration;

  enforcement: {
    state: "enforced" | "satisfied-not-enforced" | "unsatisfied" | "unknown";

    basis: "artifact-binding" | "session-observation" | "invocation" | "none";
  };

  confidence: Confidence;

  explanation: ResolutionReason[];

  diagnostics: ResolverDiagnostic[];
}
```

| `status`     | Meaning                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolved`   | Dotbabel found one concrete runtime-native configuration satisfying all effective hard constraints.                                                                                                                                                                                                                                                     |
| `unresolved` | The requirements are internally valid, but available evidence is insufficient to choose a concrete configuration safely (ARCH-16, ARCH-26). Examples: no usable model evidence; only expired evidence where policy forbids its use; a required configuration axis cannot be determined; a required pin is unavailable and no substitution is permitted. |
| `conflict`   | Two valid declarations impose incompatible constraints and neither may be silently discarded under the precedence/constraint rules. Example: artifact floor `frontier` against a project pin whose model is classified only as `routine`.                                                                                                               |
| `invalid`    | The input itself violates the Model Intelligence contract: a malformed pin; a pin targeting a different runtime where the declaration does not permit that; an impossible normalized state that `requirement/` should normally have caught.                                                                                                             |

### Resolved configuration

```ts
interface ResolvedRuntimeConfiguration {
  runtimeId: RuntimeId;

  axes: Record<string, unknown>;

  representation: {
    kind: "stable-alias" | "native-id" | "opaque-selector";
    provenance: Provenance;
  };
}
```

`axes` contains the runtime-native configuration selected by the runtime contract. The resolver treats values as opaque except where the relevant adapter/catalog evidence supplies explicit semantics, and it never generically decomposes identifiers based on spelling (ARCH-17). `representation.kind` records the ARCH-54 decision: the runtime adapter/catalog contract determines whether a stable alias, native identifier, or opaque selector is appropriate.

### Constraint composition

The precedence chain is applied **within compatible constraint types**, not as arbitrary object replacement. The resolver distinguishes `inherit`, dynamic requirement, `floor`, and `pin`, because each has different semantics.

**`inherit`** contributes no new model requirement. It means: this scope does not introduce its own compute policy; use the effective enclosing/lower-scope policy and runtime context. It does not erase a user or project policy:

```text
user pin: X                        project dynamic requirement: deep
artifact: inherit                  artifact: inherit
→ X remains effective              → deep remains effective
```

If nothing underneath supplies a requirement, the resolver may return no concrete recommendation and preserve runtime inheritance (PB-8).

**`dynamic`** asks the resolver to choose any configuration that satisfies the semantic workload requirement. A broader user/project pin may be honored if that pin satisfies the dynamic requirement:

```text
artifact dynamic: deep             artifact dynamic: deep
user pin: model X                  user pin: model Y
X satisfies deep                   Y only satisfies routine
→ resolve X                        → conflict / unsatisfied
```

The resolver does not silently use Y and pretend the artifact requirement was satisfied. Nor does it silently discard an explicit pin and select another model without explaining the conflict.

**`floor`** is a monotonic minimum capability constraint. The effective result may be stronger, but never weaker than the floor. Floors compose by taking the strongest applicable minimum:

```text
shipped floor: routine
project floor: deep
artifact floor: frontier

effective floor: frontier
```

A lower-precedence or broader-scope declaration may strengthen a floor but may never weaken a more specific floor.

**`pin`** requests one exact runtime-native configuration and suppresses dynamic market selection within its effective scope. Where multiple pins apply at different precedence scopes, the most specific pin wins:

```text
shipped pin < user pin < project pin < artifact pin < explicit invocation pin
```

A shadowed pin is not silently forgotten; the explanation records that a more specific declaration superseded it.

### Precedence is not safety override

Two concepts remain separate: specificity precedence decides which preference or pin applies; constraint composition decides whether that choice is permitted.

- **ARCH-66**: An artifact pin overrides a user or project pin. The artifact is the more specific declaration for that unit of work, whether the shadowed pin would be weaker or stronger. An invocation-level pin, when explicitly supplied, is more specific again.
- **ARCH-67**: A pin is usable only if it satisfies every effective floor. A user, project, or invocation pin cannot override an artifact floor; it may constrain selection only when the pinned configuration satisfies that floor. Otherwise the result is `conflict` with enforcement `unsatisfied`, never a resolution to the pinned configuration. This preserves PB-1 and PB-13.

```text
artifact floor: frontier
invocation pin: routine-model

→ status: conflict, enforcement: unsatisfied    (not: resolved routine-model)
```

This prevents an exact-model preference from becoming an accidental mechanism for bypassing safety requirements.

### Enforcement states

The resolver reports exactly the four states of ARCH-48.

| State                    | Meaning                                                                                                                                                                                                                                                 | Example                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `enforced`               | The selected requirement can be encoded at the declared binding scope using the verified runtime contract. `enforced` means a verified native enforcement path exists at that scope; runtime materialization still owns writing the generated artifact. | Claude agent, `binding: self`, resolved model `opus`, agent model binding supported → `basis = artifact-binding`.             |
| `satisfied-not-enforced` | The artifact cannot bind the configuration at that scope, but an observed enclosing/effective configuration is known to satisfy it. Current satisfaction does not become an artifact guarantee.                                                         | Skill requirement `deep`, skill binding unsupported, observed session model satisfies `deep` → `basis = session-observation`. |
| `unsatisfied`            | Dotbabel has enough evidence to determine that the effective/current configuration does not satisfy the requirement.                                                                                                                                    | Skill floor `frontier`, observed session `routine`; or artifact floor `frontier`, effective pin a `routine` model.            |
| `unknown`                | Dotbabel cannot determine whether the requirement is currently satisfied. Unknown is never upgraded to satisfaction merely because no error occurred.                                                                                                   | Artifact has no native binding, and the runtime has no usable observation mechanism.                                          |

`status` and `enforcement.state` are orthogonal. `resolved` + `satisfied-not-enforced` means Dotbabel knows which configuration satisfies the requirement and observes that the current environment satisfies it, but this artifact cannot enforce it. `resolved` + `unknown` can mean Dotbabel can recommend a concrete configuration, but the runtime neither binds nor exposes enough current state to prove that the recommendation is active.

### Confidence

`confidence` describes confidence in the resolution itself, not model quality. It is derived from the quality, freshness, and completeness of the evidence used, and it never becomes a numeric model ranking (§2, "Universal model scoring"). The exact confidence enum is defined with the catalog contract, and all confidence changes are explainable through provenance.

### Explanation

`explanation` is ordered and machine-readable:

```ts
interface ResolutionReason {
  code: string;
  message: string;
  provenance?: Provenance;
}
```

Typical reasons: `artifact_floor_applied`, `project_pin_selected`, `lower_scope_pin_shadowed`, `pin_satisfies_floor`, `pin_below_floor`, `fresh_local_availability_preferred`, `stale_evidence_used`, `artifact_binding_supported`, `binding_unavailable`, `observed_session_satisfies_requirement`. Human-readable CLI output is rendered from these reasons. The resolver does not construct ad hoc prose as its only explanation format.

### Diagnostics

Diagnostics represent conditions requiring attention rather than ordinary selection reasons: `pin_unavailable`, `pin_floor_conflict`, `insufficient_capability_evidence`, `binding_unverified`, `observation_unavailable`, `expired_evidence`, `legacy_requirement_ambiguous`. No diagnostic may cause the resolver to silently invent a fallback that violates an explicit pin or floor.

### Core precedence rules

```text
inherit  → contributes no new constraint
dynamic  → choose any configuration satisfying the semantic requirement
floor    → impose a minimum; strongest applicable floor wins
pin      → exact selection; most specific applicable pin wins,
           but it must satisfy every effective floor

artifact pin vs user/project pin     → artifact pin wins (ARCH-66)
user/project pin vs artifact floor   → pin accepted only if it satisfies the floor,
                                       otherwise conflict / unsatisfied (ARCH-67)
```

## CLI Surface

Decided by the owner on 2026-09-18. Model Intelligence is exposed under one Dotbabel umbrella command, `dotbabel models <verb>`, registered next to the existing subcommands in `plugins/dotbabel/bin/dotbabel.mjs:34-48`. `models` is preferred over a new top-level binary family because these operations belong to one subsystem and share the same requirements, catalog, resolver, and configuration. A standalone `dotbabel-models` bin may mirror the umbrella command if Dotbabel continues the existing standalone-bin convention, but both surfaces invoke the same implementation (ARCH-58).

### Commands

| Command                                                                           | Purpose                                                                                           | Reads                                                 | Writes                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------- |
| `dotbabel models refresh [--source <id>] [--runtime <id>]`                        | Refresh runtime/catalog evidence                                                                  | runtimes, external sources, existing cache            | capability cache                        |
| `dotbabel models status [--json] [--check]`                                       | Inspect source support, cache freshness, runtime availability, projections, and release baselines | config, cache, release snapshot, generated provenance | none                                    |
| `dotbabel models resolve <artifact> --runtime <id> [--json]`                      | Resolve one artifact and explain the complete decision                                            | artifact, policy, catalog, optional observation       | none                                    |
| `dotbabel models resolve --requirement <class> --runtime <id> [options] [--json]` | Resolve an ad hoc semantic requirement without an artifact                                        | policy, catalog, optional observation                 | none                                    |
| `dotbabel models recommend <artifact> --runtime <id> [--json]`                    | Produce user-facing design-time/runtime advice from resolver output and observation               | artifact, policy, catalog, optional observation       | none                                    |
| `dotbabel models migrate [path] [--check \| --write] [--json]`                    | Analyze or migrate legacy model/effort declarations to `dotbabel.compute`                         | canonical artifacts, compatibility rules              | canonical artifacts only with `--write` |
| `dotbabel models snapshot [--check \| --write] [--json]`                          | Validate or explicitly regenerate the release-time capability snapshot                            | configured sources, existing snapshot                 | release snapshot only with `--write`    |

### `refresh`

`refresh` is the normal discovery operation. It invokes only the selected/applicable source adapters, follows ARCH-61 cache locking, validates candidates before replacement, preserves a valid previous cache when refresh fails (ARCH-30), and never modifies canonical artifacts, runtime configuration, or the release snapshot. With no filters, it refreshes all configured sources that support discovery. `--runtime <id>` restricts runtime discovery; `--source <id>` restricts one source adapter; the two may be combined where meaningful.

### `status`

`status` is the Model Intelligence doctor surface (ARCH-43). It reports, where applicable: adapter support, source availability, cache freshness, refresh state, local runtime evidence, release snapshot age/provenance, generated projection provenance, projection drift, and shipped baseline versus fresher local resolution. It does not perform a refresh implicitly (ARCH-33). Normal `dotbabel models status` is informational and may report stale or unavailable optional sources while still exiting successfully. `--check` turns status into a CI/policy gate; the exact required conditions are defined by the project's effective Model Intelligence policy rather than by treating every unavailable optional source as failure.

### `resolve`

`resolve` is the authoritative resolver/explainer interface. It prints the effective semantic requirement, effective floors and pin, target runtime/artifact kind, selected configuration if any, representation used, enforcement state, confidence, ordered resolution reasons, diagnostics, and provenance. There is no separate `explain` verb: explanation is part of the resolver contract, so `resolve` always explains the result. `--json` exposes the structured `ResolverResult` rather than separately reimplementing explanation logic.

### `recommend`

`recommend` consumes `resolve()` rather than selecting models itself (ARCH-57 rule 2). Its purpose is user-oriented advice such as:

```text
Current session: <observed config>
Artifact requirement: frontier floor
Recommended configuration: <resolved config>
Current state: unsatisfied
Invocation: <runtime-native recipe>
```

It may incorporate runtime observation when available. It never changes the active runtime configuration (ARCH-10). A recommendation that differs from the user's current configuration is not itself an error.

### `migrate`

Default invocation is a dry analysis that reports legacy declarations found, known semantic mappings, ambiguous declarations, dual-declaration conflicts, proposed canonical `dotbabel.compute` declarations, and preserved pins/floors. It writes nothing. `--check` is CI mode: it writes nothing and fails when migration policy requires action. `--write` applies only unambiguous, policy-approved canonical artifact changes. `--check` and `--write` are mutually exclusive. Ambiguous class-F cases (DOC-1, "Migration Classification") are never guessed by `--write` (ARCH-18).

### `snapshot`

`snapshot` is explicitly a **release/build operation**, not normal cache refresh. Default `dotbabel models snapshot` shows what would change. `--check` verifies that the committed release snapshot is reproducible/current according to release policy without modifying it (ARCH-39). `--write` performs the explicit serialized snapshot mutation from ARCH-64. Normal `refresh` never modifies this snapshot.

### Exit codes

The codes follow the existing Dotbabel quality convention. The meanings are shared, but each verb maps its own domain state into them.

| Code | Meaning                                                                                  | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | Operation completed successfully                                                         | refresh completed, including a valid no-op; status completed informationally; resolve returned `resolved`; recommend produced usable advice; migrate dry-run found nothing blocking; migrate `--check` found the tree compliant; snapshot `--check` matched the committed snapshot. An advisory recommendation that the user should change models still exits `0`.                                                                               |
| `1`  | Semantic / policy / consistency failure that Dotbabel has enough information to identify | resolver status `conflict`; floor violated; pin below floor; dual canonical/legacy declaration conflict; migrate `--check` finds required migration; projection drift under `status --check`; snapshot `--check` detects reproducibility drift; release floor cannot be satisfied. `unresolved` caused by logically valid but insufficient capability evidence may be `1` when the failure is semantic/policy-related rather than environmental. |
| `2`  | Required environment, source, runtime, auth, or trust unavailable                        | required runtime binary missing; required existing authentication unavailable; required network source unreachable; required discovery operation unavailable; refresh lock held and no usable cache exists; required observation cannot be performed. An optional source being unavailable does not automatically cause exit `2`.                                                                                                                |
| `64` | Invalid command usage only                                                               | unknown runtime id; invalid workload class; missing required argument; mutually exclusive flags; malformed ad hoc requirement. Configuration or artifact content that parses correctly but creates a resolver conflict is not CLI misuse.                                                                                                                                                                                                        |

### JSON contract

Every read-oriented verb supports `--json`. JSON output uses stable structured objects from the Model Intelligence library rather than parsing human-readable CLI text: `resolve --json` → `ResolverResult`; `recommend --json` → recommendation envelope containing `ResolverResult`; `status --json` → source/cache/projection status envelope; `refresh --json` → per-source refresh results. Human-readable output is a renderer over those structures (ARCH-47).

### No implicit mutation

```text
inspection / resolution / recommendation → never writes canonical state
refresh                                  → may write only reconstructible capability cache
migrate --write                          → may write canonical artifacts
snapshot --write                         → may write release snapshot
sync/bootstrap/build                     → may write generated runtime projections
```

No read-oriented Model Intelligence command silently changes the user's active model, runtime configuration, canonical artifacts, or release snapshot.

## Materialization and Provenance Contract

Decided by the owner on 2026-09-18. `materialize/` turns canonical artifacts plus a resolved runtime configuration into deterministic runtime-specific projections (KD-2 to KD-6, ARCH-38, ARCH-51, ARCH-52). A projection has three parts: canonical inputs → materializer → a generated runtime file plus a projection manifest entry. The generated file is runtime-facing; the manifest is Dotbabel-facing.

### Determinism

- **ARCH-68**: For identical canonical inputs, policy, capability evidence, runtime contract, resolver result, and Dotbabel version, `materialize(inputs)` produces byte-identical output. No wall-clock value participates in generated output: `generatedAt` appears neither in generated runtime files nor in projection identity; reproducibility does not depend on file modification time; operational timestamps, if useful, belong in logs/status output rather than the projection contract. This preserves ARCH-39 and ARCH-62.

### Generated-file marker

For frontmatter-based generated artifacts, the existing convention stays: the marker is a comment inside the frontmatter block, immediately after the opening delimiter, so runtime frontmatter parsers still see `---` on line 1 (`plugins/dotbabel/src/copilot-frontmatter.mjs:28-35`, `GENERATED_MARKER_PREFIX`). The marker is a comment, not runtime metadata. It contains enough deterministic information to associate the file with its manifest entry, but does not duplicate the full provenance object. Recommended shape:

```text
# dotbabel:generated projection=<projection-id> source=<canonical-path> — do not edit directly
```

`projection-id` is a deterministic digest derived from the materialization inputs. No timestamp appears in this marker. For runtime artifact formats without YAML frontmatter, the materializer uses the format's safe comment/header mechanism where one exists. If no safe marker can be emitted, the projection manifest remains authoritative.

**Why provenance is not emitted as YAML keys.** Provenance keys such as `sourceHash`, `inputsHash`, or `snapshotId` are not added to runtime-visible frontmatter unless that runtime explicitly supports such extension metadata. ARCH-51 still applies: generated runtime artifacts contain only metadata verified safe for that runtime. The full Dotbabel provenance belongs in the projection manifest.

### Projection manifest

Each Dotbabel-owned projection tree has one deterministic manifest. Conceptually:

```json
{
  "schemaVersion": 1,
  "toolVersion": "3.x.x",
  "entries": {
    "<generated-path>": {
      "projectionId": "<digest>",
      "sourcePath": "<canonical-path>",
      "sourceHash": "<digest>",
      "inputsHash": "<digest>",
      "outputHash": "<digest>",
      "runtimeId": "claude",
      "artifactKind": "agent",
      "snapshotId": "<release-snapshot-id-or-null>",
      "resolverResultHash": "<digest>",
      "runtimeContractHash": "<digest>"
    }
  }
}
```

The exact serialization format belongs to implementation, but the semantic fields are required:

| Field                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectionId`        | A deterministic identifier for one complete projection derivation, derived from normalized projection inputs rather than generated randomly: conceptually `hash(sourceHash + effective policy + resolver result + runtime contract + relevant capability/snapshot evidence + materializer schema/version)`. The hashing algorithm is an implementation detail but is stable within a projection schema version. |
| `sourceHash`          | Hash of the canonical source artifact used to generate the projection.                                                                                                                                                                                                                                                                                                                                          |
| `inputsHash`          | Hash of all normalized material inputs that can change generated output: canonical source, effective requirement, effective policy, resolver result, runtime materialization contract, relevant capability evidence / release snapshot, and materializer version/schema. It excludes nondeterministic operational data such as timestamps, PID, temporary paths, and cache lock state.                          |
| `outputHash`          | Hash of the final generated file bytes.                                                                                                                                                                                                                                                                                                                                                                         |
| `snapshotId`          | Present when generation uses the release-time capability snapshot (KD-3, KD-6). Absent/null for a local projection that does not depend on that snapshot.                                                                                                                                                                                                                                                       |
| `resolverResultHash`  | Digest of the normalized resolver result used for projection. This gives provenance for the concrete model/configuration without making the generated file itself the canonical record (ARCH-20).                                                                                                                                                                                                               |
| `runtimeContractHash` | Digest/version of the adapter/materialization contract that determined which fields were safe to emit. It lets Dotbabel detect projections that became stale because runtime translation rules changed even when the canonical artifact did not.                                                                                                                                                                |

### No timestamp in projection identity

`generatedAt`, `refreshedAt`, current time, process start, PID, and temporary filename appear in none of: generated runtime content, `projectionId`, `inputsHash`, or deterministic projection manifest content. Those values would cause identical builds to differ. `dotbabel models status` may report filesystem modification time or operational refresh times as observational information, but those values are not provenance inputs.

### Drift classification

Drift is more than "generated file hash differs from manifest". The manifest and current canonical inputs let Dotbabel distinguish these conditions:

| Condition           | `outputHash` | `inputsHash` | Interpretation                                                                                                                                                                                                                            |
| ------------------- | ------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean               | matches      | matches      | Projection is current.                                                                                                                                                                                                                    |
| User/output drift   | differs      | matches      | Dotbabel-owned output was modified outside the materializer. ARCH-52 applies.                                                                                                                                                             |
| Stale projection    | matches      | differs      | The generated file still matches what Dotbabel previously wrote, but its canonical inputs changed: canonical artifact edits, policy changes, snapshot changes, or materialization-contract changes. Regeneration is required.             |
| Diverged projection | differs      | differs      | Both the source derivation and the generated output differ from the recorded generation. Dotbabel does not guess which changed first; it reports both facts and requires regeneration/conflict handling according to the owning workflow. |
| Missing projection  | file absent  | —            | The manifest expects a generated file that does not exist. This is drift.                                                                                                                                                                 |
| Orphan projection   | —            | —            | A generated marker/manifest entry exists for a canonical source or projection target that no longer exists. This is stale generated state and may be cleaned by an explicit sync operation.                                               |

### Materialization transaction

Materialization follows ARCH-62. Under the projection-tree lock:

1. Load canonical artifacts.
2. Load existing projection manifest.
3. Recompute normalized materialization inputs.
4. Detect drift before overwriting existing generated files.
5. Resolve/render all target projections.
6. Write each generated file using atomic replacement (ARCH-59).
7. Write the new manifest using atomic replacement.
8. Release the transaction lock.

- **ARCH-69**: The manifest is committed last. Readers treat a manifest entry as the authoritative declaration of the completed projection generation. If the process fails before the manifest update, the next drift/sync operation detects the incomplete generation and repairs it rather than assuming success.

### User-edited generated files

A generated projection is Dotbabel-owned. If its `outputHash` differs while its `inputsHash` remains unchanged, Dotbabel classifies the file as user/output drift. Normal sync does not silently reinterpret that edited runtime file as canonical policy. Whether sync overwrites, refuses, or requires an explicit `--force` is an implementation/migration decision for §6, but the provenance contract always identifies the canonical side: canonical source plus manifest inputs are the source of truth; the edited generated file is drift.

### Release versus local projections

The same manifest contract applies to both. A release baseline derives from `sourceHash + policy + release snapshot id + resolver result + runtime contract`. A local projection derives from `sourceHash + policy + locally usable capability evidence + resolver result + runtime contract`. A local projection may differ from a release baseline without either being corrupt; their provenance identifies the different input evidence that produced them (ARCH-40).

### Core invariant

- **ARCH-70**: Projection provenance is based on **what produced the file**, not **when the file was produced**. Same meaningful inputs → same `projectionId` → same generated bytes → same manifest entry. Time belongs to operational observation, not deterministic materialization.

## Release-Time Capability Snapshot

Decided by the owner on 2026-09-18. The release-time capability snapshot is a version-controlled, deterministic input used to produce runtime projections that cannot rely on local discovery (§3, fifth data store). In v1 its primary consumers are the Claude plugin baseline projections from KD-3 and the generated `ai-review.yml` session projection from KD-6. The format is extensible to additional runtimes without changing the resolver contract.

### Location

One canonical snapshot lives inside the published Dotbabel package, for example `plugins/dotbabel/src/model-intelligence/snapshot/release-capabilities.json`. The exact filename may change during implementation, but the architectural requirements are: it is version-controlled; it is included in the npm package; `snapshot/`, the plugin build, and workflow generation read the same file; package/build consumption requires no network (ARCH-39); and there is one authoritative release snapshot rather than independent copies per template. A schema for the file lives adjacent to the snapshot or under the existing `schemas/` infrastructure.

### Top-level shape

```json
{
  "schemaVersion": 1,
  "snapshotId": "<deterministic-digest>",
  "toolVersion": "3.x.x",

  "sources": [
    {
      "sourceId": "claude",
      "sourceKind": "runtime",
      "sourceVersion": "2.x.x",
      "observedAt": "2026-09-18T00:00:00Z"
    }
  ],

  "runtimes": {
    "claude": {
      "models": {},
      "runtimeContract": {},
      "provenance": {}
    }
  }
}
```

The exact normalized model fields belong to the catalog/domain schema, but the snapshot contains only data needed to reproduce release-time resolution plus enough provenance to explain where those facts came from.

### Identity

- **ARCH-71**: `snapshotId` is deterministic. It is computed from a canonical serialization of the projection-relevant snapshot content, excluding `snapshotId` itself, `observedAt`, filesystem metadata, current time, PID, temporary paths, and lock state. Conceptually `hash(schemaVersion + toolVersion where semantically relevant + normalized source identities/versions + runtime capability facts + field-level provenance + runtime contract facts)`. The hash algorithm and canonical JSON serialization belong to implementation but are stable within a snapshot schema version. Two snapshot generations with identical meaningful evidence produce the same `snapshotId`.

### `observedAt`

`observedAt` remains in the snapshot. It records when a source observation actually occurred and serves provenance, `dotbabel models status`, release review, and the decision whether maintainers should refresh a snapshot before release. It is **not** part of `snapshotId`, and it is **not** interpreted by the normal package build. A build performed today and the same build performed next month against the same committed snapshot produce byte-identical release projections (ARCH-68). The release build therefore never recomputes snapshot freshness from `Date.now()` to alter a resolver result. The explicit snapshot workflow is responsible for determining whether evidence is acceptable before the snapshot is committed.

### Snapshot evidence versus cache evidence

The live `CatalogEvidence` envelope is not persisted unchanged. The capability cache may contain operational state such as freshness, `refresh: in_progress`, temporary unavailability, and cache expiry; those states do not belong in an immutable release input. The release snapshot contains **accepted evidence**:

```ts
interface ReleaseEvidence<T> {
  value: T;

  provenance: Provenance;

  observedAt?: string;

  confidence: Confidence;

  sourceVersion?: string;
}
```

It does not contain `refresh_in_progress`, cache lock state, TTL remaining, a computed fresh/stale state relative to the current clock, or a transient network failure. If a source cannot produce acceptable evidence during `snapshot --write`, the snapshot operation fails rather than committing transient failure state as release truth.

### Field-level provenance

The body retains provenance at the field level, as required by ARCH-28. One model record may conceptually contain:

```json
{
  "id": "opus",
  "facts": {
    "availability": {
      "value": true,
      "provenance": { "sourceId": "claude" }
    },
    "capabilityClass": {
      "value": "frontier",
      "provenance": { "sourceId": "dotbabel-policy" }
    }
  }
}
```

The exact normalization may differ, but the snapshot does not flatten multiple sources into an unattributed record. A release projection remains explainable after the network and source systems that produced the snapshot are unavailable.

### Runtime contract data

The snapshot may contain the runtime-specific facts needed for deterministic materialization, including verified representation information such as supported stable aliases, native model identifiers, supported reasoning axes, artifact binding capabilities, and representation choice inputs (ARCH-54). It does not contain arbitrary current market data that release projections do not need. This keeps the snapshot bounded and reviewable.

### Policy remains separate

The release snapshot does not contain Dotbabel's permanent semantic policy (ARCH-15). "Security review requires >= frontier" belongs to shipped policy. The snapshot may contain evidence such as "Claude selector X satisfies frontier", with provenance. Release resolution combines shipped semantic policy plus the release capability snapshot through the resolver into the release projection.

### Snapshot generation

`dotbabel models snapshot --write` is the only normal operation that updates the committed snapshot. Under the ARCH-64/ARCH-65 lock:

1. Invoke configured source adapters.
2. Normalize the returned evidence.
3. Reject unsupported, malformed, or insufficient required evidence.
4. Apply snapshot acceptance policy.
5. Canonically serialize the candidate.
6. Compute `snapshotId`.
7. Write via atomic replacement.
8. Release the snapshot lock.

Normal `models refresh` never modifies this file.

### `snapshot --check`

`dotbabel models snapshot --check` validates the committed release input. It may verify schema validity, deterministic `snapshotId`, required source/runtime coverage, release-floor satisfiability, that generated baseline projections reproduce from the committed snapshot, and release-policy freshness requirements, where the check explicitly uses current operational time. A time-based release-policy warning or failure from `--check` does not alter the snapshot or its identity. The package build itself remains deterministic and clock-independent.

### v1 scope

The schema supports multiple runtimes from the beginning (`runtimes.claude`, `runtimes.codex`, `runtimes.gemini`, and so on), but v1 is not required to populate runtimes that have no release-time projection consumer. Initially, Claude is the required runtime because KD-3 and KD-6 consume a release baseline. Additional runtime sections are added only when a shipped deterministic projection requires them. This avoids turning the snapshot into a second global model catalog (ARCH-21).

### Missing required evidence

If release generation requires a floor or pin that the snapshot cannot satisfy, `snapshot --write` fails and the build/release check fails. Neither omits the model, falls back to the runtime default, guesses a newer model, or uses the live network during the build. This realizes ARCH-41 and ARCH-55.

### Snapshot provenance and projection provenance

Release projection manifests record `snapshotId` as one of their deterministic inputs, which gives the chain: source evidence → release snapshot (`snapshotId`) → resolver result → runtime projection (`projectionId`). `dotbabel models status` can traverse that chain and explain which committed capability snapshot produced a shipped baseline (ARCH-43).

### Core invariant

- **ARCH-72**: The release snapshot records the accepted capability facts used to make a release decision, not whatever the external sources happen to say when a consumer later runs Dotbabel. Same committed snapshot + same policy + same materializer → same release projection, regardless of network availability, provider changes, or wall-clock time after the release.

## External APIs

The third-party APIs that the knowledge-source adapters consume are the official model/catalog APIs and Models.dev, as accepted in §3 `External APIs / Dependencies`. Their concrete request and response shapes are open under RQ-1 in [research/sources.md](../research/sources.md); this section receives them when that research lands. The runtime CLI surfaces that the runtime adapters call are recorded in DOC-2, "Runtime Capability Matrix".

## Internal APIs

The internal surface is the shared library contract of ARCH-58 and the contracts above: the `dotbabel.compute` declaration, the source adapter contract, the resolver contract, the materialization and provenance contract, the release snapshot, and the `dotbabel models` CLI. No HTTP endpoint exists, because Model Intelligence runs in-process (ARCH-32).

## Database Schema

N/A — there is no database (ARCH-22). The five file stores and their access patterns are in §3 `Data Stores`; the projection manifest and the release snapshot formats are above.
