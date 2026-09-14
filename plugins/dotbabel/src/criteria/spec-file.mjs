import fs from "node:fs";
import path from "node:path";

import { listSpecDirs } from "../spec-harness-lib.mjs";
import { ERROR_CODES, ValidationError } from "../lib/errors.mjs";

function specError(specId, message = `unknown spec: ${specId}`) {
  return new ValidationError({
    code: ERROR_CODES.CRITERIA_UNKNOWN_SPEC,
    category: "criteria",
    message,
  });
}

/**
 * Read one known spec without following a symbolic link or leaving the repository.
 *
 * @param {import("../spec-harness-lib.mjs").HarnessContext} ctx
 * @param {string} specId
 * @returns {any}
 */
export function readCriteriaSpec(ctx, specId) {
  let known = [];
  try {
    known = listSpecDirs(ctx);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!known.includes(specId)) throw specError(specId);

  const specDir = path.join(ctx.specsRoot, specId);
  const specFile = path.join(specDir, "spec.json");
  let dirStat;
  let fileStat;
  try {
    dirStat = fs.lstatSync(specDir);
    fileStat = fs.lstatSync(specFile);
  } catch {
    throw specError(specId);
  }
  if (dirStat.isSymbolicLink() || fileStat.isSymbolicLink()) {
    throw specError(specId, `spec ${specId} uses a symbolic link for its directory or spec.json`);
  }
  if (!dirStat.isDirectory() || !fileStat.isFile()) throw specError(specId);

  const repoRoot = fs.realpathSync(ctx.repoRoot);
  const realFile = fs.realpathSync(specFile);
  if (!realFile.startsWith(`${repoRoot}${path.sep}`)) {
    throw specError(specId, `spec ${specId} resolves outside the repository`);
  }
  return JSON.parse(fs.readFileSync(specFile, "utf8"));
}
