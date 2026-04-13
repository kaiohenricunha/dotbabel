import path from "path";
import {
  anyPathMatches,
  listRepoPaths,
  listSpecDirs,
  readJson,
  pathExists,
} from "./spec-harness-lib.mjs";

const VALID_STATUSES = new Set([
  "draft",
  "approved",
  "implementing",
  "done",
]);

/**
 * Validate every spec.json under docs/specs/.
 *
 * Checks performed per spec:
 *  - spec.json exists
 *  - required fields present and non-empty: id, title, status, owners, linked_paths, acceptance_commands, depends_on_specs, active_prs
 *  - status is one of the allowed enum values
 *  - id matches the directory name
 *  - linked_paths entries are non-empty strings
 *  - acceptance_commands entries are non-empty strings
 *
 * Cross-spec checks:
 *  - depends_on_specs references resolve to known spec ids
 *
 * @param {object} ctx  Harness context from createHarnessContext().
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSpecs(ctx) {
  const errors = [];
  const specDirs = listSpecDirs(ctx);
  const repoPaths = listRepoPaths(ctx);

  // Collect known spec IDs for cross-reference resolution.
  const specIds = new Set(specDirs);

  for (const specDir of specDirs) {
    const specJsonRelative = `docs/specs/${specDir}/spec.json`;
    const prefix = `docs/specs/${specDir}`;

    if (!pathExists(ctx, specJsonRelative)) {
      errors.push(`${prefix}: missing spec.json`);
      continue;
    }

    let metadata;
    try {
      metadata = readJson(ctx, specJsonRelative);
    } catch (err) {
      errors.push(`${prefix}: spec.json is not valid JSON — ${err.message}`);
      continue;
    }

    // id must match directory name.
    if (metadata.id !== specDir) {
      errors.push(`${prefix}: spec.json id "${metadata.id}" must equal directory name "${specDir}"`);
    }

    // title: required, non-empty string.
    if (typeof metadata.title !== "string" || !metadata.title.trim()) {
      errors.push(`${prefix}: spec.json title must be a non-empty string`);
    }

    // status: required, must be in enum.
    if (!VALID_STATUSES.has(metadata.status)) {
      errors.push(`${prefix}: invalid status "${metadata.status}" (allowed: ${[...VALID_STATUSES].join(", ")})`);
    }

    // owners: required, non-empty array.
    if (!Array.isArray(metadata.owners) || metadata.owners.length === 0) {
      errors.push(`${prefix}: owners must be a non-empty array`);
    }

    // linked_paths: required, non-empty array of strings.
    if (!Array.isArray(metadata.linked_paths) || metadata.linked_paths.length === 0) {
      errors.push(`${prefix}: linked_paths must be a non-empty array`);
    } else {
      for (const linkedPath of metadata.linked_paths) {
        if (typeof linkedPath !== "string" || !linkedPath.trim()) {
          errors.push(`${prefix}: linked_paths entries must be non-empty strings`);
        }
      }
    }

    // acceptance_commands: required, non-empty array of non-empty strings.
    if (!Array.isArray(metadata.acceptance_commands) || metadata.acceptance_commands.length === 0) {
      errors.push(`${prefix}: acceptance_commands must be a non-empty array`);
    } else {
      for (const cmd of metadata.acceptance_commands) {
        if (typeof cmd !== "string" || !cmd.trim()) {
          errors.push(`${prefix}: acceptance_commands entries must be non-empty strings`);
        }
      }
    }

    // depends_on_specs: must be an array (can be empty).
    if (!Array.isArray(metadata.depends_on_specs)) {
      errors.push(`${prefix}: depends_on_specs must be an array`);
    }

    // active_prs: must be an array (can be empty).
    if (!Array.isArray(metadata.active_prs)) {
      errors.push(`${prefix}: active_prs must be an array`);
    }
  }

  // Cross-spec: depends_on_specs references must resolve.
  for (const specDir of specDirs) {
    const specJsonRelative = `docs/specs/${specDir}/spec.json`;
    if (!pathExists(ctx, specJsonRelative)) continue;
    let metadata;
    try {
      metadata = readJson(ctx, specJsonRelative);
    } catch {
      continue;
    }
    for (const dependency of metadata.depends_on_specs ?? []) {
      if (typeof dependency !== "string" || !dependency.trim()) continue;
      if (!specIds.has(dependency)) {
        errors.push(`docs/specs/${specDir}: depends_on_specs references unknown spec "${dependency}"`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
