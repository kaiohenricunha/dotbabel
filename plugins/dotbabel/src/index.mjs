/**
 * Public barrel for `@dotbabel/dotbabel`.
 *
 * Consumer contract:
 *   import { createHarnessContext, validateSpecs, EXIT_CODES, ValidationError } from "@dotbabel/dotbabel";
 *
 * The surface intentionally stays small — deep imports are NOT a supported
 * contract. If you find yourself reaching for an internal helper that is not
 * re-exported here, open an issue.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// --- spec-harness-lib (18 exports) ---
export {
  createHarnessContext,
  toPosix,
  readJson,
  readText,
  pathExists,
  git,
  loadFacts,
  listSpecDirs,
  listRepoPaths,
  escapeRegex,
  globToRegExp,
  matchesGlob,
  anyPathMatches,
  extractTemplateSection,
  isMeaningfulSection,
  getPullRequestContext,
  isBotActor,
  getChangedFiles,
} from "./spec-harness-lib.mjs";

// --- validators (6 entry points) ---
export { validateSpecs } from "./validate-specs.mjs";
export {
  validateManifest,
  refreshChecksums,
  validateAgents,
  validateAgentTriggerOverlap,
} from "./validate-skills-inventory.mjs";
export { checkInstructionDrift } from "./check-instruction-drift.mjs";
export { checkInstructionsFresh } from "./check-instructions-fresh.mjs";
export { checkInstructionParity } from "./check-instruction-parity.mjs";
export {
  generateInstructions,
  renderTarget,
  extractRuleFloor,
  stripRuleFloorMarkers,
  extractHeadings,
  composeInject,
  validateSubstitutions,
  DEFAULT_TARGETS,
  MANIFEST_RELATIVE_PATH,
  BANNER,
  RULE_FLOOR_BEGIN,
  RULE_FLOOR_END,
} from "./generate-instructions.mjs";
export { checkSpecCoverage } from "./check-spec-coverage.mjs";
export { scaffoldHarness } from "./init-harness-scaffold.mjs";

// --- bootstrap + sync (global ~/.claude/ lifecycle) ---
export { bootstrapGlobal, resolveSource } from "./bootstrap-global.mjs";
export { syncGlobal, resolveMode } from "./sync-global.mjs";

// --- project-scope sync (per-repo ./.codex, ./.gemini, ./.github fan-out) ---
export {
  projectSync,
  loadProjectConfig,
  extractRuleFloorOrWhole,
  DEFAULT_PROJECT_CONFIG,
} from "./project-sync.mjs";
export { checkProjectSync } from "./check-project-sync.mjs";
export {
  scaffoldProjectInit,
  DEFAULT_DOTBABEL_JSON,
} from "./project-init-scaffold.mjs";

// --- taxonomy index (Phase 1: non-breaking) ---
export {
  walkArtifacts,
  parseFrontmatter,
  buildIndex,
  validateArtifacts,
  isIndexStale,
  SCHEMAS_DIR,
  isDirectory,
} from "./build-index.mjs";

// --- error taxonomy + exit codes ---
export { ValidationError, ERROR_CODES, formatError } from "./lib/errors.mjs";
export { EXIT_CODES } from "./lib/exit-codes.mjs";

// --- package version (read from root package.json) ---
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, "..", "..", "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
/** The `@dotbabel/dotbabel` package version at import time. */
export const version = pkg.version;
