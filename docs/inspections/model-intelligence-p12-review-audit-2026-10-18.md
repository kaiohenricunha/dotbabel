# P-12 review corrections — 2026-10-18

## Requirement boundary

Candidate cause one is shared-resolver selection below a correctly supplied frontier floor. Against it: the regression calls the real resolver with the supplied routine/deep declaration and gets the configuration that declaration permits. Candidate cause two is canonical requirement loss at the materializer boundary. Confirmed: `materialize/index.mjs:25` replaces the parsed canonical declaration, and its inheritance guard does not reject a weaker resolved declaration. Two regressions fail for a canonical frontier floor and genuine weaker resolver results. A related exact-pin regression also fails when a supplied pin replaces the authored pin.

The chosen correction validates an authored floor against the effective class using the existing domain comparison. It checks that each authored pinned axis survives with the same runtime/value. This validates supplied derivation inputs; it adds no chooser, catalog or resolver selection path. A stronger effective floor remains accepted. Autonomous task authorization covers these corrections.

## Private metadata boundary

Candidate cause one is an adapter contract that explicitly authorizes all Dotbabel namespace fields. Against it: the contract grants only permitsCompute plus a named compute consumer. Candidate cause two is a renderer that treats that permission as approval of the complete namespace. Confirmed: `materialize/render.mjs:34` clones the whole allowlisted dotbabel object. The failing regression retains compute and exposes an unrelated internal marker. The correction retains only dotbabel.compute under this permission; unrelated private members stay absent.

## Manifest helper documentation

The public materialize API sorts projections, but makeManifest preserves its supplied order (`materialize/manifest.mjs:39`). Document the sorted-input precondition rather than introducing a second unnecessary sort. The four-role fleet runs once; the three duplicate floor findings share one correction. `/tmp/mi-p12-review-red.log` records four failing regressions and 29 passing tests before implementation.
