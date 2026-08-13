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
 * @property {Record<string, string>} [env]           values must be strings — they flow
 *                                                    verbatim into the child environment
 * @property {string} [lane]                          legs sharing a lane run serially in
 *                                                    matrix order; distinct lanes run
 *                                                    concurrently; no lane = one shared
 *                                                    default lane (fully sequential)
 * @property {{ changedPaths: string[] }} [when]      run the leg only when SOME changed PR
 *                                                    file matches one of these globs — a CI
 *                                                    path filter mirrored locally; misses
 *                                                    mark the leg skipped, never remove it
 * @property {string[]} [skipWhenDiffOnly]            skip the leg when EVERY changed PR file
 *                                                    matches one of these globs — a docs-only
 *                                                    classify rule mirrored locally
 * @property {boolean} [passPrBody]                   inject the PR body as env.PR_BODY for
 *                                                    this leg (fetched once, empty on error)
 *
 * @typedef {object} Toolchain
 * @property {string} [node]   exact major version pin ("22"); the `node` on PATH
 *                             must have that major, or an attest run fails closed.
 *                             Range syntax (">=22", "^22") is rejected at
 *                             validation — the check is exact-major only, and
 *                             accepting ranges it would misread is worse than
 *                             refusing them
 * @property {string} [goMod]  path (relative, no "..") to a go.mod whose `go`
 *                             directive's major.minor must match `go version`
 *
 * @typedef {object} Config
 * @property {Leg[]} matrix
 * @property {string} label
 * @property {string} auditLogPath
 * @property {string[]} trustedAssociations
 * @property {boolean} requireClean
 * @property {boolean} requireDocker
 * @property {boolean} pushAfterAttest
 * @property {Toolchain|null} toolchain
 * @property {string[]} restoreFiles  tracked files a leg is known to overwrite (e2e seeders);
 *                                    snapshotted before the matrix and restored byte-exact in
 *                                    a finally, BEFORE the post-matrix head recheck — without
 *                                    this the recheck aborts every run on the leg's own writes
 */

import { existsSync, readFileSync } from "node:fs";

import { UNSUPPORTED_GLOB_CHARS } from "./local-attest-lib.mjs";
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
  toolchain: null,
  restoreFiles: [],
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
    if (leg.env !== undefined) {
      for (const [k, v] of Object.entries(/** @type {object} */ (leg.env))) {
        if (typeof v !== "string") {
          throw new ConfigError(
            `config.matrix[${i}].env.${k} must be a string — env values flow verbatim into the child environment`,
          );
        }
      }
    }
    if (leg.lane !== undefined && (typeof leg.lane !== "string" || leg.lane === "")) {
      throw new ConfigError(`config.matrix[${i}].lane must be a non-empty string`);
    }
    if (leg.when !== undefined) {
      const w = /** @type {Record<string, unknown>} */ (leg.when);
      if (!w || typeof w !== "object" || Array.isArray(w)) {
        throw new ConfigError(
          `config.matrix[${i}].when must be an object like { changedPaths: [globs] }`,
        );
      }
      const keys = Object.keys(w);
      if (keys.length !== 1 || keys[0] !== "changedPaths") {
        throw new ConfigError(`config.matrix[${i}].when supports exactly one key: changedPaths`);
      }
      if (
        !Array.isArray(w.changedPaths) ||
        w.changedPaths.length === 0 ||
        !w.changedPaths.every((g) => typeof g === "string" && g !== "")
      ) {
        throw new ConfigError(
          `config.matrix[${i}].when.changedPaths must be a non-empty array of glob strings`,
        );
      }
      for (const g of w.changedPaths) {
        if (UNSUPPORTED_GLOB_CHARS.test(/** @type {string} */ (g))) {
          throw new ConfigError(
            `config.matrix[${i}].when.changedPaths: ${JSON.stringify(g)} uses glob syntax this dialect does not support (only **, *, ?) — a copied CI glob that silently matches nothing would skip this leg on every PR`,
          );
        }
      }
    }
    if (leg.skipWhenDiffOnly !== undefined) {
      if (
        !Array.isArray(leg.skipWhenDiffOnly) ||
        leg.skipWhenDiffOnly.length === 0 ||
        !leg.skipWhenDiffOnly.every((g) => typeof g === "string" && g !== "")
      ) {
        throw new ConfigError(
          `config.matrix[${i}].skipWhenDiffOnly must be a non-empty array of glob strings`,
        );
      }
      for (const g of /** @type {string[]} */ (leg.skipWhenDiffOnly)) {
        if (UNSUPPORTED_GLOB_CHARS.test(g)) {
          throw new ConfigError(
            `config.matrix[${i}].skipWhenDiffOnly: ${JSON.stringify(g)} uses glob syntax this dialect does not support (only **, *, ?)`,
          );
        }
      }
    }
    if (leg.passPrBody !== undefined && typeof leg.passPrBody !== "boolean") {
      throw new ConfigError(`config.matrix[${i}].passPrBody must be a boolean`);
    }
    matrix.push(
      /** @type {Leg} */ ({
        name,
        mode: leg.mode,
        command: leg.command,
        ...(leg.cwd !== undefined ? { cwd: leg.cwd } : {}),
        ...(leg.env !== undefined ? { env: { .../** @type {object} */ (leg.env) } } : {}),
        ...(leg.lane !== undefined ? { lane: leg.lane } : {}),
        ...(leg.when !== undefined
          ? {
              when: {
                changedPaths: [.../** @type {{changedPaths: string[]}} */ (leg.when).changedPaths],
              },
            }
          : {}),
        ...(leg.skipWhenDiffOnly !== undefined
          ? { skipWhenDiffOnly: [.../** @type {string[]} */ (leg.skipWhenDiffOnly)] }
          : {}),
        ...(leg.passPrBody !== undefined ? { passPrBody: leg.passPrBody } : {}),
      }),
    );
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
    "OWNER",
    "MEMBER",
    "COLLABORATOR",
    "CONTRIBUTOR",
    "FIRST_TIMER",
    "FIRST_TIME_CONTRIBUTOR",
    "MANNEQUIN",
    "NONE",
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

  /** @type {import("./local-attest-config.mjs").Toolchain|null} */
  let toolchain = null;
  if (merged.toolchain !== null && merged.toolchain !== undefined) {
    if (typeof merged.toolchain !== "object" || Array.isArray(merged.toolchain)) {
      throw new ConfigError("config.toolchain must be an object with optional node/goMod strings");
    }
    const t = /** @type {Record<string, unknown>} */ (merged.toolchain);
    // An empty pin block would silently disable the fail-closed check while
    // looking like a declared pin — the one shape an operator produces by
    // commenting out the only entry. Refuse it; omitting the key opts out.
    if (Object.keys(t).length === 0) {
      throw new ConfigError(
        "config.toolchain must declare at least one pin (node, goMod) — omit the key to opt out",
      );
    }
    for (const key of Object.keys(t)) {
      if (key !== "node" && key !== "goMod") {
        throw new ConfigError(`config.toolchain.${key} is not a recognised pin (use node, goMod)`);
      }
      if (typeof t[key] !== "string" || t[key] === "") {
        throw new ConfigError(`config.toolchain.${key} must be a non-empty string`);
      }
    }
    // The node check compares exact majors. Range syntax parses to its first
    // integer, so ">=20" would BLOCK Node 22 — the documented meaning
    // inverted. Reject it rather than misread it.
    if (t.node !== undefined && /[><^~|]/.test(/** @type {string} */ (t.node))) {
      throw new ConfigError(
        `config.toolchain.node must be an exact major version pin like "22" — range syntax (${JSON.stringify(t.node)}) is not honored`,
      );
    }
    if (t.goMod !== undefined) {
      const goMod = /** @type {string} */ (t.goMod);
      if (isAbsolute(goMod)) {
        throw new ConfigError("config.toolchain.goMod must be a relative path");
      }
      if (goMod.split("/").some((seg) => seg === "..")) {
        throw new ConfigError("config.toolchain.goMod must not contain '..' segments");
      }
    }
    toolchain = {
      ...(t.node !== undefined ? { node: /** @type {string} */ (t.node) } : {}),
      ...(t.goMod !== undefined ? { goMod: /** @type {string} */ (t.goMod) } : {}),
    };
  }

  if (
    !Array.isArray(merged.restoreFiles) ||
    !merged.restoreFiles.every((f) => typeof f === "string" && f !== "")
  ) {
    throw new ConfigError("config.restoreFiles must be an array of file paths");
  }
  for (const f of /** @type {string[]} */ (merged.restoreFiles)) {
    if (isAbsolute(f)) {
      throw new ConfigError("config.restoreFiles entries must be relative paths");
    }
    if (f.split("/").some((seg) => seg === "..")) {
      throw new ConfigError("config.restoreFiles entries must not contain '..' segments");
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
    toolchain,
    restoreFiles: [.../** @type {string[]} */ (merged.restoreFiles)],
  });
}
