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
 * A runtime's user-scope config root — the one directory its global artifacts
 * live under. Hoisted off `globalSkills` so the instruction file and the skills
 * tree resolve the same root instead of each restating it.
 *
 * Resolution order, highest first:
 *   1. `envVar`                        — replaces the whole root outright.
 *   2. `<env[xdgBaseVar]>/<xdgSubdir>` — only for runtimes that declare both.
 *   3. `<homeRoot>/<baseDir>`          — the default.
 *
 * Step 2 exists for XDG-based runtimes: OpenCode reads `XDG_CONFIG_HOME` and
 * appends its own name, so the base var names the *parent* of the root, unlike
 * `CODEX_HOME` / `GEMINI_HOME` / `ANTIGRAVITY_CONFIG_HOME`, which name the root
 * itself. Collapsing the two into one field would have meant inventing an
 * `OPENCODE_HOME` that does not exist.
 *
 * @typedef {object} ConfigDir
 * @property {string} envVar        Env var that replaces the whole root.
 * @property {string} [xdgBaseVar]  Env var naming the root's PARENT.
 * @property {string} [xdgSubdir]   Root's name under `xdgBaseVar`.
 * @property {string} baseDir       Home-relative root when no env var is set.
 */

/**
 * @typedef {object} GlobalInstruction
 * @property {string} templateFile  Basename under templates/cli-instructions/.
 * @property {readonly string[]} dest  Path segments under the resolved base.
 * @property {"homeRoot" | "configDir"} [relativeTo]  Base `dest` resolves
 *   against. Defaults to `"homeRoot"`, which is what every pre-OpenCode runtime
 *   used and keeps their destinations byte-identical.
 */

/**
 * @typedef {object} GlobalSkills
 * @property {string} subdir   Skills directory inside the runtime's config root.
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
 * @property {ConfigDir | null} [configDir]  User-scope config root, when it has one.
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
    configDir: Object.freeze({ envVar: "CODEX_HOME", baseDir: ".codex" }),
    globalSkills: Object.freeze({ subdir: "skills" }),
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
    configDir: Object.freeze({ envVar: "GEMINI_HOME", baseDir: ".gemini" }),
    globalSkills: Object.freeze({ subdir: "skills" }),
    projectFanOut: Object.freeze({ kind: "skills-dir", dir: ".gemini/skills", shareable: true }),
  }),
  // Antigravity CLI.
  //
  // First runtime whose executable name is not its id — `agy`, not
  // `antigravity`. That is why every gate resolves the name through `detect`
  // rather than probing the id directly.
  //
  // It ships no user-scope instruction template of its own: it reads the shared
  // GEMINI.md, so `globalInstruction` and `substitutionKey` stay null.
  //
  // `shareable: false` is the load-bearing field. Antigravity is the first
  // skills-dir runtime that cannot join the `fan_out_layout: "shared"` tree,
  // because `.agents/skills` is a directory codex and gemini do not read — a
  // redirect there would point at a tree nothing follows.
  antigravity: Object.freeze({
    id: "antigravity",
    label: "Antigravity",
    detect: Object.freeze(["agy"]),
    substitutionKey: null,
    globalInstruction: null,
    // Antigravity's global customization root is `~/.gemini/config/` — a
    // separate subtree *inside* Gemini CLI's `~/.gemini/`, never colliding with
    // Gemini's own `~/.gemini/skills/`. Established empirically against agy
    // v1.2.4 because Google's own doc pages disagreed: the binary embeds the
    // literal `~/.gemini/config/skills/<name>/SKILL.md` and contains no
    // `antigravity-cli/skills` string, and a malformed plugin planted in
    // `~/.gemini/config/plugins/` was read at language-server startup, proving
    // that root is live.
    //
    // The nesting is incidental, not structural: `GEMINI_HOME` and
    // `ANTIGRAVITY_CONFIG_HOME` each replace their own root outright, so
    // setting only the former relocates Gemini's skills and leaves
    // Antigravity's where they were. They are separate products whose roots
    // happen to overlap today.
    configDir: Object.freeze({
      envVar: "ANTIGRAVITY_CONFIG_HOME",
      baseDir: ".gemini/config",
    }),
    globalSkills: Object.freeze({ subdir: "skills" }),
    projectFanOut: Object.freeze({
      kind: "skills-dir",
      dir: ".agents/skills",
      shareable: false,
    }),
  }),
  // OpenCode CLI (baseline: v2.0.5).
  //
  // First runtime whose config root is XDG-based rather than a dotfile dir in
  // $HOME, which is why `ConfigDir` grew `xdgBaseVar` / `xdgSubdir`. Proven with
  // `opencode debug paths` under an isolated HOME: the reported `config` root is
  // `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
  // `~/.config/opencode`. `OPENCODE_CONFIG` is a config *file* and moves
  // nothing, so it is deliberately absent here.
  //
  // Both global artifacts hang off that one root — `AGENTS.md` beside a
  // `skills/` tree — which is why the instruction declares
  // `relativeTo: "configDir"`. It is the first runtime to do so; every other
  // one keeps its historical $HOME-relative dest.
  //
  // It reads the project `AGENTS.md` that Codex and Copilot already read, so it
  // joins that artifact's `runtimes` set below instead of adding a second
  // generated file with identical content.
  //
  // `shareable: true` was proven, not assumed: v2.0.5 resolves a symlinked
  // skills root and a symlinked skill directory alike, so `.opencode/skills`
  // can be a redirect into the `fan_out_layout: "shared"` tree.
  //
  // Commands stay wrapped as `<name>/SKILL.md` inside the skills tree, the same
  // shape Codex and Gemini get. OpenCode does have a native
  // `.opencode/command{,s}/` mechanism, but using it would mean a second copy
  // of every command and a tree the shared layout cannot redirect. The wrapped
  // form is discovered correctly, so the native one buys nothing. Note the
  // Claude-compatibility layer is skills-only: `.claude/skills` is read,
  // `.claude/commands` is not.
  opencode: Object.freeze({
    id: "opencode",
    label: "OpenCode",
    detect: Object.freeze(["opencode"]),
    substitutionKey: "opencode",
    configDir: Object.freeze({
      envVar: "OPENCODE_CONFIG_DIR",
      xdgBaseVar: "XDG_CONFIG_HOME",
      xdgSubdir: "opencode",
      baseDir: ".config/opencode",
    }),
    globalInstruction: Object.freeze({
      templateFile: "opencode-AGENTS.md",
      dest: Object.freeze(["AGENTS.md"]),
      relativeTo: "configDir",
    }),
    globalSkills: Object.freeze({ subdir: "skills" }),
    projectFanOut: Object.freeze({ kind: "skills-dir", dir: ".opencode/skills", shareable: true }),
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
    // OpenCode joins Codex and Copilot here rather than getting its own file:
    // v2.0.5 discovers the project `AGENTS.md` by walking up from the CWD, so
    // the artifact they already share is the one it reads.
    runtimes: Object.freeze(["copilot", "codex", "opencode"]),
  }),
  // Read by both Google runtimes — at PROJECT scope only. Antigravity discovers
  // GEMINI.md by walking up from the CWD to the repo root, the same
  // hierarchical rule Gemini CLI uses, documented in the CLI's own bundled
  // guide (agy v1.2.4, builtin/skills/agy-customizations/SKILL.md,
  // "Customization Discovery and Locations") and confirmed against a live
  // install.
  //
  // The user-scope template `gemini-GEMINI.md` deliberately stays
  // `cliSet: ["gemini"]` (generate-instructions.mjs). That walk-up starts at
  // the CWD and stops at the repo root, so it never reaches
  // `~/.gemini/GEMINI.md`; agy v1.2.4 contains no literal for that path, and
  // its documented global root is `~/.gemini/config/`. The two scopes have
  // genuinely different readerships, so their cliSets genuinely differ — if
  // Antigravity is ever shown to read the user-scope file, widen that target
  // and this one together.
  //
  // Membership here is not cosmetic: renderTarget includes a cli-conditional
  // span only when its tag-set is a superset of this list, so a `gemini`-only
  // span now stops reaching GEMINI.md. That is the correct reading — content in
  // a file two runtimes load must hold for both — and it is why this list, not
  // a disjunction at each call site, is where the sharing lives.
  gemini: Object.freeze({
    key: "gemini",
    relativeOutputPath: "GEMINI.md",
    substitutionKey: "gemini",
    runtimes: Object.freeze(["gemini", "antigravity"]),
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
 * Resolve a runtime's user-scope config root.
 *
 * See the {@link ConfigDir} typedef for the three-step order. This is the one
 * place that order lives, so the instruction file and the skills tree cannot
 * drift apart over where a runtime keeps its user-scope state.
 *
 * @param {string} runtimeId
 * @param {string} homeRoot
 * @param {Record<string, string | undefined>} env
 * @returns {string | null} null when the runtime declares no config root.
 */
export function resolveGlobalConfigDir(runtimeId, homeRoot, env) {
  const configDir = RUNTIMES[runtimeId]?.configDir;
  if (!configDir) return null;
  const override = env[configDir.envVar];
  if (override) return override;
  if (configDir.xdgBaseVar) {
    const xdgBase = env[configDir.xdgBaseVar];
    if (xdgBase) return path.join(xdgBase, configDir.xdgSubdir);
  }
  return path.join(homeRoot, configDir.baseDir);
}

/**
 * Resolve where a runtime's user-scope instruction file is linked.
 *
 * `dest` is relative to `homeRoot` unless the runtime declares
 * `relativeTo: "configDir"`, which keeps every pre-OpenCode destination exactly
 * where it has always been — including Codex's `~/.codex/AGENTS.md`, which
 * stays $HOME-relative even when `CODEX_HOME` is set. That asymmetry is
 * pre-existing behaviour, preserved here rather than quietly fixed.
 *
 * @param {string} runtimeId
 * @param {string} homeRoot
 * @param {Record<string, string | undefined>} env
 * @returns {string | null} null when the runtime links no instruction file.
 */
export function resolveGlobalInstructionPath(runtimeId, homeRoot, env) {
  const globalInstruction = RUNTIMES[runtimeId]?.globalInstruction;
  if (!globalInstruction) return null;
  const base =
    globalInstruction.relativeTo === "configDir"
      ? resolveGlobalConfigDir(runtimeId, homeRoot, env)
      : homeRoot;
  return path.join(base ?? homeRoot, ...globalInstruction.dest);
}

/**
 * Resolve a runtime's user-scope skills directory: `<configRoot>/<subdir>`.
 *
 * @param {string} runtimeId
 * @param {string} homeRoot
 * @param {Record<string, string | undefined>} env
 * @returns {string | null} null when the runtime has no skills contract.
 */
export function resolveGlobalSkillsDir(runtimeId, homeRoot, env) {
  const globalSkills = RUNTIMES[runtimeId]?.globalSkills;
  if (!globalSkills) return null;
  const configDir = resolveGlobalConfigDir(runtimeId, homeRoot, env);
  if (!configDir) return null;
  return path.join(configDir, globalSkills.subdir);
}
