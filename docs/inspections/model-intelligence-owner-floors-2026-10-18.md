# Approved audit-role floors F1, F2 and F6

## Grounded audit and decision

The owner approves all nine decisions before this unit changes an artifact. The mapping is recorded in `docs/specs/model-intelligence/spec/6-implementation-plan.md:779-784` and the approved decision packet. This isolated P-19f subset implements F1 compliance-auditor Frontier/self, F2 data-scientist Deep/self and F6 validate-spec Frontier/consumer. F3/F4/F5/F7 and P-19c/d/e remain separate units.

Candidate one is missing owner intent. The original agent and skill frontmatter has only legacy selectors (`agents/compliance-auditor.md:21`, `agents/data-scientist.md:20`, `skills/validate-spec/SKILL.md:23-24`), but the explicit approved mapping rejects that explanation. Candidate two is an unapplied approved migration. The canonical files have no `dotbabel.compute` declaration. Choose the second explanation and add only the approved semantic declarations.

The public writer intentionally leaves unresolved category-F decisions untouched at `plugins/dotbabel/src/model-intelligence/compat/migrate.mjs:57`. These three decisions are now resolved. The explicit migration mapping therefore records them as known semantic category C for the writer, with original owner decision IDs F1/F2/F6 retained in the immutable proof fixture. This does not change the historical classification or infer an owner choice. No migration-engine or runtime code changes occur.

## Preserved behavior and limits

The original frontmatter and body hashes are captured from main commit `5d388d23c02dc5debae5c5c1d851e6ab653341d0` before editing. Both agents retain their exact native selectors, read-only tools and complete original bodies. The validation skill retains its read-only audit workflow, original native metadata and allowed tools. Its semantic floor is a consumer requirement; native skill metadata does not enforce it. No worker, coordinator, permission, invocation, confirmation, model-quality ranking or entitlement claim is added.

The compatibility bridge uses the existing public resolver and accepted release facts. Tests compare original and migrated projections, require exact native agent models with no added reasoning, reject insufficient capability evidence, and require unknown native skill enforcement. Canonical compute metadata is stripped from native projections. Generated exports must come from the public index, skills, plugin, project-sync and consumer initialization generators.

## Verification contract

Run the focused owner-floor tests first and retain their failing pre-migration result. Apply the three explicit reviewed decisions with `dotbabel models migrate --write --batch C --decisions ...`, restricted by that decision list. Verify the report writes exactly the three approved canonical paths. Run the same focused tests, all four real generated/drift commands, the public feature check, specification validation, document stamps and the PR/fast policy profiles. The migration changes only artifact data and derived exports, so no new runtime mutation target exists. Run the explicit full four-role fleet required by IMPL-17, resolve findings, verify every implicated spec through the public criteria writer, and merge only with exact-head Node20/22 CI and a fresh READY gate.
