# Phase 0 Findings — RQ-1, RQ-3, RQ-4

> Evidence for the three research items that §6.1 Phase 0 names. Measured on 2026-09-18. This document is DOC-3. It changes no implementation (IMPL-1).

Confidence labels: `CONFIRMED` (measured or read from the source at the installed version), `LIKELY` (strong indirect evidence), `BLOCKED` (not testable under the isolation rules), `UNVERIFIED` (not measured).

## Method and Isolation

- Versions tested: Claude Code 2.1.275, Codex CLI 0.154.0, Gemini CLI 0.59.0, Antigravity 1.2.5, GitHub Copilot CLI 1.0.83, OpenCode 2.0.5.
- No credential was sent to any service, and the shell held no provider credential variable. No account was authenticated, nothing was installed, and no real runtime configuration root was written.
- The one live runtime probe (Copilot) used an empty `COPILOT_HOME` and `HOME` under the session scratch directory, with `GH_TOKEN` and `GITHUB_TOKEN` cleared.
- Source reads used the public repositories at the tag of the installed version: `openai/codex` at `rust-v0.154.0` and `anomalyco/opencode` at `v2.0.5`.
- Closed-source runtimes (Antigravity, Copilot) were read through strings of the installed binary or bundle.

## RQ-1 — Official Model APIs and Models.dev

### Models.dev

| Property                     | Measured value                                                                                                                                                                                                        | Confidence |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Endpoint                     | One document, `https://models.dev/api.json`. A `?provider=` query returns the same full document, and the per-provider paths that were tried redirect (302).                                                          | CONFIRMED  |
| Authentication               | None.                                                                                                                                                                                                                 | CONFIRMED  |
| Size                         | 4,693,478 bytes (4.48 MiB), which is 56% of the OPS-2 per-entry limit of 8 MiB. The seven providers relevant to Dotbabel total 294,506 bytes.                                                                         | CONFIRMED  |
| Caching                      | `etag` is present, a conditional GET with `If-None-Match` returns `304`, and `cache-control` is `public, max-age=0, must-revalidate`. Two fetches three seconds apart had the same sha256.                            | CONFIRMED  |
| Shape                        | An object keyed by provider id: 222 providers and 7,847 model records. Provider keys: `id`, `env`, `npm`, `name`, `doc`, `models`, and `api` on 196 of 222.                                                           | CONFIRMED  |
| Model fields on every record | `id`, `name`, `description`, `attachment`, `reasoning`, `tool_call`, `release_date`, `last_updated`, `modalities`, `open_weights`, `limit` (`context`, `output`).                                                     | CONFIRMED  |
| Optional model fields        | `cost` (7,430), `temperature` (7,351), `family` (7,178), `reasoning_options` (5,664), `structured_output` (5,427), `knowledge` (4,111), `interleaved` (1,089), `provider` (312), `status` (283), `experimental` (58). | CONFIRMED  |
| Lifecycle                    | `status` is `deprecated` on 210 records and `beta` on 73.                                                                                                                                                             | CONFIRMED  |
| Versioning                   | The document has no schema or version marker at the top level.                                                                                                                                                        | CONFIRMED  |
| License and ownership        | Not retrieved: the repository lookup returned no data.                                                                                                                                                                | UNVERIFIED |

Three facts bear on the design:

- **Effort is per model and has many vocabularies.** `reasoning_options` has three types: `effort` (3,418), `toggle` (1,308), and `budget_tokens` (675). The eight most common `effort` value sets are `low|medium|high` (697), `low|medium|high|xhigh|max` (368), `minimal|low|medium|high` (244), `low|high|max` (239), `none|high` (186), `none|low|medium|high|max` (185), `none|low|medium|high|xhigh` (181), and `none|low|medium|high|xhigh|max` (160). This confirms ARCH-1 from an external source.
- **Runtimes appear as providers.** `github-copilot` (28 models) and `opencode` (103 models) are provider ids, next to `anthropic` (14), `openai` (48), and `google` (39). This confirms ARCH-2.
- **A model id is not unique across providers.** 1,094 ids occur under more than one provider. Catalog identity must be the pair of provider and model id, which agrees with ARCH-3.

### Official provider model APIs

| API                         | Unauthenticated result                                         | Documented shape                                                                                                                                                                                                                                                                                                                                                          | Confidence                                           |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Anthropic `GET /v1/models`  | `401`, `authentication_error`, "x-api-key header is required". | `data[]` of `{type: "model", id, display_name, created_at, max_input_tokens, max_tokens, capabilities}` with `has_more`, `first_id`, `last_id` and the `after_id`, `before_id`, `limit` parameters. `capabilities.effort` has `supported` and one entry each for `low`, `medium`, `high`, `max`, and `xhigh`. `capabilities.thinking.types` has `adaptive` and `enabled`. | Live shape BLOCKED; documentation read on 2026-09-18 |
| OpenAI `GET /v1/models`     | `401`, "Missing bearer authentication in header".              | Not read.                                                                                                                                                                                                                                                                                                                                                                 | UNVERIFIED                                           |
| Gemini `GET /v1beta/models` | `403`, "Method doesn't allow unregistered callers".            | `models[]` of `{name, baseModelId, version, displayName, description, inputTokenLimit, outputTokenLimit, supportedGenerationMethods[], thinking, temperature, maxTemperature, topP, topK}` with `nextPageToken`.                                                                                                                                                          | Live shape BLOCKED; documentation read on 2026-09-18 |

All three official APIs require a credential for a model list. The Anthropic API is the only source found that states effort support per model and per level in a provider-owned, machine-readable form.

### Consequences for the knowledge-source adapter contracts

- Models.dev descriptor: `discovery` supported, `network: required`, `auth: none`, `cacheable: true`, `execution: read-only`. The adapter uses the conditional GET, and it reduces the document to the providers that the configured runtimes need before persistence, because the full document uses more than half of the OPS-2 entry limit.
- An official API descriptor: `auth: required-existing`. With no existing credential, the result is `unavailable` with `auth_required`, which REL-1 and ARCH-26 already treat as a normal state. No official API can be a Tier 1 or Tier 2 dependency.
- The absence of a version marker in Models.dev means that the adapter validates the shape of each record and returns `unknown` with `malformed_output` on a mismatch. It cannot detect a schema change from a header.
- R-4 stays Medium: Models.dev is stable and structured today, and the official APIs are credential-gated.

**RQ-1 status: closed for Models.dev; closed for the availability and documented shape of the Anthropic and Gemini APIs; the OpenAI response shape and the Models.dev license stay open.**

## RQ-3 — Copilot Custom Agents and `.prompt.md`

| Question                                                 | Finding                                                                                                                                                                                                       | Confidence                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Does Copilot CLI 1.0.83 consume `.prompt.md`?            | No. The string `.prompt.md` does not occur in any `.js`, `.json`, or `.md` file of the installed package.                                                                                                     | CONFIRMED                        |
| Does Copilot CLI have custom agents?                     | Yes. `--agent <agent>` selects one. The loader reads `.github/agents/` in the project and `<COPILOT_HOME>/agents` for the user, and it accepts `<name>.agent.md` and `<name>.md`, with `.agent.md` preferred. | CONFIRMED                        |
| Which frontmatter keys does a custom agent accept?       | `name`, `description`, `tools`, `mcp-servers`, `infer`, `disable-model-invocation`, `user-invocable`, `model` (optional string), and `github` (`toolsets`, `permissions`).                                    | CONFIRMED from the bundle schema |
| Is there a `models` (plural) key?                        | Not in the custom-agent schema.                                                                                                                                                                               | CONFIRMED                        |
| Is there an effort key on a custom agent?                | No.                                                                                                                                                                                                           | CONFIRMED                        |
| What happens to an unknown agent key?                    | The shipped changelog says: "Custom agents support the `model` field to specify which model to use, and unknown fields now warn instead of blocking agent load".                                              | CONFIRMED as a vendor statement  |
| Is the agent `model` honoured at run time?               | Not testable. Copilot checks authentication before it loads an agent: a valid probe agent and a nonexistent agent name gave the same "No authentication information found" error.                             | BLOCKED                          |
| Which keys does a Copilot skill accept?                  | `name`, `description`, `allowed-tools`, `user-invocable`, `disable-model-invocation`. There is no `model` and no `effort`, and the schema drops unknown keys. This agrees with the IGNORED result of DOC-2.   | CONFIRMED                        |
| Where does Dotbabel install Copilot custom agents today? | Nowhere. No file under `plugins/dotbabel/src/` writes `.github/agents` or an `.agent.md` file.                                                                                                                | CONFIRMED                        |

Two findings go beyond the question:

- **Copilot CLI has its own command schema** with `name`, `description`, `allowed-tools`, and `disable-model-invocation`. Its load path was not traced. It may be the correct Copilot CLI target for Dotbabel commands in place of `.prompt.md`.
- **The `.prompt.md` files that Dotbabel generates reach no CLI.** `plugins/dotbabel/src/copilot-frontmatter.mjs` and the `copilot-files` fan-out serve the IDE only. The 7 generated prompt files are inert for Copilot CLI.

**RQ-3 status: steps 2, 3, and 5 are closed. Step 1 is closed for the schema and blocked for run-time binding. Step 4 stays conditional: the owner's rule in KD-4 requires a Dotbabel integration test before the adapter contract says `supported`, and that test needs an authenticated Copilot, which is a Tier 3 condition.**

## RQ-4 — Skill-Level Binding on Codex, Antigravity, and OpenCode

| Runtime           | Finding                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                  | Confidence                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Codex CLI 0.154.0 | `SKILL.md` frontmatter deserializes into `SkillFrontmatter { name, description, metadata { short-description } }`. The struct has no `deny_unknown_fields`, so `model`, `effort`, and any other key are dropped without a warning.                                                                                                                                                                               | `codex-rs/skills/src/parser.rs:7-20` at `rust-v0.154.0`                                                   | CONFIRMED                                           |
| OpenCode 2.0.5    | Skill frontmatter decodes into `Schema.Struct({ name?, description?, metadata?: unknown })`. Its one extension point is `metadata["opencode/autoinvoke"]`. A skill has no `model` and no `effort`. An OpenCode **agent** does have `model` (`Model.Ref`, optional).                                                                                                                                              | `packages/core/src/config/plugin/skill-file.ts:9-13,44` and `packages/schema/src/agent.ts:26` at `v2.0.5` | CONFIRMED                                           |
| Antigravity 1.2.5 | The skill record is the protobuf message `SkillMetadata` with `name`, `description`, `publisher`, and `version`. The only YAML frontmatter types in the `customizations` package are `AgentFrontmatter` and `RuleFrontmatter`. The single `yaml:"model,omitempty"` tag that DOC-2 could not attribute sits between `Tools` and `Rules`, which fits `AgentFrontmatter`. The `CustomAgent` message has `GetModel`. | strings of the installed binary                                                                           | LIKELY; a live test stays BLOCKED by authentication |

This replaces three rows of DOC-2. Codex moves from `LIKELY NOT_PARSED` to CONFIRMED, because the evidence is now the Rust loader and not the bundled Python asset. OpenCode moves from BLOCKED to CONFIRMED. Antigravity `model` moves from UNCERTAIN to LIKELY not parsed on a skill.

Two findings go beyond the question:

- **Every runtime that was read binds a model on an agent and never on a skill.** Claude Code (DOC-2), Copilot CLI, OpenCode, and Antigravity each have a `model` key in their agent definition. This supports ARCH-37 and the `consumer` binding.
- **RQ-2 is answered for two runtimes.** Codex and OpenCode both ignore unknown frontmatter keys without a warning, so a nested `dotbabel:` key is tolerated there. Copilot custom agents warn on an unknown key. KD-5 strips the key in every case, so nothing depends on this.

**RQ-4 status: closed for Codex and OpenCode; closed as LIKELY for Antigravity, with the live test blocked.**

## Proposed Adapter-Contract Rows

These rows update the initial capability snapshot of KD-4 (ARCH-46). `supported` still needs the integration test that ARCH-44 requires.

| Runtime × artifact kind × axis              | State after Phase 0                                    | Basis                                                                       |
| ------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `codex` + `skill` + `model`, `effort`       | `unsupported`                                          | Source at the installed tag                                                 |
| `opencode` + `skill` + `model`, `effort`    | `unsupported`                                          | Source at the installed tag                                                 |
| `opencode` + `agent` + `model`              | `unverified`                                           | The schema has the key; no run-time test                                    |
| `antigravity` + `skill` + `model`, `effort` | `unverified`, and the evidence points to `unsupported` | Binary strings; live test blocked                                           |
| `antigravity` + `agent` + `model`           | `unverified`                                           | `CustomAgent.GetModel` exists; no run-time test                             |
| `copilot` + `skill` + `model`, `effort`     | `unsupported`                                          | Bundle schema and DOC-2                                                     |
| `copilot` + `agent` + `model`               | `unverified`                                           | Bundle schema and vendor changelog; run-time test blocked by authentication |
| `copilot` + `agent` + `effort`              | `unsupported`                                          | No such key in the schema                                                   |
| `copilot` + `command` (`.prompt.md`)        | `unsupported` for the CLI                              | The CLI does not read the file                                              |

## Remaining Unknowns

1. The OpenAI `GET /v1/models` response shape, and whether it states any capability.
2. The license and the ownership of the Models.dev data.
3. Run-time proof that Copilot, OpenCode, and Antigravity honour an agent `model`. Each needs an authenticated runtime, which is a Tier 3 condition under TEST-5.
4. The load path of Copilot CLI commands, and whether Dotbabel commands belong there.
5. Cross-runtime agent fan-out. Decided by the owner on 2026-09-18: it is out of scope for this spec (§2, `Out of Scope`), and it is recorded as a deferred item in [sources.md](sources.md). Phase 0 therefore closes the research question without widening the implementation scope.
