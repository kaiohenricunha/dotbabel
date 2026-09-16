/**
 * Reads the `criteria` key of `.dotbabel.json` (P-B2). Only `pass_env`,
 * `timeout_seconds`, and `trusted_associations` are consumed by this unit;
 * `enforcement` and `require_ci_check` are validated here for configuration
 * consistency, although a later unit (the merge gate) consumes them.
 */
import fs from "node:fs";
import path from "node:path";
import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";

const PASS_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const DEFAULT_CONFIG = Object.freeze({
  pass_env: [],
  timeout_seconds: 600,
  enforcement: "block",
  trusted_associations: ["OWNER"],
  require_ci_check: false,
});

/**
 * Validate the `criteria` key of an already-parsed `.dotbabel.json` and return
 * it with defaults filled in. Exported so `project-sync.mjs` rejects a bad
 * `criteria` block at config-load time, the way it already does for `quality`
 * (KD-14) — otherwise a typo in `enforcement` would surface only much later,
 * inside the merge gate, as a silently different verdict.
 *
 * Takes the WHOLE parsed object, not the `criteria` sub-object, so the
 * ValidationError pointers stay rooted at `/criteria/...`.
 *
 * @param {unknown} parsed
 * @param {string} [file]
 * @returns {{ pass_env: string[], timeout_seconds: number, enforcement: "block"|"warn", trusted_associations: string[], require_ci_check: boolean }}
 */
export function validateCriteriaConfig(parsed, file = ".dotbabel.json") {
  const defaults = {
    ...DEFAULT_CONFIG,
    pass_env: [...DEFAULT_CONFIG.pass_env],
    trusted_associations: [...DEFAULT_CONFIG.trusted_associations],
  };
  const criteria = parsed?.criteria;
  if (criteria === undefined) return defaults;
  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file,
      pointer: "/criteria",
      message: "criteria must be an object",
    });
  }

  // Reject unknown keys, exactly as the schema's `additionalProperties: false`
  // says and as `validateQualityConfig` does. Without this a typo such as
  // `enforcment` or `trusted_assocations` loads cleanly and the merge gate
  // then judges every pull request under a default nobody chose — the silent
  // wrong verdict this validation exists to prevent.
  for (const key of Object.keys(criteria)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) {
      throw new ValidationError({
        code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
        category: "criteria",
        file,
        pointer: `/criteria/${key}`,
        message: `unknown criteria key: ${key}`,
        expected: `one of: ${Object.keys(DEFAULT_CONFIG).join(", ")}`,
        got: key,
      });
    }
  }

  const passEnv = criteria.pass_env ?? defaults.pass_env;
  if (!Array.isArray(passEnv) || passEnv.some((name) => typeof name !== "string" || !PASS_ENV_NAME_RE.test(name))) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file,
      pointer: "/criteria/pass_env",
      message: "criteria.pass_env must be an array of environment-variable-shaped names",
    });
  }

  const timeoutSeconds = criteria.timeout_seconds ?? defaults.timeout_seconds;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file,
      pointer: "/criteria/timeout_seconds",
      message: "criteria.timeout_seconds must be an integer from 1 through 3600",
    });
  }

  const enforcement = criteria.enforcement ?? defaults.enforcement;
  if (enforcement !== "block" && enforcement !== "warn") {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file,
      pointer: "/criteria/enforcement",
      message: 'criteria.enforcement must be "block" or "warn"',
    });
  }

  const trustedAssociations = criteria.trusted_associations ?? defaults.trusted_associations;
  if (!Array.isArray(trustedAssociations) || trustedAssociations.length === 0 || trustedAssociations.some((v) => typeof v !== "string" || !v.trim())) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file,
      pointer: "/criteria/trusted_associations",
      message: "criteria.trusted_associations must be a non-empty array of non-empty strings",
    });
  }

  const requireCiCheck = criteria.require_ci_check ?? defaults.require_ci_check;
  if (typeof requireCiCheck !== "boolean") {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file,
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

/**
 * Parse and validate `.dotbabel.json` content from a git object.
 *
 * @param {string|null|undefined} text Missing content selects defaults.
 * @param {string} [file]
 * @returns {{ pass_env: string[], timeout_seconds: number, enforcement: "block"|"warn", trusted_associations: string[], require_ci_check: boolean }}
 */
export function loadCriteriaConfigText(text, file = ".dotbabel.json") {
  if (text === null || text === undefined || text === "") return validateCriteriaConfig(undefined, file);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ValidationError({
      code: ERROR_CODES.CRITERIA_CONFIG_INVALID,
      category: "criteria",
      file,
      message: `${file} is not valid JSON: ${error.message}`,
    });
  }
  return validateCriteriaConfig(parsed, file);
}

/** @returns {{ pass_env: string[], timeout_seconds: number, enforcement: "block"|"warn", trusted_associations: string[], require_ci_check: boolean }} */
export function loadCriteriaConfig(repoRoot) {
  const file = path.join(repoRoot, ".dotbabel.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return loadCriteriaConfigText(null);
    throw error;
  }
  return loadCriteriaConfigText(text);
}
