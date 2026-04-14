import {
  anyPathMatches,
  extractTemplateSection,
  isBotActor,
  isMeaningfulSection,
  listSpecDirs,
  loadFacts,
  readJson,
} from "./spec-harness-lib.mjs";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

const COVERAGE_STATUSES = new Set(["approved", "implementing", "done"]);

function normalizeSpecId(v) {
  return v.replace(/^[`'"#]+|[`'"]+$/g, "").trim();
}

export function checkSpecCoverage(ctx, input) {
  const { changedFiles, isPullRequest, body, actor } = input;
  const errors = [];
  const facts = loadFacts(ctx);
  const protectedFiles = changedFiles.filter((f) =>
    (facts.protected_paths ?? []).some((pat) => anyPathMatches(pat, [f])),
  );

  const specs = listSpecDirs(ctx)
    .map((d) => ({ dir: d, metadata: readJson(ctx, `docs/specs/${d}/spec.json`) }))
    .filter(({ metadata }) => COVERAGE_STATUSES.has(metadata.status));

  const uncovered = protectedFiles.filter((file) =>
    !specs.some(({ metadata }) =>
      (metadata.linked_paths ?? []).some((pat) => anyPathMatches(pat, [file])),
    ),
  );

  const specSection = extractTemplateSection(body, "Spec ID");
  const rationaleSection = extractTemplateSection(body, "No-spec rationale");

  if (isBotActor(actor)) {
    return { ok: true, errors: [], protectedFiles, uncovered, note: "bot bypass" };
  }

  if (isPullRequest && !isMeaningfulSection(specSection) && !isMeaningfulSection(rationaleSection) && protectedFiles.length > 0) {
    errors.push(new ValidationError({
      code: ERROR_CODES.COVERAGE_NO_SPEC_RATIONALE,
      category: "coverage",
      message: "pull request body must include either a Spec ID or a No-spec rationale section",
      hint: "add `## Spec ID\\n<id>` or `## No-spec rationale\\n<reason>` to the PR body",
    }));
  }

  if (isMeaningfulSection(specSection)) {
    const known = new Set(specs.map(({ metadata }) => metadata.id));
    const requested = specSection.split(/[\s,]+/).map(normalizeSpecId).filter(Boolean);
    for (const id of requested) {
      if (!known.has(id)) {
        errors.push(new ValidationError({
          code: ERROR_CODES.COVERAGE_UNKNOWN_SPEC_ID,
          category: "coverage",
          got: id,
          message: `pull request body references unknown Spec ID "${id}"`,
          hint: "check the spec directory under docs/specs/ or create the spec first",
        }));
      }
    }
  }

  if (uncovered.length > 0 && !isMeaningfulSection(rationaleSection)) {
    errors.push(new ValidationError({
      code: ERROR_CODES.COVERAGE_UNCOVERED,
      category: "coverage",
      got: uncovered.join(", "),
      message: "protected files changed without an approved, implementing, or done spec",
      hint: "add a covering spec (status: approved/implementing/done) or a `## No-spec rationale` section",
    }));
  }

  return { ok: errors.length === 0, errors, protectedFiles, uncovered };
}
