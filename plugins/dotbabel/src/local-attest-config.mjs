/**
 * local-attest-config — config discovery + validation for the local-attest skill.
 *
 * Each consuming repo owns its own matrix (the list of legs to run locally
 * before posting an attestation). Everything else has sensible defaults so a
 * one-line config (just `matrix: [...]`) is enough to get started.
 *
 * Discovery precedence:
 *   1. --config <path>                       (CLI flag)
 *   2. .local-attest.config.mjs              (project root)
 *   3. .local-attest.config.json             (project root)
 *   4. package.json#local-attest             (project root)
 *
 * @typedef {object} Leg
 * @property {string} name
 * @property {"hard"|"advisory"} mode
 * @property {string} command
 * @property {string} [cwd]
 * @property {Record<string, string>} [env]
 *
 * @typedef {object} Config
 * @property {Leg[]} matrix
 * @property {string} label
 * @property {string} auditLogPath
 * @property {string[]} trustedAssociations
 * @property {boolean} requireClean
 * @property {boolean} requireDocker
 * @property {boolean} pushAfterAttest
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** @type {Config} */
export const DEFAULTS = Object.freeze({
  matrix: [],
  label: "ci/local-verified",
  auditLogPath: ".local-attest-log.jsonl",
  trustedAssociations: ["OWNER"],
  requireClean: true,
  requireDocker: false,
  pushAfterAttest: true,
});

/**
 * Thrown by {@link loadConfig} and {@link validateConfig} when discovery or
 * validation fails. Carries an optional `hint` pointing at the schema doc so
 * CLI callers can surface it verbatim.
 */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ hint?: string }} [opts]
   */
  constructor(message, { hint } = {}) {
    super(message);
    this.name = "ConfigError";
    this.code = "LOCAL_ATTEST_CONFIG";
    if (hint) this.hint = hint;
  }
}

const HINT_MISSING =
  "see skills/local-attest/references/config.md for the .local-attest.config.mjs schema and three example configs.";

/**
 * Discover and load a config from `cwd`. When `override` is set, only that
 * exact path is honored (no fallback).
 *
 * @param {{ cwd: string, override?: string|null }} args
 * @returns {Promise<Config>}
 */
export async function loadConfig({ cwd, override }) {
  if (override) {
    const abs = isAbsolute(override) ? override : resolvePath(cwd, override);
    if (!existsSync(abs)) {
      throw new ConfigError(`--config: file not found: ${abs}`, { hint: HINT_MISSING });
    }
    return validateConfig(await loadFile(abs));
  }

  const candidates = [
    { path: resolvePath(cwd, ".local-attest.config.mjs"), kind: "mjs" },
    { path: resolvePath(cwd, ".local-attest.config.json"), kind: "json" },
    { path: resolvePath(cwd, "package.json"), kind: "package" },
  ];
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    if (c.kind === "package") {
      const raw = readFileSync(c.path, "utf8");
      let pkg;
      try {
        pkg = JSON.parse(raw);
      } catch (err) {
        throw new ConfigError(`package.json: ${err.message}`);
      }
      if (pkg && typeof pkg === "object" && pkg["local-attest"]) {
        return validateConfig(pkg["local-attest"]);
      }
      continue;
    }
    return validateConfig(await loadFile(c.path));
  }

  throw new ConfigError(
    `no .local-attest config found in ${cwd} (looked for .local-attest.config.mjs, .local-attest.config.json, package.json#local-attest)`,
    { hint: HINT_MISSING },
  );
}

/** @param {string} abs */
async function loadFile(abs) {
  if (abs.endsWith(".json")) {
    const raw = readFileSync(abs, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new ConfigError(`${abs}: ${err.message}`);
    }
  }
  const url = pathToFileURL(abs).href;
  try {
    const mod = await import(url);
    return mod.default ?? mod;
  } catch (err) {
    throw new ConfigError(`${abs}: ${err.message}`);
  }
}

/**
 * Merge user-supplied config onto DEFAULTS and validate every field. Any
 * structural problem throws ConfigError with a hint pointing at the schema.
 *
 * @param {unknown} input
 * @returns {Config}
 */
export function validateConfig(input) {
  if (!input || typeof input !== "object") {
    throw new ConfigError("config must be an object");
  }
  const user = /** @type {Record<string, unknown>} */ (input);
  const merged = { ...DEFAULTS, ...user };

  if (!Array.isArray(merged.matrix) || merged.matrix.length === 0) {
    throw new ConfigError("config.matrix must be a non-empty array", { hint: HINT_MISSING });
  }
  /** @type {Leg[]} */
  const matrix = [];
  const seen = new Set();
  merged.matrix.forEach((legRaw, i) => {
    if (!legRaw || typeof legRaw !== "object") {
      throw new ConfigError(`config.matrix[${i}] must be an object`);
    }
    const leg = /** @type {Record<string, unknown>} */ (legRaw);
    const name = leg.name;
    if (typeof name !== "string" || name === "") {
      throw new ConfigError(`config.matrix[${i}].name must be a non-empty string`);
    }
    if (seen.has(name)) {
      throw new ConfigError(`config.matrix[${i}].name "${name}" is duplicated`);
    }
    seen.add(name);
    if (leg.mode !== "hard" && leg.mode !== "advisory") {
      throw new ConfigError(
        `config.matrix[${i}].mode must be "hard" or "advisory", got ${JSON.stringify(leg.mode)}`,
      );
    }
    if (typeof leg.command !== "string" || leg.command === "") {
      throw new ConfigError(`config.matrix[${i}].command must be a non-empty string`);
    }
    if (leg.cwd !== undefined && typeof leg.cwd !== "string") {
      throw new ConfigError(`config.matrix[${i}].cwd must be a string`);
    }
    if (leg.env !== undefined && (leg.env === null || typeof leg.env !== "object")) {
      throw new ConfigError(`config.matrix[${i}].env must be an object`);
    }
    matrix.push(/** @type {Leg} */ ({
      name,
      mode: leg.mode,
      command: leg.command,
      ...(leg.cwd !== undefined ? { cwd: leg.cwd } : {}),
      ...(leg.env !== undefined ? { env: { .../** @type {object} */ (leg.env) } } : {}),
    }));
  });

  if (typeof merged.label !== "string" || merged.label === "") {
    throw new ConfigError("config.label must be a non-empty string");
  }
  if (!/^[A-Za-z0-9._/ -]+$/.test(merged.label)) {
    throw new ConfigError(
      "config.label must contain only letters, numbers, dots, underscores, hyphens, slashes, or spaces",
    );
  }
  if (typeof merged.auditLogPath !== "string" || merged.auditLogPath === "") {
    throw new ConfigError("config.auditLogPath must be a non-empty string");
  }
  if (isAbsolute(merged.auditLogPath)) {
    throw new ConfigError("config.auditLogPath must be a relative path");
  }
  if (merged.auditLogPath.split("/").some((seg) => seg === "..")) {
    throw new ConfigError("config.auditLogPath must not contain '..' segments");
  }
  if (
    !Array.isArray(merged.trustedAssociations) ||
    merged.trustedAssociations.length === 0 ||
    !merged.trustedAssociations.every((t) => typeof t === "string" && t.length > 0)
  ) {
    throw new ConfigError("config.trustedAssociations must be a non-empty array of strings");
  }
  const VALID_ASSOCIATIONS = new Set([
    "OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR",
    "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN", "NONE",
  ]);
  for (const assoc of merged.trustedAssociations) {
    if (!VALID_ASSOCIATIONS.has(assoc)) {
      throw new ConfigError(
        `config.trustedAssociations contains unknown value "${assoc}" — must be one of: ${[...VALID_ASSOCIATIONS].join(", ")}`,
      );
    }
  }
  for (const flag of ["requireClean", "requireDocker", "pushAfterAttest"]) {
    if (typeof merged[flag] !== "boolean") {
      throw new ConfigError(`config.${flag} must be a boolean`);
    }
  }

  return /** @type {Config} */ ({
    matrix,
    label: merged.label,
    auditLogPath: merged.auditLogPath,
    trustedAssociations: [...merged.trustedAssociations],
    requireClean: merged.requireClean,
    requireDocker: merged.requireDocker,
    pushAfterAttest: merged.pushAfterAttest,
  });
}
