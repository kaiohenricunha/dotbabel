# Routing fallback enforcement audit — 2026-10-18

## Evidence and candidate causes

1. Missing shared resolver assessment could hide a below-floor observation. Against: `plugins/dotbabel/src/model-intelligence/resolver/enforcement.mjs:16` checks fresh independently supplied native observations; line 27 returns unsatisfied for a false check. `resolver/index.mjs:82` computes the assessment even when a replacement is resolved, and line 85 returns its state. The verified replacement regression passes.
2. The routing consumer discards that result when it cannot apply the replacement. For: `plugins/dotbabel/src/adaptive-session-routing/route.mjs:55` and line 56 return preserved without resolution for stale and low-confidence evidence; line 70 does the same for unsupported axes. Against: line 54 already blocks an unsatisfied unresolved selection, so the error is limited to unusable resolved replacements.

The second cause is confirmed. Four new tests reproduce preserved instead of blocked for stale, low-confidence, unsupported and unverified replacements. The positive boundary allows a verified replacement that corrects the observed violation. The initial regression run fails four and passes 42 tests, recorded in `/tmp/ar-502-review-regression-red.log`.

## Authorized correction

The autonomous assignment authorizes this correction. Keep the shared resolver unchanged. Preserve its resolution and diagnostics when rejecting a replacement; return blocked only when that resolution establishes unsatisfied enforcement. Other conservative fallbacks remain preserved. A usable corrective proposal remains possible before native execution.
