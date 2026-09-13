/**
 * Reads the `criteria` key of `.dotbabel.json` (P-B2). Only `pass_env`,
 * `timeout_seconds`, and `trusted_associations` are consumed by this unit;
 * `enforcement` and `require_ci_check` are accepted and passed through
 * unvalidated-in-depth because a later unit (the merge gate) owns their
 * semantics — rejecting them here would make this config forward-incompatible
 * with a repository that has already adopted the later unit's keys.
 */
import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";

const PASS_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @returns {{ pass_env: string[], timeout_seconds: number, enforcement: "block"|"warn", trusted_associations: string[], require_ci_check: boolean }} */
export function loadCriteriaConfig(repoRoot) {
  const defaults = {
    pass_env: [],
    timeout_seconds: 600,
    enforcement: "block",
    trusted_associations: ["OWNER"],
    require_ci_check: false,
  };

  const file = path.join(repoRoot, ".dotbabel.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return defaults;
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file: ".dotbabel.json",
      message: `.dotbabel.json is not valid JSON: ${error.message}`,
    });
  }
  const criteria = parsed?.criteria;
  if (criteria === undefined) return defaults;
  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file: ".dotbabel.json",
      pointer: "/criteria",
      message: "criteria must be an object",
    });
  }

  const passEnv = criteria.pass_env ?? defaults.pass_env;
  if (!Array.isArray(passEnv) || passEnv.some((name) => typeof name !== "string" || !PASS_ENV_NAME_RE.test(name))) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file: ".dotbabel.json",
      pointer: "/criteria/pass_env",
      message: "criteria.pass_env must be an array of environment-variable-shaped names",
    });
  }

  const timeoutSeconds = criteria.timeout_seconds ?? defaults.timeout_seconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file: ".dotbabel.json",
      pointer: "/criteria/timeout_seconds",
      message: "criteria.timeout_seconds must be an integer from 1 through 3600",
    });
  }

  const enforcement = criteria.enforcement ?? defaults.enforcement;
  if (enforcement !== "block" && enforcement !== "warn") {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file: ".dotbabel.json",
      pointer: "/criteria/enforcement",
      message: 'criteria.enforcement must be "block" or "warn"',
    });
  }

  const trustedAssociations = criteria.trusted_associations ?? defaults.trusted_associations;
  if (!Array.isArray(trustedAssociations) || trustedAssociations.length === 0 || trustedAssociations.some((v) => typeof v !== "string" || !v.trim())) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file: ".dotbabel.json",
      pointer: "/criteria/trusted_associations",
      message: "criteria.trusted_associations must be a non-empty array of non-empty strings",
    });
  }

  const requireCiCheck = criteria.require_ci_check ?? defaults.require_ci_check;
  if (typeof requireCiCheck !== "boolean") {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file: ".dotbabel.json",
      pointer: "/criteria/require_ci_check",
      message: "criteria.require_ci_check must be a boolean",
    });
  }

  return {
    pass_env: passEnv,
    timeout_seconds: timeoutSeconds,
    enforcement,
    trusted_associations: trustedAssociations,
    require_ci_check: requireCiCheck,
  };
}
