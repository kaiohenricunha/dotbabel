# Claude command migration compatibility

The seven remaining P19c commands have working native session model controls. The existing release generator preserves these controls before migration. Adding a dynamic semantic declaration removes them. The command migrations must wait for this compatibility repair.

## Grounding and cause

Candidate one is a wrong semantic workload classification. The new tests use the existing audit's Mechanical and Routine decisions and the shared release evidence. The same native model satisfies each requirement, and the failure is an absent emitted field. This evidence rejects classification as the cause.

Candidate two is the release bridge. `claude-build.mjs:21` admits only absent or floor declarations to legacy validation. `claude.mjs` emits a command model only through a canonical pin or legacy axes. A newly dynamic command loses both paths. Its session binding is correctly unknown; changing the resolver to report enforcement would be false. This is the supported cause.

The repair retains only an exact already-authored release command selector, validates it through the shared resolver as an invocation pin, and requires verified native model binding. The normal dynamic/floor materializer continues to omit a session model. The source requirement stays semantic and its enforcement stays unknown. No command is migrated in this code unit.

## Verification

An initial test helper omitted the required source path; that authoring failure is retained privately. After correcting the helper, ten regression cases fail and two pass. The failures cover all seven real command controls, both dynamic and floor release paths, and unverified binding. Tests also check exact original native metadata/body preservation, no effort or private metadata, no invented selector, inheritance and rejection of insufficient capabilities. The existing normal-projection golden cases remain unchanged.

The spec now states the narrow transitional release exception required by IMPL-2. It preserves the rule against dynamically selecting a native command session model. Artifact migration and final original-spec closure remain separate work.
