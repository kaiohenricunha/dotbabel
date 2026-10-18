# Class-F owner decisions for P-19f

Status: **all nine recommendations approved by the owner** on 2026-10-18.

Owner response: "Approve all nine recommendations". Approval recorded at 12:50 UTC.
No affected artifact changes precede this decision record. Implementation and verification remain pending.

## Why this decision is required

`docs/specs/model-intelligence/spec/6-implementation-plan.md:777` (IMPL-7) says:
"Unresolved DOC-1 class-F entries are never guessed." It requires an explicit owner decision and
a recorded migration mapping before those artifacts change. Earlier unambiguous batches and other
implementation units can proceed independently. General execution authorization does not select
an unresolved semantic requirement.

The historical audit has 13 class-F rows at `docs/audits/model-selection-audit.md:1179` onward.
Two are already resolved: KD-1 through KD-5 select the shared resolver/projection architecture;
KD-6 selects the generated review workflow, now implemented by P-17 / PR #510. Two other rows repeat
the agents-search taxonomy and validate-spec requirement questions. That leaves nine unique choices.
Recheck this inventory immediately before P-19f and remove anything earlier migration work resolves.

## Approved decisions

| ID  | Current evidence and binding                                                                                                                                                   | Recommended decision                                                                                                                                                                                                                          | Alternative and effect                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | `agents/compliance-auditor.md:14` audits declared/enforced gates; `:21` pins native Opus. An agent model binds that subagent.                                                  | Declare a Frontier floor with self binding. Retain the native Opus compatibility control and read-only tools.                                                                                                                                 | Deep floor reduces the declared minimum. An exact native pin preserves a vendor-specific choice but leaves its long-term semantic intent unresolved.                             |
| F2  | `agents/data-scientist.md:14` audits formulas and boundaries; `:20` selects Sonnet.                                                                                            | Declare a Deep floor with self binding. Retain the native Sonnet compatibility control and read-only tools.                                                                                                                                   | Frontier sets a stronger declared minimum. Native inheritance removes the existing explicit subagent choice and would require separate behavior proof.                           |
| F3  | `skills/agents-search/SKILL.md:83` and `:225` group by provider aliases and prohibit reordering. Its skill model is not a native compute binding.                              | Group by an explicitly declared canonical requirement, in the five semantic classes, plus inherit and undeclared/legacy groups. Show native controls separately. Never infer quality or intent from a model name. Keep the listing read-only. | Keep the provider-alias view as a separate compatibility display, without calling it a quality ladder.                                                                           |
| F4  | `skills/audit-and-fix/SKILL.md:18` declares Opus; `:56` dispatches general-purpose workers without separate model controls.                                                    | Declare the coordinator's Frontier floor as a consumer requirement. Keep generic worker inheritance and existing dispatch, tools, worktrees and merge prohibition. State that this is no new worker-floor guarantee.                          | Add independent mandatory worker requirements only with a separately verified dispatch contract; do not claim the current inherited workers enforce one.                         |
| F5  | `skills/review-prs/SKILL.md:19` declares Opus; `:95` dispatches general-purpose per-PR workers.                                                                                | Declare coordinator inheritance. Preserve generic worker inheritance and the existing round/PR workflow. Keep worker and coordinator observations separate.                                                                                   | Declare a Deep coordinator consumer requirement, which increases the declared orchestration demand. Independent enforced worker floors need separate supported binding evidence. |
| F6  | `skills/validate-spec/SKILL.md:23` declares max effort and `:24` Sonnet, conflicting with the historical implementation-plan model list. Skill model/effort metadata is inert. | Declare a Frontier floor with consumer binding. Preserve the actual read-only audit behavior. Replace historical alias expectations with this canonical demand; do not claim skill-level native enforcement.                                  | Deep demand costs less in the semantic policy; an explicit native pin preserves a selector but cannot make inert skill metadata enforce it.                                      |
| F7  | `skills/spec/SKILL.md:295` recommends `/think` and `/ultraplan` in a generated prompt template; neither command exists in this repository.                                     | Replace the dangling names with the existing `/plan` workflow and explicit, runtime-supported effort guidance when necessary. Do not add new commands.                                                                                        | Remove all command guidance from that template.                                                                                                                                  |
| F8  | `schemas/agent.schema.json:24` exposes the unused public invocation enum `passive` or `explicit`.                                                                              | Keep the field for compatibility and mark/document it as deprecated metadata with no execution effect. Do not invent an invocation engine.                                                                                                    | Remove it through a separate compatibility-breaking schema change after usage evidence and migration.                                                                            |
| F9  | `schemas/command.schema.json:25` recognizes headless_safe; `schemas/skill.schema.json` does not, while `skills/review-prs/SKILL.md:20` and other skills use it.                | Add the same boolean metadata definition to the skill schema and document its scope. Keep permission, confirmation and native-projection behavior unchanged.                                                                                  | Remove every skill use through a separate compatibility migration; do not silently reinterpret it as runtime permission.                                                         |

## Preserved behavior and limits

These recommendations retain native agent choices during the compatibility bridge. They do not
claim measured model-quality rankings, cheaper models' non-inferiority, new worker binding,
new subscriptions, or skill-frontmatter enforcement. P-19d and P-19e still run their own isolated
full review fleets and preserved-behavior checks. Typed production confirmations, read-only roles,
approval rules and subagent independence remain binding.

The owner approved F1 through F9 together. The specification migration mapping records these
decisions before any affected artifact changes. This approval settles semantic intent; it does not
replace the required implementation, preserved-behavior checks, or full review fleets.
