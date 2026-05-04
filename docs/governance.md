# dotclaude Taxonomy Governance

_Last updated: v1.3.0_

## Ownership

`schemas/`, `docs/taxonomy.md`, `docs/facet-definitions.md`, and `docs/governance.md` are owned by the core maintainer group (see `.github/CODEOWNERS`). All other artifacts are community-editable.

## Promotion ladder

| Maturity     | Requirements                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `draft`      | Anyone can author; no consumer expectations; schema is validated but no required peer review.                          |
| `validated`  | Passes schema, has at least one example usage, has a named owner. **ID is now immutable.**                             |
| `production` | Used in at least one real external consumer or by the plugin's own commands; owner on-call for breaking-change review. |
| `deprecated` | Must set `deprecated_by`. After 2 minor plugin releases the artifact is removed.                                       |

Promotion is done by updating the `maturity` field in frontmatter and bumping `version`.

## Adding enum values

To add a new `domain`, `platform`, or `task` value:

1. PR editing `schemas/facets.schema.json` — add the value to the appropriate enum.
2. In the same PR, update `docs/facet-definitions.md` with a definition and at least one concrete example artifact.
3. Rebuild the index: `node plugins/dotclaude/bin/dotclaude-index.mjs`.

No enum is added without a concrete use. CI enforces this by requiring `facet-definitions.md` to be updated in the same PR that touches the enum.

## Removing enum values

1. Verify zero artifacts use the value (`dotclaude list --domain <value>` returns nothing).
2. Record a 30-day deprecation notice in `docs/facet-definitions.md`.
3. After 30 days, remove from `schemas/facets.schema.json` and `docs/facet-definitions.md`.

## CI gates (block PR merge on failure)

1. Frontmatter validates against the type's schema (`dotclaude-validate-skills`).
2. `id` == filename basename (enforced by schema).
3. All `related` and `deprecated_by` ids resolve in the index.
4. Index rebuilds cleanly: `dotclaude-index --check` exits 0.
5. For facet additions: `docs/facet-definitions.md` updated in the same PR.

## ID immutability

Once an artifact reaches `maturity: validated`, its `id` is frozen. To rename:

1. Create a new artifact with the new id.
2. Set `deprecated_by: <new-id>` on the old artifact and update `maturity: deprecated`.
3. After 2 minor releases, remove the deprecated artifact.

## Quarterly review

Once per quarter, run `dotclaude list --json | jq 'group_by(.facets.domain[]) | ...'` to produce a facet usage report. Any value used by fewer than 3 artifacts after 6 months is a candidate for removal or merger.
