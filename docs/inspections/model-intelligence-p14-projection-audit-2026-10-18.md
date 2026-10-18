# P-14 projection boundary audit — 2026-10-18

P-14 remains in progress. The five specified projection cases now run against a real shared-resolver consumer. The initial test fails because the module is absent. Two fixture mistakes are corrected against requirement/schema.mjs: pin needs a semantic requirement, and inherit still needs a binding. The valid fixture then has seven passing cases and one failing case: a pinned command loses its native model.

## Pin diagnosis before correction

Candidate one is loss of the explicit model in parsing or resolution. Against it: the canonical pin parses, the resolver resolves deep-model, and its configuration retains that exact model. Candidate two is all-or-nothing enforcement during rendering. Confirmed at materialize/render.mjs:35-42: rendering requires the whole resolver result to have enforced/artifact-binding status before any axis is emitted. The resolver's enforcement.mjs:18 requires all selected axes to bind. Claude command model is supported but command reasoning is unverified in sources/runtime/claude.mjs:86-87. A selected model's default reasoning therefore prevents the explicitly pinned model from being rendered, even though its own native field is verified.

The chosen correction permits an explicitly authored pin axis independently when the projection contract opts in, its exact value still matches the canonical pin, the authored binding is self/session and that native axis is supported. It does not change the resolver result's overall enforcement claim. No automatic or unverified axis gains permission. The Claude projector opts in only for pinned commands and refuses an explicit reasoning pin that the command cannot bind. This is runtime field emission, not a second selection mechanism.

## Scope and activation

The projector calls the one shared resolver and materializer over caller-supplied evidence. It has no filesystem, process, clock, discovery or activation side effect. Agent dynamic/floor fields follow verified bindings, dynamic/floor commands omit model/effort, skills omit model/effort and private compute, and inherit emits no concrete axes. Unknown mandatory agent binding fails closed. Global bootstrap must install only package baseline projections; it must never apply one project's routing policy to shared configuration. Project live resolution remains guarded by project activation.

Native metadata references: [Claude subagents](https://code.claude.com/docs/en/sub-agents) and [Claude skill frontmatter](https://code.claude.com/docs/en/skills). These document accepted field names; installed-runtime acceptance remains a separate required check. Command name/paths fields are excluded. Skill model and effort remain omitted under the measured conservative contract.
