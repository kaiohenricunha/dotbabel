# Codex modality loading audit — 2026-10-18

A new regression fails because an unverified attachment triggers capability loading.

Candidate A: preparation ignores project activation. Against: `plugins/dotbabel/src/adaptive-session-routing/prepare.mjs` checks activation before its lazy loader; this test explicitly enables both nested flags. The disabled-project regression already protects that boundary.

Candidate B: the lazy modality wrapper loads the catalog before validating native input. For: `plugins/dotbabel/src/adaptive-session-routing/codex.mjs:43` awaits loadResolverInput before mapping the native input at line 44. An unknown input type throws at line 47, but the loader has already run. The isolated regression records one loader call and requires zero.

Choose B. The autonomous assignment authorizes moving modality validation before capability loading inside the already gated wrapper. This preserves original native input, project activation ordering, and the shared resolver's modality constraint. Do not inspect attachment contents or add another chooser.
