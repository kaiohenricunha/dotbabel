/**
 * agents.mjs — the single source of truth for agent CLI metadata.
 *
 * Two concepts, deliberately separate:
 *
 *   RUNTIMES             an installable CLI. Owns how it is detected, its
 *                        user-scope instruction file, its user-scope skills
 *                        directory, and the shape of its project fan-out.
 *   INSTRUCTION_ARTIFACTS a generated project file. Owns its repo-relative
 *                        path and the SET of runtimes that read it.
 *
 * The split is not new: `AGENTS.md` already serves both copilot and codex
 * (`cliSet: ["copilot", "codex"]`), and `docs/repo-facts.json` already keys a
 * substitution map on `agents` — an artifact with no runtime of that name. So
 * "several runtimes read one file" is an existing fact about the project that
 * was encoded once per call site. Here it is data, which is what keeps a second
 * runtime reading a shared file from becoming another `if (a || b)` branch.
 *
 * Note the asymmetry the two concepts capture: a runtime's substitution key is
 * its own (`codex-AGENTS.md` renders with `codex`), while a shared artifact's
 * key is neutral (`AGENTS.md` renders with `agents`) precisely because more
 * than one runtime reads it.
 *
 * This module is pure data plus resolvers. It reads no files and runs no
 * project commands; the only side effect reachable from here is the PATH probe
 * in `anyRuntimePresent`.
 */

import path from "node:path";
import { commandExists } from "./lib/symlink.mjs";

/**
 * @typedef {object} GlobalInstruction
 * @property {string} templateFile  Basename under templates/cli-instructions/.
 * @property {readonly string[]} dest  Path segments under the user's home root.
 */

/**
 * @typedef {object} GlobalSkills
 * @property {string} envVar   Env var that replaces the whole config dir.
 * @property {string} baseDir  Home-relative config dir when the env var is unset.
 * @property {string} subdir   Skills directory inside the config dir.
 */

/**
 * @typedef {object} ProjectFanOut
 * @property {"skills-dir" | "copilot-files"} kind  Shape written into a repo.
 * @property {string} [dir]        Repo-relative skills dir, for `skills-dir`.
 * @property {boolean} [shareable] Whether the tree can be shared via a redirect.
 */

/**
 * @typedef {object} Runtime
 * @property {string} id
 * @property {string} label  Short display name; rendered in `dotbabel doctor`.
 * @property {readonly string[]} detect  Executable names probed on PATH.
 * @property {string | null} substitutionKey  Key for this runtime's own template.
 * @property {GlobalInstruction | null} globalInstruction
 * @property {GlobalSkills | null} globalSkills
 * @property {ProjectFanOut | null} projectFanOut
 */

/**
 * Installable agent CLIs.
 *
 * Declaration order is contractual: {@link fanOutRuntimes} derives
 * `KNOWN_FAN_OUT_CLIS` from it, and that list reaches a JSON-Schema enum.
 *
 * @type {Readonly<Record<string, Runtime>>}
 */
export const RUNTIMES = Object.freeze({
  // Claude Code is the tool dotbabel configures, not a fan-out destination. It
  // is never gated on presence, which is why every field below is null.
  claude: Object.freeze({
    id: "claude",
    label: "Claude",
    detect: Object.freeze(["claude"]),
    substitutionKey: null,
    globalInstruction: null,
    globalSkills: null,
    projectFanOut: null,
  }),
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    detect: Object.freeze(["codex"]),
    substitutionKey: "codex",
    globalInstruction: Object.freeze({
      templateFile: "codex-AGENTS.md",
      dest: Object.freeze([".codex", "AGENTS.md"]),
    }),
    globalSkills: Object.freeze({ envVar: "CODEX_HOME", baseDir: ".codex", subdir: "skills" }),
    projectFanOut: Object.freeze({ kind: "skills-dir", dir: ".codex/skills", shareable: true }),
  }),
  gemini: Object.freeze({
    id: "gemini",
    label: "Gemini",
    detect: Object.freeze(["gemini"]),
    substitutionKey: "gemini",
    globalInstruction: Object.freeze({
      templateFile: "gemini-GEMINI.md",
      dest: Object.freeze([".gemini", "GEMINI.md"]),
    }),
    globalSkills: Object.freeze({ envVar: "GEMINI_HOME", baseDir: ".gemini", subdir: "skills" }),
    projectFanOut: Object.freeze({ kind: "skills-dir", dir: ".gemini/skills", shareable: true }),
  }),
  // Antigravity CLI. Detection-only for now: the fan-out and instruction
  // fields are filled in by later commits, so this entry changes no behaviour
  // beyond making `agy` a runtime the registry can name.
  //
  // First runtime whose executable name is not its id — `agy`, not
  // `antigravity`. That is why every gate resolves the name through `detect`
  // rather than probing the id directly.
  antigravity: Object.freeze({
    id: "antigravity",
    label: "Antigravity",
    detect: Object.freeze(["agy"]),
    substitutionKey: null,
    globalInstruction: null,
    globalSkills: null,
    projectFanOut: null,
  }),
  // Copilot CLI has no skill auto-discovery dir, and its project artifacts are
  // generated `.prompt.md` / `.instructions.md` files whose filename contract
  // cannot share a directory with the `SKILL.md` shape.
  copilot: Object.freeze({
    id: "copilot",
    label: "Copilot",
    detect: Object.freeze(["copilot"]),
    substitutionKey: "copilot",
    globalInstruction: Object.freeze({
      templateFile: "copilot-instructions.md",
      dest: Object.freeze([".github", "copilot-instructions.md"]),
    }),
    globalSkills: null,
    projectFanOut: Object.freeze({ kind: "copilot-files" }),
  }),
});

/**
 * @typedef {object} InstructionArtifact
 * @property {string} key
 * @property {string} relativeOutputPath  Repo-relative POSIX path.
 * @property {string} substitutionKey     Neutral when several runtimes read it.
 * @property {readonly string[]} runtimes Runtimes that read this file.
 */

/**
 * Generated project instruction files.
 *
 * Declaration order is contractual: {@link projectArtifactTargets} derives the
 * default target list from it.
 *
 * @type {Readonly<Record<string, InstructionArtifact>>}
 */
export const INSTRUCTION_ARTIFACTS = Object.freeze({
  agents: Object.freeze({
    key: "agents",
    relativeOutputPath: "AGENTS.md",
    substitutionKey: "agents",
    runtimes: Object.freeze(["copilot", "codex"]),
  }),
  gemini: Object.freeze({
    key: "gemini",
    relativeOutputPath: "GEMINI.md",
    substitutionKey: "gemini",
    runtimes: Object.freeze(["gemini"]),
  }),
  copilot: Object.freeze({
    key: "copilot",
    relativeOutputPath: ".github/copilot-instructions.md",
    substitutionKey: "copilot",
    runtimes: Object.freeze(["copilot"]),
  }),
});

/**
 * Runtimes that participate in project fan-out at all.
 *
 * @returns {string[]}
 */
export function fanOutRuntimes() {
  return Object.values(RUNTIMES)
    .filter((runtime) => runtime.projectFanOut !== null)
    .map((runtime) => runtime.id);
}

/**
 * Runtimes whose project fan-out is a `<dir>/SKILL.md` tree.
 *
 * This answers "which dispatch branch does this runtime take", which is not the
 * same question as {@link shareableSkillRuntimes}: a runtime can write a skills
 * tree without its tree being interchangeable with another runtime's.
 *
 * @returns {string[]}
 */
export function skillDirRuntimes() {
  return Object.values(RUNTIMES)
    .filter((runtime) => runtime.projectFanOut?.kind === "skills-dir")
    .map((runtime) => runtime.id);
}

/**
 * Runtimes whose skills tree can be shared with the others behind a directory
 * redirect, under `fan_out_layout: "shared"`.
 *
 * Sharing requires every participant to read a byte-identical tree at a path
 * each one accepts. A runtime reading a differently-named directory keeps its
 * own tree even though it is also a `skills-dir` runtime.
 *
 * @returns {string[]}
 */
export function shareableSkillRuntimes() {
  return Object.values(RUNTIMES)
    .filter((runtime) => runtime.projectFanOut?.kind === "skills-dir" && runtime.projectFanOut.shareable)
    .map((runtime) => runtime.id);
}

/**
 * A runtime's repo-relative project skills directory.
 *
 * @param {string} runtimeId
 * @returns {string | null} null when the runtime writes no skills tree.
 */
export function projectSkillsDir(runtimeId) {
  return RUNTIMES[runtimeId]?.projectFanOut?.dir ?? null;
}

/**
 * A runtime's absolute project skills directory under `repoRoot`.
 *
 * @param {string} runtimeId
 * @param {string} repoRoot
 * @returns {string | null} null when the runtime writes no skills tree.
 */
export function resolveProjectSkillsDir(runtimeId, repoRoot) {
  const dir = projectSkillsDir(runtimeId);
  return dir ? path.join(repoRoot, ...dir.split("/")) : null;
}

/**
 * The default instruction targets, in the shape consumers already expect.
 *
 * @returns {{ relativeOutputPath: string, cliSet: string[], substitutionKey: string }[]}
 */
export function projectArtifactTargets() {
  return Object.values(INSTRUCTION_ARTIFACTS).map((artifact) => ({
    relativeOutputPath: artifact.relativeOutputPath,
    cliSet: [...artifact.runtimes],
    substitutionKey: artifact.substitutionKey,
  }));
}

/**
 * Whether any of `runtimeIds` has an executable on PATH.
 *
 * This is the one place a shared instruction file's audience is resolved, so a
 * file read by several runtimes stays one presence question instead of a
 * disjunction repeated at each call site.
 *
 * Deliberately a pure detection predicate: force-mode (`--all`) is a caller
 * policy, not a property of what is installed, and callers already own that
 * check (`shouldFanOutCli` in project-sync.mjs, the two gates in
 * bootstrap-global.mjs). Folding it in here gave the flag two meanings.
 *
 * @param {readonly string[]} runtimeIds
 * @returns {boolean}
 */
export function anyRuntimePresent(runtimeIds) {
  return runtimeIds.some((id) =>
    (RUNTIMES[id]?.detect ?? []).some((command) => commandExists(command)),
  );
}

/**
 * Resolve a runtime's user-scope skills directory.
 *
 * The env var replaces the whole config dir, not just its parent, matching
 * `CODEX_HOME` / `GEMINI_HOME` handling in bootstrap-global.mjs.
 *
 * @param {string} runtimeId
 * @param {string} homeRoot
 * @param {Record<string, string | undefined>} env
 * @returns {string | null} null when the runtime has no skills contract.
 */
export function resolveGlobalSkillsDir(runtimeId, homeRoot, env) {
  const globalSkills = RUNTIMES[runtimeId]?.globalSkills;
  if (!globalSkills) return null;
  const configDir = env[globalSkills.envVar] || path.join(homeRoot, globalSkills.baseDir);
  return path.join(configDir, globalSkills.subdir);
}
