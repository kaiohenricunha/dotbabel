# Current State Analysis

At initiative baseline `0e766b5`, `plugins/dotbabel/src/model-intelligence/` supplies domain, requirement, compatibility, policy, sources and catalog modules. No resolver, materializer, snapshot or recommendation module exists. `plugins/dotbabel/bin/dotbabel-models.mjs:52` lists only refresh, status and migrate. `schemas/dotbabel.config.schema.json:176` has policy but no activation flags.

The original spec is approved and advisory. Its 25 acceptance criteria are planned. Existing per-agent native model/effort behavior is independent and must survive this work.

The new requirements add separate project flags, local contextual classification, main-session runtime adapters, manual provenance, independent effort intent, exactly-once input handling, effective-state observation and runtime evidence. No native pre-prompt Codex CLI route has yet been verified. Claude mods and Codex App Server are candidate interfaces only.
