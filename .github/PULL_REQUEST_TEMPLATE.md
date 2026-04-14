<!--
  PR bodies must contain `## Summary` and `## Test plan`. Changes touching a
  protected path (see docs/repo-facts.json) additionally require either
  `Spec ID: <id>` or a `## No-spec rationale` section — enforced by
  harness-check-spec-coverage.
-->

## Summary

<!-- 1-3 bullets describing the change. Focus on WHY and what it enables. -->

-
-

## Test plan

- [ ] `npm test` — green
- [ ] `npx bats plugins/harness/tests/bats/` — green
- [ ] `bash plugins/harness/tests/test_validate_settings.sh` — 12/12
- [ ] `node scripts/check-jsdoc-coverage.mjs plugins/harness/src` — ok
- [ ] Root dogfood: `npm run dogfood` — all validators exit 0
<!-- Add manual verification steps if relevant -->

<!--
  Pick ONE of the following sections (delete the other). Headings MUST be H2
  (`## Spec ID` or `## No-spec rationale`) — harness-check-spec-coverage
  extracts them via H2 regex.
-->

## Spec ID

harness-core

<!--
## No-spec rationale

<why the change doesn't need a covering spec — e.g. pure docs, test-only,
dependency bump in the vendored lockfile>
-->
