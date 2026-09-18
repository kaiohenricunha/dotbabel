# §4 — Data Flow / Components

> Current state analysis + target architecture.

**Settled.** The owner decided every subsection between 2026-09-17 and 2026-09-18. KD-1 to KD-6 and ARCH-37 to ARCH-65 live here. The owner approved the `Current State` content on 2026-09-18.

## Current State

**Approved by the owner on 2026-09-18.** [current-state/analysis.md](../current-state/analysis.md) holds the full grounded analysis and the preserved behaviors PB-1 to PB-13. The flow today, from DOC-1 ("Model Configuration Architecture Today") with the DOC-2 correction for Copilot:

```text
artifact frontmatter (model:, effort:)            the only source of truth
   ├─ validate-skills-inventory.mjs               model ∈ 4 aliases; effort unchecked
   ├─ build-plugin                                mirrors both keys verbatim
   ├─ build-index.mjs                             drops both keys
   └─ project-sync.mjs
        ├─ .cli/skills      → Codex, Gemini CLI, OpenCode      keys kept verbatim
        ├─ .agents/skills   → Antigravity, and Copilot (unplanned, also via .claude/skills)   keys kept verbatim
        └─ .github/{prompts,instructions} → Copilot           keys dropped, with a warning
runtime                                           interprets or ignores; Dotbabel passes no --model or --effort
observation                                       handoff-extract.sh only; 4 runtimes, wrong for 2
```

No step resolves anything. The value that the author typed is the value that every runtime receives, and Dotbabel never learns which model ran.

## Component Boundaries

Decided by the owner on 2026-09-17. Model Intelligence lives under `plugins/dotbabel/src/model-intelligence/` as a cohesive subsystem.

| Module         | Responsibility                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain/`      | Own the stable internal data types and state vocabularies shared across Model Intelligence: requirements, binding scopes, resolution modes, source evidence, freshness/discovery states, enforcement states, resolved configurations, provenance, and errors. Contains no I/O and no provider/runtime-specific identifiers as policy. |
| `requirement/` | Parse and validate canonical `dotbabel.compute` declarations and convert them into the internal requirement representation.                                                                                                                                                                                                           |
| `compat/`      | Interpret legacy `model:` / `effort:` declarations where their meaning is known, detect conflicts with canonical declarations, and preserve ambiguous cases explicitly. Transitional per ARCH-19.                                                                                                                                     |
| `policy/`      | Define Dotbabel's semantic workload classes, capability floors, safety rules, and resolution preferences. Resolve shipped → user → project → artifact policy/constraints while retaining provenance.                                                                                                                                  |
| `sources/`     | Define source-adapter contracts and implementations for the six runtimes plus official/provider/catalog sources. Own subprocess and network interaction needed to collect or observe external facts.                                                                                                                                  |
| `catalog/`     | Normalize source evidence into field-level facts with provenance, confidence, availability, and freshness. Resolve source conflicts without erasing provenance. Own capability-cache persistence.                                                                                                                                     |
| `resolver/`    | Pure decision engine. Combine a requirement, policy, target runtime, and already-loaded catalog snapshot into a concrete resolution or explicit unresolved state, with explanation and enforcement status. Performs no filesystem, process, network, clock, or environment I/O.                                                       |
| `materialize/` | Translate a resolved configuration into runtime/artifact-specific projections under KD-2 through KD-5. Own generated-file rendering, provenance stamps, ownership checks, and drift detection.                                                                                                                                        |
| `recommend/`   | Build design-time and runtime-advisory results from resolver output and observed configuration. It does not independently select models or duplicate resolver policy.                                                                                                                                                                 |
| `snapshot/`    | Define, validate, read, write, and build the version-controlled release-time capability snapshot used by plugin templates and deterministic shipped automation. Integrates with the package/build pipeline.                                                                                                                           |

### Dependency Direction

Dependencies point inward, toward the stable domain and decision logic:

```text
                    CLI / existing consumers
                            │
               ┌────────────┴────────────┐
               │                         │
          recommend/                materialize/
               │                         │
               └──────────┬──────────────┘
                          ▼
                      resolver/
                     ↙        ↘
                policy/       catalog/
                  │             ▲
            requirement/      sources/
                  ▲
                compat/
                   \           /
                    \         /
                     domain/
```

`snapshot/` feeds catalog/resolution inputs during release/build workflows and is consumed by build integration rather than sitting on the normal runtime hot path.

### Purity and I/O Boundaries

The rule is not "adapters do all I/O".

- **ARCH-56**: Core decision modules are pure; boundary modules own only the I/O associated with their responsibility:
  - `domain/` — no I/O.
  - `requirement/` — parsing/validation over supplied data; no filesystem ownership.
  - `compat/` — pure interpretation over supplied artifact data.
  - `policy/` — pure merge/evaluation over supplied policy layers.
  - `resolver/` — strictly pure and deterministic for identical inputs.
  - `recommend/` — pure presentation/advisory composition over supplied resolver/observation results.
  - `sources/` — subprocess, runtime inspection, and network I/O.
  - `catalog/` — capability-cache filesystem I/O.
  - `snapshot/` — version-controlled snapshot filesystem/build I/O.
  - `materialize/` — generated-artifact filesystem I/O and drift checks.

The CLI or existing Dotbabel consumer orchestrates these boundaries: it loads configuration and requirements, requests discovery/cache data, invokes the resolver, and optionally materializes or renders the result.

Consequence for §5: the resolver cannot read the clock, so a freshness state reaches it as data. `catalog/` or the caller computes that state before the call.

### Dependency Rules

- **ARCH-57**:
  1. `resolver/` never imports a source adapter, filesystem helper, subprocess API, HTTP client, or environment-dependent runtime state.
  2. `recommend/` never implements an independent model-selection algorithm; all selection comes from `resolver/`.
  3. `materialize/` never classifies model strength. It consumes a resolved configuration and runtime capability contract.
  4. `sources/` report evidence; they do not decide whether a model satisfies `deep`, `frontier`, or another Dotbabel workload class.
  5. `catalog/` normalizes facts and provenance; it does not make task-specific selections.
  6. `policy/` defines Dotbabel judgment but does not discover models or perform runtime I/O.
  7. `compat/` may translate legacy declarations but does not become a permanent second policy system (ARCH-19).
  8. No Model Intelligence module imports from `quality/`.

The existing quality subsystem may serve as architectural precedent for state vocabularies, layered policy, provenance, and failure handling, but Model Intelligence does not depend on it at runtime (§2, `Does Not Redesign`).

### Shared Library Contract

- **ARCH-58**: Existing consumers such as artifact validation, `project-sync`, bootstrap/build generation, handoff observation, design-time tooling, and future Model Intelligence CLI commands consume this shared library. They do not maintain separate model tables, effort enums, workload classifications, or resolution logic outside `model-intelligence/`. Provider- or runtime-specific knowledge that affects resolution enters through an adapter, capability snapshot, or explicit runtime materialization contract rather than being re-hardcoded in a consumer. This makes ARCH-31 concrete. DOC-1 counts 9 independent declarations of the model enum today (DOC-1, "Duplication Analysis").

## Shared State

Decided by the owner on 2026-09-18. Model Intelligence has no daemon, database, or in-memory state shared between processes (ARCH-32). Cross-process state consists only of files.

| State                            | Writer                                     | Concurrency / ownership rule                                                                                                                              |
| -------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability cache                 | Any process performing discovery/refresh   | Per-cache-key coordination. Writes use temp file + atomic rename. A concurrent refresh must not allow an older observation to overwrite newer evidence.   |
| Release-time capability snapshot | Explicit release/snapshot command          | Version-controlled, deterministic release input. Mutation is explicit and serialized; normal resolution only reads it.                                    |
| Generated runtime projections    | `materialize/` during build/bootstrap/sync | Dotbabel-owned derived files. Writes use atomic replacement while holding a lock covering the projection transaction. User edits are drift under ARCH-52. |
| User/project configuration       | Explicit configuration command             | Resolution is read-only. Mutating commands serialize read-modify-write and replace the file atomically.                                                   |

Recommendations, resolver results, enforcement states, and runtime advice are not shared state and are not persisted merely because they were computed (ARCH-20).

### Atomic write primitive

- **ARCH-59**: Every Dotbabel-owned mutable file follows the existing pattern of `writeCacheAtomic` (`plugins/dotbabel/src/lib/handoff-preflight.mjs:93-99`): render the complete candidate, write `<target>.<pid>.<nonce>.tmp`, flush/close successfully, then rename atomically to the target. Readers never observe a partially written JSON/YAML document. Temporary files are implementation artifacts, not authoritative state, and may be cleaned after an interrupted process.

### Locking rule

- **ARCH-60**: Locks exist only where concurrent operations can change correctness. There is no global Model Intelligence lock. Each lock is scoped to the smallest coherent resource, and read-only resolution takes no lock.

```text
capability refresh    → cache entry/source key
user config mutation  → user config file
project config mutate → project config file
runtime materialize   → target projection tree / transaction
snapshot update       → release snapshot
```

### Capability cache

Unconditional last-writer-wins is **not sufficient**:

```text
Process A starts refresh at T1
Process B starts refresh at T2
Process B receives newer evidence and writes
Process A finishes slowly and writes afterward
```

Plain atomic rename would leave the cache with A's older observation.

- **ARCH-61**: Refresh of the same logical cache key is coordinated. A process that obtains the refresh lock: (1) re-reads the current cache after acquiring the lock; (2) determines whether a refresh is still needed; (3) performs discovery; (4) validates the complete candidate snapshot; (5) replaces the cache atomically; (6) releases the lock. A process that cannot obtain the lock does not start a competing refresh by default. It may use the existing structurally valid cache and mark it with its actual freshness state, or report `refresh_in_progress` or an equivalent state when no usable cache exists. This also collapses a thundering herd when several Dotbabel processes start simultaneously. ARCH-30 continues to apply: a failed, empty, malformed, or otherwise unusable discovery result never replaces a valid prior cache entry.

### Generated projections

Projection writes need stronger coordination than an individual file rename, because one sync can update several related runtime files.

- **ARCH-62**: The lock covers the **projection transaction**, not just the final `rename()`. Within the lock, `materialize/`: (1) reads existing ownership/provenance; (2) detects user edits/drift; (3) computes the full projection from canonical inputs; (4) writes each replacement atomically; (5) updates any projection manifest/provenance; (6) releases the lock. This prevents two concurrent syncs from interleaving files from different input generations. If two processes resolve from identical canonical inputs, their resulting files are byte-equivalent, and the lock still preserves transaction coherence. If they use different inputs, the later operation may replace the earlier projection, but provenance identifies exactly which canonical input/configuration produced the final state.

### Configuration

- **ARCH-63**: Resolution never mutates user or project configuration. An explicit configuration command that performs read → modify → write holds the corresponding configuration lock for that whole operation. Atomic rename alone would prevent corruption but would not prevent lost updates between two writers.

### Release snapshot

- **ARCH-64**: The release capability snapshot is not opportunistically refreshed by normal runtime use. Only an explicit snapshot/release operation may mutate it. That operation is serialized and writes atomically. Once committed, package builds treat the snapshot as immutable input (ARCH-39).

### Lock implementation

- **ARCH-65**: A lock is transient coordination state, not Model Intelligence data. The implementation uses a portable filesystem primitive with atomic acquisition, for example an exclusively created lock file or lock directory containing owner metadata such as the pid, the process start / acquisition time, and the resource identity. Locks are released in `finally`-style cleanup. A crashed process does not permanently wedge Model Intelligence. Stale-lock recovery is conservative and defined by §5/§6; deleting a lock solely because an arbitrary short timeout elapsed is not sufficient proof that its owner is dead. No correctness guarantee depends on advisory in-memory mutexes, because separate Dotbabel processes do not share memory.

### Resulting concurrency model

```text
READ
resolution / recommendation / inspection
→ lock-free

WRITE ONE COMPLETE FILE
→ atomic temp + rename

READ-MODIFY-WRITE
→ scoped lock + atomic temp + rename

MULTI-FILE COHERENT PROJECTION
→ transaction-scope lock + atomic per-file replacement

EXTERNAL REFRESH
→ per-key refresh lock + validation + atomic cache replacement
```

This keeps concurrency local and inexpensive while preventing partial writes, lost configuration updates, stale-cache regression, and mixed-generation runtime projections.

## Target Architecture

Written by the owner on 2026-09-18. The target architecture keeps one permanent decision flow:

```text
Requirement
  → Policy + Capability Catalog
  → Resolver
  → Runtime Materialization / Recommendation
```

Canonical artifacts declare provider-neutral compute intent through `dotbabel.compute` as defined by KD-1. Legacy `model:` and `effort:` handling remains only in the transitional `compat/` layer until migration is complete (ARCH-19).

Concrete runtime configuration is produced through three materialization paths:

1. **Local sync/bootstrap projection** — resolves against current local/runtime evidence where Dotbabel owns the generated artifact (KD-2, KD-5).
2. **Plugin release baseline projection** — uses the version-controlled release-time capability snapshot for plugin-delivered artifacts that bypass local resolution (KD-3).
3. **Generated workflow projection** — uses the same release-time snapshot for deterministic shipped automation such as `ai-review.yml` (KD-6).

Runtime projection is capability-gated per runtime, artifact kind, and configuration axis (KD-4). Unsupported or unverified binding remains explicit rather than being represented as effective configuration (ARCH-49).

KD-1 through KD-6 define the artifact declaration, Claude materialization, plugin baseline, cross-runtime fan-out, runtime-specific skill projection, and deterministic workflow projection contracts that implement this architecture.

### Key Decisions

#### KD-1: Artifacts declare Model Intelligence intent in new Dotbabel-namespaced frontmatter

Decided by the owner on 2026-09-17. An artifact's canonical Model Intelligence declaration lives in new Dotbabel-owned frontmatter keys alongside any runtime-native legacy keys. One namespaced object is preferred, for example:

```yaml
dotbabel:
  compute:
    requirement: deep
    binding: agent
    mode: dynamic
```

§5 finalizes the exact schema. §8 records the rejected alternatives A-1 and A-2. The declaration stays separate from the runtime-native `model:` and `effort:` fields.

**Why:**

- Semantic values must not be placed in `model:`, because runtimes such as Claude Code validate that field as runtime-native input. Claude Code rejects an agent with an unknown `model:` value (DOC-2, "Frontmatter Behaviour").
- Keeping the requirement in the artifact preserves locality: the intent travels with the agent, skill, or command it governs.
- A sidecar or central map would introduce a second artifact-to-policy synchronization problem.
- New namespaced metadata allows additive migration with no flag day. The three artifact schemas already set `additionalProperties: true` (`schemas/agent.schema.json:8`, `schemas/skill.schema.json:8`, `schemas/command.schema.json:8`).

**Dual-declaration rule.** When both the new semantic declaration and legacy `model:` / `effort:` exist:

1. The Dotbabel semantic declaration is authoritative for Model Intelligence.
2. Legacy `model:` / `effort:` are treated as a **runtime compatibility projection**, not a second source of intent.
3. Dotbabel does not merge conflicting declarations or choose one silently.
4. If both forms are present and their known meanings conflict, validation reports the mismatch.
5. If only the legacy form exists, the compatibility layer interprets it where its semantics are known and marks ambiguous cases explicitly (ARCH-18).
6. Once an artifact is fully migrated, runtime-native fields are emitted or retained only where the target runtime actually consumes them.

```text
semantic declaration present
        ↓
canonical intent
        ↓
resolver
        ↓
runtime-native projection

legacy declaration only
        ↓
compatibility interpretation
        ↓
semantic representation where unambiguous
```

The legacy declaration never overrides an explicit semantic declaration.

**Consequence for Claude.** For Claude artifacts where the source file is also the runtime-consumed file, a retained native `model:` value can still affect execution independently of Dotbabel. Skills and commands reach `~/.claude/` as symlinks (`plugins/dotbabel/src/bootstrap-global.mjs:4`), and a command `model:` replaces the model of the whole session (DOC-2, "Precedence, derived"). A migrated artifact therefore must not contain the following and have Dotbabel simply ignore the contradiction:

```yaml
dotbabel:
  compute:
    requirement: routine
    mode: dynamic

model: opus
```

Until Claude runtime materialization/projection is implemented, such dual declarations either remain deliberately synchronized or fail validation when inconsistent. This creates KD-2.

**Evidence notes for §5 and §6:**

- The hard gate reads frontmatter with a hand-written line parser that flattens indented lines into one string (`plugins/dotbabel/src/validate-skills-inventory.mjs:32-62`). It cannot read a nested `dotbabel:` object. The index builder uses `js-yaml` and can (`plugins/dotbabel/src/build-index.mjs:42-48`). The mismatch check of rule 4 needs a real YAML parse.
- No artifact under `agents/`, `commands/`, or `skills/` carries a nested mapping in its frontmatter today, and the DOC-2 probes used flat keys only. Whether each of the six runtimes accepts a nested mapping key is unverified.

#### KD-2: Claude materialization follows the artifact's actual runtime binding semantics

Decided by the owner on 2026-09-17: use a hybrid strategy (§8 rejects the single direct-file strategy as A-3). It preserves Claude's empirically observed binding semantics (PB-10) rather than forcing one materialization strategy onto all three artifact types.

**Agents.** Claude agents are materialized as generated runtime files. The canonical source artifact keeps the Dotbabel semantic declaration. During bootstrap/sync, Dotbabel resolves the requirement and projects the concrete Claude-native configuration into the copied file under `~/.claude/agents/`.

Canonical source:

```yaml
dotbabel:
  compute:
    requirement: deep
    binding: agent
    mode: dynamic
```

The generated Claude runtime file may contain:

```yaml
dotbabel:
  compute:
    requirement: deep
    binding: agent
    mode: dynamic

model: opus
effort: high
```

The concrete `model:` / `effort:` values in the generated file are derived runtime projection, not canonical policy.

**Commands.** Revised by the owner on 2026-09-17 to agree with KD-5. Claude commands are materialized as generated runtime files when the canonical source contains Dotbabel-private metadata or otherwise requires runtime-specific transformation.

A `dynamic` or `floor` command requirement does **not** receive a dynamically resolved native `model:` projection, because a Claude command `model:` changes the whole session (DOC-2, "Precedence, derived") and Model Intelligence is advisory at runtime (ARCH-10, PB-9).

The generated Claude command copy therefore:

- strips `dotbabel.compute` from the runtime-visible frontmatter;
- preserves the command body and other verified Claude-compatible metadata;
- emits no native `model:` for `dynamic` or `floor`;
- may retain/project a native `model:` only for an explicit `pin`, because changing the session is then an explicit property of that command rather than a resolver side effect (PB-7);
- follows ARCH-51 and ARCH-52 for projection ownership, provenance, and drift.

```text
canonical command
    ↓
generated Claude projection
    ↓
dynamic/floor → no model:
explicit pin  → native model: may be emitted
```

The command no longer relies on a symlink once runtime-specific projection is required. A symlink remains permitted only if the canonical command satisfies ARCH-51's zero-transformation conditions.

For a dynamic command, Dotbabel may recommend, for example: "This command requires frontier reasoning. Current session: Sonnet / medium. Recommended: Opus / high." It does not rewrite or inject the session model automatically.

**Skills.** Claude skills receive **no native model or effort projection**. DOC-2 established that Claude Code ignores `model:` and `effort:` on skills, so emitting those fields would create configuration that looks effective but is not. A skill may still declare semantic compute intent:

```yaml
dotbabel:
  compute:
    requirement: deep
    mode: dynamic
```

That declaration is metadata for Model Intelligence, not a Claude execution binding. The resolver uses it when advising or resolving the compute context that consumes the skill: for example, the enclosing agent, command, worker, workflow, or session. §5 names this non-native/consumer binding. The invariant is:

- **ARCH-37**: A skill requirement can influence compute selection; it does not itself bind compute.

**Derived projection versus durable state.** ARCH-20 reads: a resolved recommendation is never durable **canonical** state. Generated runtime projections are allowed because they are disposable derived artifacts, analogous to other generated Dotbabel fan-out (PB-12).

- **ARCH-38**: A generated runtime projection satisfies all of these conditions:
  1. The semantic declaration remains the source of truth.
  2. The generated concrete configuration records enough provenance to identify how it was derived.
  3. Regeneration may replace it whenever policy, discovery evidence, runtime version, or source declaration changes.
  4. Users do not edit generated projections as policy.
  5. A stale generated projection is detectable by sync/drift validation.
  6. Deleting generated projections and regenerating them reproduces the currently valid result from canonical inputs.

Allowed:

```text
canonical semantic requirement
          ↓
       resolver
          ↓
 disposable runtime projection
```

Forbidden:

```text
resolver chose model X once
          ↓
store model X as future policy
```

**Resulting Claude behavior:**

| Artifact               | Canonical semantic declaration | Native projection             | Runtime behavior                                  |
| ---------------------- | ------------------------------ | ----------------------------- | ------------------------------------------------- |
| Agent                  | Yes                            | Yes, in generated copy        | Concrete per-agent model/effort                   |
| Command, dynamic/floor | Yes                            | No automatic model projection | Recommendation/advisory for session compute       |
| Command, explicit pin  | Yes                            | May retain/project native pin | Explicitly changes session model                  |
| Skill                  | Yes                            | No                            | Requirement informs enclosing compute context     |
| Inherit                | Yes or legacy equivalent       | No concrete projection        | Runtime/session inheritance remains intact (PB-8) |

**Evidence notes that KD-2 must still cover:**

- **A second agent delivery path has no copy step.** The Claude Code plugin manifest lists every agent as `./templates/claude/agents/<id>.md` (`plugins/dotbabel/.claude-plugin/plugin.json`), and the marketplace entry sources the plugin directly from the repository (`.claude-plugin/marketplace.json`). On that path Claude Code reads the template files as they ship, and no Dotbabel code runs, so no projection happens. A template agent that carries only the semantic declaration inherits the session model there, which would break PB-1 without a warning. This is KD-3.
- **The existing copy never regenerates.** Bootstrap skips an agent file that already exists (`plugins/dotbabel/src/bootstrap-global.mjs:224-226`). Conditions 3 and 5 of ARCH-38 need a different contract, and that contract must separate a generated projection from an agent file that the user edited on purpose. Feeds §6.5.

#### KD-3: Claude plugin-delivered agents carry a release-time baseline native projection

Decided by the owner on 2026-09-17. The files under `plugins/dotbabel/templates/claude/agents/` are runtime-specific derived artifacts: `scripts/build-plugin.mjs` generates them from `agents/<slug>.md`, and `--check` fails when they are stale (`scripts/build-plugin.mjs:15-17,25`). Because Claude Code can consume them directly through the plugin path without running Dotbabel bootstrap or sync first, the build materializes a safe Claude-native baseline configuration into those templates wherever omission would violate a preserved behavior such as PB-1. This does **not** make the concrete model part of Dotbabel's semantic policy. §8 records the rejected alternatives A-4 and A-5.

**Three different layers:**

```text
Canonical artifact
semantic requirement
        │
        ▼
Dotbabel policy
"security work requires >= frontier"
        │
        + capability evidence
        ▼
Release-time baseline resolution
        │
        ▼
Claude plugin template
model: <concrete Claude-native value>
```

The provider-specific value exists only in the runtime projection. ARCH-15 remains unchanged: provider model names do not belong in Dotbabel policy. It does **not** mean that provider model names can never appear in generated/runtime-specific artifacts.

**Where the shipped value comes from.** A shipped baseline comes from a **versioned release-time capability snapshot**, not from an inline mapping in policy and not from whatever happens to be installed on the maintainer's machine during `npm publish`. Before a Dotbabel release, an explicit refresh step obtains and normalizes the best available Claude capability evidence. The release process then resolves each semantic requirement against that snapshot and generates the Claude templates.

```text
runtime/provider discovery
        ↓
versioned capability snapshot
        +
Dotbabel semantic policy
        ↓
resolver
        ↓
generated Claude template
```

The snapshot is market data/provenance, not policy. §3 `Data Stores` lists it as the fifth store.

- **ARCH-39**: The build is reproducible. Once the release snapshot is fixed, generating the templates again produces the same projections without requiring network access. The existing `build-plugin --check` gate depends on this.

**Migration bootstrap.** For the initial migration, existing intentional legacy declarations provide additional evidence for the baseline. For example, the current `model: opus` on a security agent is preserved as the initial compatibility projection while the semantic source becomes something equivalent to:

```yaml
dotbabel:
  compute:
    requirement: frontier
    mode: floor
    binding: agent
```

The migration does not immediately replace a known intentional safety pin merely because the new resolver exists (PB-1, PB-7). After resolver/classification confidence is established, future release snapshots may produce a different Claude-native projection that satisfies the same semantic floor (PB-13). Feeds §6.5.

**Local installation versus plugin baseline.** There are two valid projections:

```text
Plugin path:          canonical requirement + release capability snapshot
                      → shipped baseline projection

Bootstrap/sync path:  canonical requirement + current local/runtime evidence
                      + current usable capability data
                      → local projection
```

The plugin baseline is necessarily generic, because Dotbabel has no opportunity to inspect the user's local Claude environment before Claude loads the plugin. The local projection may be more current or account-aware.

- **ARCH-40**: The local projection supersedes the release baseline only on delivery paths where Dotbabel actually owns the generated file.

**Safety rule:**

- **ARCH-41**: For an artifact with a capability floor or explicit pin, build/release fails rather than ship a plugin template that cannot produce a baseline configuration satisfying that requirement.
- **ARCH-42**: A dynamic artifact without a required floor may legitimately ship without a native model projection and inherit the user's session when safe to do so. The plugin path requires a baseline projection only when omission would violate the artifact's declared semantics or a preserved behavior.

**Freshness.** A release-time baseline is allowed to become older than locally discovered evidence. It is a fallback appropriate to the immutable plugin artifact, not a claim that it is the best current model forever. `doctor` / Model Intelligence inspection can report that:

- the running artifact is using a shipped baseline;
- which capability snapshot produced it;
- how old that snapshot is;
- whether fresher local evidence would resolve differently.

- **ARCH-43**: A stale-but-valid baseline does not silently masquerade as a fresh local recommendation.

**Relation to ARCH-38.** A shipped plugin template satisfies ARCH-38 because its concrete model is still disposable derived state: canonical semantic intent remains elsewhere; provenance identifies the release snapshot; a future build may replace the projection; users do not edit it as policy; drift can be detected; and the same fixed release inputs reproduce it. The fact that an npm/plugin release makes the generated file immutable does not make its concrete model canonical policy.

**Evidence note — one case where the plugin path still needs a release.** Claude Code rejects an agent whose `model:` value is invalid (DOC-2, "Frontmatter Behaviour"). If a provider retires the native value in a shipped baseline, agents on the plugin path fail until a new release ships, which is a bounded exception to ARCH-36. The Claude aliases such as `opus` are moving provider aliases (DOC-1, "Migration Classification"), so a baseline that uses an alias is less exposed than one that uses a concrete identifier. Candidate risk for §8.

#### KD-4: Fan-out emits compute configuration only where a native binding contract is verified

Decided by the owner on 2026-09-17. Runtime fan-out emits compute configuration only for artifact kinds with a verified native binding contract. Otherwise it emits no model/effort metadata and exposes the resolved configuration through Model Intelligence advisory/output surfaces. The rule is not "Claude versus non-Claude". It is defined per `runtime × artifact kind × configuration axis`.

**General rule.** A runtime adapter declares whether an artifact kind supports native binding for each relevant axis. For example:

```text
copilot + agent + model    → supported
copilot + skill + model    → unsupported
gemini + skill + model     → unsupported
codex + skill + model      → unverified
agy + skill + model        → unverified
opencode + skill + model   → unverified
```

- **ARCH-44**: Fan-out emits a concrete runtime-native value only when that binding is verified.
- **ARCH-45**: Runtime artifacts expose only metadata whose presence and semantics are verified for that runtime; canonical Dotbabel metadata does not leak into a runtime artifact by accident. Revised by KD-5, which makes every runtime artifact a projection. If binding is unsupported or unverified:
  1. Dotbabel does not emit `model`, `effort`, or an equivalent field merely because the semantic requirement exists.
  2. The materializer strips the `dotbabel.compute` declaration from the runtime artifact unless that runtime contract explicitly permits it and Dotbabel has a reason to consume it there (KD-5).
  3. The requirement resolves normally.
  4. The concrete result is exposed as advisory/structured output and, where possible, as a runtime-native invocation recipe.
  5. Dotbabel never claims that a floor or pin has been enforced when the runtime cannot bind it at that artifact scope.

**Current runtime treatment:**

| Runtime / artifact surface              | Native compute projection                                                                                                                                                                                                              | Current decision                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Gemini CLI skills**                   | No verified artifact binding; DOC-2 measured IGNORED.                                                                                                                                                                                  | Emit no model/effort. Recommendation/invocation output only.                                                         |
| **Codex skills**                        | Not verified; DOC-2 only found evidence that the bundled validator does not accept these fields.                                                                                                                                       | Emit no model/effort until runtime-loader behavior is established.                                                   |
| **Antigravity skills**                  | Uncertain.                                                                                                                                                                                                                             | Emit no model/effort until empirical binding is established.                                                         |
| **OpenCode skills**                     | Blocked/unverified.                                                                                                                                                                                                                    | Emit no model/effort until empirical binding is established.                                                         |
| **Copilot instructions/skills**         | DOC-2 observed model/effort as ignored.                                                                                                                                                                                                | Emit no model/effort, and keep the explicit drop warning (PB-5).                                                     |
| **Copilot custom agents**               | Native model binding exists according to current Copilot CLI documentation.                                                                                                                                                            | Candidate for native projection, but add a Dotbabel integration test before declaring the adapter contract verified. |
| **Copilot command / `.prompt.md` path** | Existing Dotbabel code records `model` in GitHub's `.prompt.md` schema (`plugins/dotbabel/src/copilot-frontmatter.mjs:9-12`) and drops it with a warning (`:46`), but current GitHub documentation describes prompt files as IDE-only. | Treat as unverified and open a research item before Model Intelligence relies on it.                                 |

- **ARCH-46**: The table is an initial capability snapshot that starts from the measured constraints of DOC-2 (ARCH-11), not permanent policy. Adapter capability tests, not runtime names, determine future behavior.

**Invocation output.** When an artifact has no native binding, Model Intelligence can still resolve to a concrete runtime configuration. Conceptual result:

```text
Artifact: security-review
Runtime: codex
Requirement: frontier floor
Resolution:
  model: <actual Codex model>
  reasoning effort: high
Binding at skill scope: unsupported

Use for this session:
  <runtime-native command/config arguments>

Status: requirement resolved, artifact-level enforcement unavailable
```

- **ARCH-47**: The adapter returns structured invocation data first; human-readable shell syntax is a rendering of that structure. Dotbabel does not execute the command as part of Model Intelligence, because model execution remains out of scope (§2).

**Pins and floors without native binding.** A requirement does not disappear merely because fan-out cannot encode it. For `dynamic` requirements, advisory resolution is sufficient.

- **ARCH-48**: For a `floor` or `pin`, Model Intelligence explicitly reports whether the requirement is:
  - **enforced** — the runtime/artifact binding can encode it;
  - **satisfied but not artifact-enforced** — current observed/session configuration satisfies it, but the artifact cannot bind it;
  - **unsatisfied** — current configuration is below the requirement;
  - **unknown** — Dotbabel cannot observe enough state to determine whether it is satisfied.

  A generated artifact with no native binding never converts one of these states into an implicit success. §5 specifies the exact behavior for safety-critical floors when enforcement is unavailable.

- **ARCH-49**: Unsupported binding is explicit state, never silent metadata loss (PB-11).

**Adapter contract consequence:**

- **ARCH-50**: Runtime adapters carry separate capability declarations for at least discovery, observation, artifact binding by artifact kind, invocation configuration, and validation. Support for one does not imply support for another. For example, Codex can have excellent model discovery and invocation configuration while still having no verified skill-level model binding.

**Copilot research correction.** RQ-3 in [research/sources.md](../research/sources.md) holds the five research steps. The research may change Copilot's row without changing KD-4 itself.

**Evidence note — the skill trees are symlinks to one shared file.** Every entry under `.cli/skills/` and `.agents/skills/` in this repository is a symlink to `.claude/skills/<id>`, and the registry marks the Codex, Gemini CLI, and OpenCode trees as `shareable: true` (`plugins/dotbabel/src/agents.mjs:119,132,224`). All runtimes therefore read the same `SKILL.md`. Fan-out cannot omit a key for one runtime and keep it for another while that holds, and a `dotbabel.compute` key in the canonical source is visible to every runtime, which bore on the first wording of ARCH-45; KD-5 resolves it. For skills, no runtime has a verified binding, Claude Code included (KD-2), so "no native key on any skill" satisfies rule 1 without a change to the symlinks. The visibility of `dotbabel.compute` was the open point, and KD-5 settles it.

#### KD-5: Runtime skill trees are generated projections that omit Dotbabel-private metadata

Decided by the owner on 2026-09-17. Canonical skills may contain Dotbabel-private semantic metadata. Runtime skill trees are runtime-specific generated projections that omit private metadata unless that runtime contract explicitly supports it.

The canonical artifact remains `skills/<id>/SKILL.md` and may contain:

```yaml
dotbabel:
  compute:
    requirement: deep
    mode: dynamic
```

The runtime trees such as `.claude/skills/`, `.agents/skills/`, `.cli/skills/`, or other generated destinations are projections of that canonical source.

**Default projection rule.** For each runtime adapter:

1. Parse canonical frontmatter with a real YAML parser.
2. Preserve the skill body.
3. Emit only frontmatter that the target runtime is verified to accept or that Dotbabel deliberately owns on that runtime surface.
4. Strip `dotbabel.compute` from the runtime artifact unless the adapter has an explicit verified contract allowing it.
5. Do not emit `model` or `effort` when skill-level binding is unsupported or unverified (ARCH-45).
6. Preserve enough generated-file provenance for drift detection and regeneration (ARCH-38).

For the currently measured runtimes, a migrated skill normally looks like:

```text
canonical SKILL.md
  dotbabel.compute
  taxonomy
  body
        │
        ▼
runtime materializer
        │
        ├── Claude skill
        │     no model/effort projection
        │     Dotbabel-private compute metadata omitted
        │
        ├── Codex skill
        │     no model/effort projection
        │     Dotbabel-private compute metadata omitted
        │
        ├── Antigravity skill
        │     no model/effort projection until verified
        │     Dotbabel-private compute metadata omitted
        │
        └── Copilot/OpenCode/etc.
              adapter-specific safe frontmatter only
```

**Why not Option A (keep the symlinks and accept the visible key; A-6 in §8).** It would make third-party parser tolerance part of Dotbabel's correctness contract. Today a runtime may ignore an unknown key. Tomorrow it may validate more strictly. A nested mapping that happens to work in six current versions is not a stable interface unless the runtime documents it. That would contradict the principle of KD-4: unsupported or unverified binding/metadata behavior is explicit state, not an assumption. If a runtime later explicitly supports extension metadata and retaining `dotbabel.compute` is useful, its adapter may opt in.

**Why not Option C (move the declaration under `metadata:`; A-7 in §8).** `metadata` is part of the target runtime's schema, not Dotbabel's namespace. Its shape and semantics may differ between runtimes and versions. Using `metadata.dotbabel.compute` would couple the canonical Dotbabel data model to one runtime's extension mechanism and recreate the cross-runtime vocabulary problem in a different form. The canonical namespace remains `dotbabel`.

**Symlinks become an optimization, not an architecture contract.** The current shared skill trees use symlinks because the same source file happened to be acceptable to several runtimes. After KD-5, the architecture does not depend on that being true.

- **ARCH-51**: `canonical source → materializer → runtime projection` is the contract. `canonical source → symlink` is merely one possible zero-transformation implementation of that contract. A runtime tree may use a symlink only when the materializer can establish all of these:
  - the canonical file requires no runtime-specific transformation;
  - every retained frontmatter key is verified safe for that runtime;
  - no Dotbabel-private metadata needs stripping;
  - no generated provenance or native projection is required.

  Otherwise it writes a generated copy.

**Consequence for RQ-2.** RQ-2 changes from a correctness gate to an optimization/compatibility research item. If every runtime accepts the nested `dotbabel:` key, Dotbabel may later preserve it on selected runtime surfaces for diagnostics. If one rejects it, nothing fundamental changes, because the materializer already strips it.

**Drift and ownership.** Generated runtime skill files follow the same ownership model as other Dotbabel projections:

- **ARCH-52**: Canonical `skills/<id>/SKILL.md` is user/source-owned. Generated runtime copies are Dotbabel-owned. User edits to a generated copy are drift, not new policy. Regeneration is deterministic. `project-sync --check` or equivalent validation detects divergence; `plugins/dotbabel/bin/dotbabel-check-project-sync.mjs` is the existing gate.

This gives Model Intelligence one consistent projection model for agents, skills, commands, and future artifact kinds instead of treating the current symlink topology as permanent architecture.

**Evidence notes for §6.5:**

- **The Claude skill trees are symlinks too.** In this repository `.claude/skills` is a directory symlink to `../skills`, and `.claude/commands` points to `../commands`. At user scope every `~/.claude/skills/<id>` is a symlink into the clone. A migrated skill carries `dotbabel.compute`, which fails the third condition of ARCH-51, so Claude Code then needs a generated copy at both scopes. `.claude/**` is a protected path.
- **The live-edit loop changes.** The rule floor tells the owner to edit files in the clone because `~/.claude/` links to them. After KD-5, an edit to a migrated skill reaches Claude Code only after a sync.
- **Cost of copies.** The canonical `skills/` tree is 1.1 MB, so a generated copy per runtime tree is small.

#### KD-6: The shipped `ai-review.yml` receives a release-time projected Claude session configuration

Decided by the owner on 2026-09-17. The canonical workflow declares the semantic requirement for the **review session/coordinator**. During Dotbabel's build/release process, the resolver combines that requirement with the fixed release-time capability snapshot from KD-3 and writes a concrete Claude-native configuration into the generated workflow.

```text
canonical ai-review workflow
  semantic session requirement
        +
release capability snapshot
        +
Dotbabel policy
        ↓
release-time resolver
        ↓
generated ai-review.yml
  claude-code --model <resolved value> ...
```

Where supported and justified by the requirement, the projection may also include a native reasoning-effort argument. §5 defines the exact CLI fields.

**Why not A (no change; A-8 in §8).** Leaving the model unspecified delegates the coordinator session to whatever default the installed Claude Code version/account currently chooses (`plugins/dotbabel/templates/workflows/ai-review.yml:27`). That creates behavior which is:

- outside Dotbabel's Model Intelligence policy;
- not reproducible from the Dotbabel release;
- capable of changing without any repository or Dotbabel change;
- inconsistent with the goal that model-aware shipped workflows have an explainable concrete configuration.

The fact that `security-auditor` and other agents carry their own floors protects their delegated turns, but it does not define the model used by `/review-prs` itself for orchestration, synthesis, or work that remains in the parent session.

**Why not C (resolve inside the CI job; A-9 in §8).** Live model discovery or dynamic resolution inside the CI job would make the same commit potentially use different models across runs, depending on provider/catalog state, network availability, runtime/account exposure, and discovery freshness. It would also violate the deterministic CI constraints in ARCH-35 and TEST-1.

**Coordinator and worker requirements remain separate:**

```text
AI review workflow
  coordinator/session requirement: deep
        │
        ├── normal review/orchestration
        │     uses release-projected session model
        │
        └── security-auditor
              own frontier/safety floor
              own agent projection
```

- **ARCH-53**: The workflow session requirement does not replace agent-level requirements. A worker or subagent with a stronger floor continues to override the weaker parent-session configuration at its actual binding scope. This preserves the distinction between **coordinator compute** and **worker compute** that DOC-1 identified.

**Source of the concrete value.** The generated `--model` value comes from the same version-controlled release capability snapshot that KD-3 introduced. It is runtime-specific derived data, reproducible without network access (ARCH-39), provenance-stamped, replaceable on a later Dotbabel release, and not part of stable semantic policy (ARCH-15).

- **ARCH-54**: The adapter, not generic policy, decides which representation of a resolved value is safe. It prefers a provider-supported stable alias when the Claude adapter has verified that the alias expresses the intended capability level and reduces unnecessary retirement churn. Otherwise it uses the resolved native identifier.

**Failure rule:**

- **ARCH-55**: The release build fails if it cannot resolve a Claude session configuration that satisfies the workflow's declared requirement. It never silently falls back to omitting `--model` (ARCH-41 is the same rule for plugin agents).

**Runtime behavior.** The shipped workflow remains explicitly Claude Code as the runtime, Anthropic-authenticated through the existing `ANTHROPIC_API_KEY` path, Model Intelligence-resolved only at Dotbabel build/release time, and independent of live discovery during the GitHub Actions run. PB-6 therefore remains preserved: Model Intelligence determines the concrete Claude configuration without generalizing the workflow to another runtime or provider.

**Evidence notes for §5 and §6.5:**

- **The workflow has no canonical source today.** No script or source file generates `ai-review.yml`; the file under `plugins/dotbabel/templates/workflows/` is hand-authored. KD-6 makes it a generated file. §5 `Declaration for an artifact without frontmatter` names its canonical source and its compute sidecar.
- **A consumer copy is fixed at `init` time.** `dotbabel init` copies `workflows/` into `.github/workflows/` once (`plugins/dotbabel/src/init-harness-scaffold.mjs:10`) and refuses an initialized repository without `--force` (`:69-91`). A later release projection does not reach an existing consumer copy, so that copy needs the same staleness report that ARCH-43 gives a plugin baseline.
- **A second copy exists** at `examples/minimal-consumer/.github/workflows/ai-review.yml`.
