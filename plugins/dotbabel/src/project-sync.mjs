/**
 * project-sync.mjs — repo-local fan-out of CLAUDE.md, .claude/commands, and
 * .claude/skills into Codex / Gemini / Copilot project-scope analogues.
 *
 * Mirrors the user-scope flow in `bootstrap-global.mjs`, but rooted at a
 * target repo instead of `$HOME`. Reuses the symlink helpers from
 * `lib/symlink.mjs` and the rule-floor primitives from
 * `generate-instructions.mjs`. Crucially does NOT call `generateInstructions`
 * itself — that path hard-loads `docs/repo-facts.json` and writes the
 * dotbabel-private template manifest, neither of which is correct for an
 * arbitrary consumer repo.
 *
 * Exports:
 *   loadProjectConfig(repoRoot)
 *   projectSync(opts)
 */

import fs from "node:fs";
import path from "node:path";
import { createOutput } from "./lib/output.mjs";
import {
  buildTimestamp,
  commandExists,
  ensureRealDir,
  linkOne,
} from "./lib/symlink.mjs";
import {
  RULE_FLOOR_BEGIN,
  RULE_FLOOR_END,
  composeInject,
  extractRuleFloor,
  renderTarget,
  validateSubstitutions,
} from "./generate-instructions.mjs";
import {
  composeGeneratedFrontmatter,
  isGeneratedFile,
} from "./copilot-frontmatter.mjs";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

/**
 * The CLIs `fan_out` may name. Single source of truth: the config validator,
 * the fan-out dispatch below, and `schemas/dotbabel.config.schema.json` all
 * agree with this list.
 */
export const KNOWN_FAN_OUT_CLIS = Object.freeze(["codex", "gemini", "copilot"]);

/**
 * How Codex and Gemini get their skills trees.
 *
 * `per-cli` writes `.codex/skills/` and `.gemini/skills/` as two byte-identical
 * trees. `shared` writes one canonical tree at {@link SHARED_SKILLS_DIR} and
 * points both CLIs at it with a directory symlink, which halves the tracked
 * entries and the diff noise on every command or skill change (#219, finding C).
 * Copilot is unaffected either way — its `.prompt.md` / `.instructions.md`
 * filename contract cannot share a directory with the `SKILL.md` shape.
 */
export const KNOWN_FAN_OUT_LAYOUTS = Object.freeze(["per-cli", "shared"]);

/** Canonical skills directory used when `fan_out_layout` is `shared`. */
export const SHARED_SKILLS_DIR = ".cli/skills";

/** CLIs that read `<dir>/SKILL.md` and can therefore share one tree. */
const SKILL_DIR_CLIS = Object.freeze(["codex", "gemini"]);

/** Default config returned when `.dotbabel.json` is absent. */
export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  rule_floor_source: "CLAUDE.md",
  commands_dir: ".claude/commands",
  skills_dir: ".claude/skills",
  fan_out: KNOWN_FAN_OUT_CLIS,
  fan_out_layout: "per-cli",
  gate_on_cli_presence: true,
  cli_excluded: Object.freeze({}),
  cli_substitutions: Object.freeze({}),
  targets: Object.freeze([
    Object.freeze({
      relativeOutputPath: "AGENTS.md",
      cliSet: Object.freeze(["copilot", "codex"]),
      substitutionKey: "agents",
    }),
    Object.freeze({
      relativeOutputPath: "GEMINI.md",
      cliSet: Object.freeze(["gemini"]),
      substitutionKey: "gemini",
    }),
    Object.freeze({
      relativeOutputPath: ".github/copilot-instructions.md",
      cliSet: Object.freeze(["copilot"]),
      substitutionKey: "copilot",
    }),
  ]),
});

/**
 * Load `.dotbabel.json` from `repoRoot`, layering its keys over
 * {@link DEFAULT_PROJECT_CONFIG}. Returns the merged config — never mutates
 * the defaults.
 *
 * @param {string} repoRoot
 * @returns {typeof DEFAULT_PROJECT_CONFIG}
 */
export function loadProjectConfig(repoRoot) {
  const cfgPath = path.join(repoRoot, ".dotbabel.json");
  if (!fs.existsSync(cfgPath)) {
    return { ...DEFAULT_PROJECT_CONFIG };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (err) {
    throw new ValidationError({
      code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
      category: "drift",
      file: ".dotbabel.json",
      message: `.dotbabel.json is not valid JSON: ${err.message}`,
      hint: "fix the JSON syntax or delete .dotbabel.json to use defaults",
    });
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError({
      code: ERROR_CODES.DRIFT_INSTRUCTION_FILES,
      category: "drift",
      file: ".dotbabel.json",
      message: ".dotbabel.json must be a JSON object at the top level",
    });
  }
  // A misspelled CLI used to fall through to a warn-and-skip during fan-out,
  // which reads as success in a non-interactive run. Reject it at load time so
  // the typo cannot silently cost a consumer their Copilot wiring (#219).
  if (Array.isArray(raw.fan_out)) {
    raw.fan_out.forEach((cli, i) => {
      if (typeof cli === "string" && KNOWN_FAN_OUT_CLIS.includes(cli)) return;
      throw new ValidationError({
        code: ERROR_CODES.CONFIG_UNKNOWN_CLI,
        category: "settings",
        file: ".dotbabel.json",
        pointer: `/fan_out/${i}`,
        message: `unknown fan_out CLI: ${JSON.stringify(cli)}`,
        expected: `one of: ${KNOWN_FAN_OUT_CLIS.join(", ")}`,
        got: String(cli),
        hint: "fix the name in .dotbabel.json:fan_out, or drop the entry",
      });
    });
  }
  if (raw.fan_out_layout !== undefined && !KNOWN_FAN_OUT_LAYOUTS.includes(raw.fan_out_layout)) {
    throw new ValidationError({
      code: ERROR_CODES.CONFIG_UNKNOWN_LAYOUT,
      category: "settings",
      file: ".dotbabel.json",
      pointer: "/fan_out_layout",
      message: `unknown fan_out_layout: ${JSON.stringify(raw.fan_out_layout)}`,
      expected: `one of: ${KNOWN_FAN_OUT_LAYOUTS.join(", ")}`,
      got: String(raw.fan_out_layout),
      hint: "use \"per-cli\" (default) or \"shared\" in .dotbabel.json:fan_out_layout",
    });
  }
  if (raw.cli_excluded !== undefined) validateCliExcluded(raw.cli_excluded);
  return { ...DEFAULT_PROJECT_CONFIG, ...raw };
}

/**
 * Reject a malformed `cli_excluded` at load time, mirroring the `fan_out`
 * check above: a key that is not a known CLI, or a value that is not a list of
 * names, would otherwise silently exclude nothing (#219, finding A).
 *
 * @param {unknown} value
 */
function validateCliExcluded(value) {
  const invalid = (pointer, got, message) =>
    new ValidationError({
      code: ERROR_CODES.CONFIG_INVALID_EXCLUSION,
      category: "settings",
      file: ".dotbabel.json",
      pointer,
      message,
      expected: "an object mapping a CLI name to a list of command or skill names",
      got: JSON.stringify(got),
      hint: 'example: { "cli_excluded": { "codex": ["review-prs-parallel"] } }',
    });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("/cli_excluded", value, "cli_excluded must be an object");
  }
  for (const [cli, names] of Object.entries(value)) {
    if (!KNOWN_FAN_OUT_CLIS.includes(cli)) {
      throw new ValidationError({
        code: ERROR_CODES.CONFIG_UNKNOWN_CLI,
        category: "settings",
        file: ".dotbabel.json",
        pointer: `/cli_excluded/${cli}`,
        message: `unknown cli_excluded CLI: ${JSON.stringify(cli)}`,
        expected: `one of: ${KNOWN_FAN_OUT_CLIS.join(", ")}`,
        got: cli,
        hint: "fix the key in .dotbabel.json:cli_excluded, or drop it",
      });
    }
    if (!Array.isArray(names)) {
      throw invalid(
        `/cli_excluded/${cli}`,
        names,
        `cli_excluded.${cli} must be a list of command or skill names`,
      );
    }
    names.forEach((name, i) => {
      if (typeof name === "string" && name.length > 0) return;
      throw invalid(
        `/cli_excluded/${cli}/${i}`,
        name,
        `cli_excluded.${cli}[${i}] must be a non-empty string`,
      );
    });
  }
}

/**
 * Names (command basenames and skill ids) that `cli` must not receive.
 *
 * Under the shared layout one canonical tree serves Codex and Gemini alike, so
 * an exclusion for either applies to both: the result is the union of the two
 * lists. `projectSync` warns when the lists differ, since the config then
 * promises a per-CLI distinction the layout cannot deliver.
 *
 * @param {string} cli
 * @param {typeof DEFAULT_PROJECT_CONFIG} cfg
 * @returns {Set<string>}
 */
export function excludedNamesFor(cli, cfg) {
  const map = cfg.cli_excluded ?? {};
  if (cfg.fan_out_layout === "shared" && SKILL_DIR_CLIS.includes(cli)) {
    const fanOut = Array.isArray(cfg.fan_out) ? cfg.fan_out : [];
    const union = new Set();
    for (const sharedCli of SKILL_DIR_CLIS) {
      if (!fanOut.includes(sharedCli)) continue;
      for (const name of map[sharedCli] ?? []) union.add(name);
    }
    return union;
  }
  return new Set(map[cli] ?? []);
}

/**
 * Whether `cli`'s symlink fan-out should run for this config.
 *
 * `dotbabel-check-project-sync` shares this predicate so it skips exactly the
 * CLIs `dotbabel project-sync` skipped. Without that, a machine missing one CLI
 * syncs cleanly and then reports the un-synced CLI as drift (#219, finding D).
 *
 * Note this governs the symlink fan-out only. Instruction files (AGENTS.md and
 * friends) are written unconditionally, so they are never gated.
 *
 * @param {string} cli
 * @param {typeof DEFAULT_PROJECT_CONFIG} cfg
 * @param {{ allCli?: boolean }} [opts]
 * @returns {boolean}
 */
export function shouldFanOutCli(cli, cfg, { allCli = false } = {}) {
  if (allCli) return true;
  if (!cfg.gate_on_cli_presence) return true;
  return commandExists(cli);
}

/**
 * Like `extractRuleFloor`, but falls back to treating the entire body as the
 * rule floor when the source has no markers at all. Marker-mismatch errors
 * (orphan begin or end) still throw, mirroring the harness DX.
 *
 * @param {string} body
 * @returns {string}
 */
export function extractRuleFloorOrWhole(body) {
  try {
    return extractRuleFloor(body);
  } catch (err) {
    if (
      err?.code === ERROR_CODES.DRIFT_UNCLOSED_SPAN &&
      !body.includes(RULE_FLOOR_BEGIN) &&
      !body.includes(RULE_FLOOR_END)
    ) {
      return body.trim();
    }
    throw err;
  }
}

/**
 * @typedef {object} ProjectSyncOpts
 * @property {string} repoRoot
 * @property {boolean} [allCli]   Force fan-out even if a target CLI binary is missing.
 * @property {boolean} [force]    Reserved for collision overrides (currently unused — see warning path).
 * @property {boolean} [dryRun]   Report planned actions, do not mutate.
 * @property {boolean} [quiet]
 * @property {boolean} [json]
 * @property {boolean} [noColor]
 * @property {import('./lib/output.mjs').Output} [out]   Inject for tests.
 *
 * @typedef {object} ProjectSyncResult
 * @property {boolean} ok
 * @property {number} linked
 * @property {number} skipped
 * @property {number} backed_up
 * @property {number} written     Number of instruction files written (or planned in dry-run).
 * @property {number} removed     Number of `cli_excluded` links removed (or planned in dry-run).
 * @property {number} generated   Number of generated Copilot prompt/instructions files written (or planned in dry-run).
 */

/**
 * Synchronize project-scope CLI artifacts in `opts.repoRoot`.
 *
 * @param {ProjectSyncOpts} opts
 * @returns {Promise<ProjectSyncResult>}
 */
export async function projectSync(opts) {
  const repoRoot = opts.repoRoot;
  const out =
    opts.out ??
    createOutput({
      json: opts.json ?? false,
      noColor: opts.noColor ?? false,
      quiet: opts.quiet ?? false,
    });

  if (!fs.existsSync(repoRoot)) {
    out.fail(`repo root does not exist: ${repoRoot}`);
    out.flush();
    return { ok: false, linked: 0, skipped: 0, backed_up: 0, written: 0, removed: 0, generated: 0 };
  }

  const cfg = loadProjectConfig(repoRoot);
  const sourcePath = path.join(repoRoot, cfg.rule_floor_source);
  if (!fs.existsSync(sourcePath)) {
    out.fail(`rule-floor source does not exist: ${cfg.rule_floor_source}`);
    out.flush();
    return { ok: false, linked: 0, skipped: 0, backed_up: 0, written: 0, removed: 0, generated: 0 };
  }

  const timestamp = buildTimestamp();
  let linked = 0;
  let skipped = 0;
  let backed_up = 0;
  let written = 0;
  let removed = 0;
  let generated = 0;

  // ---- 1. Instruction files (AGENTS.md, GEMINI.md, copilot-instructions.md)

  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const subs = validateSubstitutions(
    cfg.cli_substitutions ?? {},
    ".dotbabel.json",
  );

  for (const target of cfg.targets) {
    const { body } = renderTarget(sourceText, target, subs);
    const ruleFloor = extractRuleFloorOrWhole(body);
    const absHost = path.join(repoRoot, target.relativeOutputPath);
    const existing = fs.existsSync(absHost)
      ? fs.readFileSync(absHost, "utf8")
      : "";
    const next = composeInject(
      existing,
      ruleFloor,
      target.relativeOutputPath,
    );
    if (next === existing) {
      out.pass(`ok: ${target.relativeOutputPath}`);
      continue;
    }
    if (opts.dryRun) {
      out.info(
        `would write ${target.relativeOutputPath} (${next.length} bytes, changed)`,
      );
      written++;
      continue;
    }
    fs.mkdirSync(path.dirname(absHost), { recursive: true });
    fs.writeFileSync(absHost, next);
    out.pass(`updated: ${target.relativeOutputPath}`);
    written++;
  }

  // ---- 2. Symlink fan-out for each enabled CLI

  const commandsAbs = path.join(repoRoot, cfg.commands_dir);
  const skillsAbs = path.join(repoRoot, cfg.skills_dir);

  const fanOut = Array.isArray(cfg.fan_out) ? cfg.fan_out : [];
  const sharedLayout = cfg.fan_out_layout === "shared";
  const sharedAbs = path.join(repoRoot, ...SHARED_SKILLS_DIR.split("/"));
  // The canonical tree is built by whichever gated CLI reaches it first; the
  // second one only needs its redirect. A repo fanning out to Copilot alone
  // never gets a .cli/ directory it would not use.
  let sharedBuilt = false;

  warnOnExclusionMismatch();

  for (const cli of fanOut) {
    if (SKILL_DIR_CLIS.includes(cli)) {
      const cliDir = path.join(repoRoot, `.${cli}`, "skills");
      if (!sharedLayout) {
        fanOutSkillsLayout({ cli, targetDir: cliDir });
      } else if (gateOnCli(cli, `${cli} skills fan-out`)) {
        if (!sharedBuilt) {
          buildSkillsTree(sharedAbs, excludedNamesFor(cli, cfg));
          sharedBuilt = true;
        }
        doEnsureRealDir(path.dirname(cliDir));
        doLink(sharedAbs, cliDir);
      }
    } else if (cli === "copilot") {
      fanOutCopilotLayout();
    } else {
      // Defensive only: loadProjectConfig rejects unknown names before we get
      // here. Kept so a programmatically-built cfg cannot silently misdispatch.
      out.warn(`unknown fan_out CLI: ${cli} (skipped)`);
      skipped++;
    }
  }

  out.flush();
  return { ok: true, linked, skipped, backed_up, written, removed, generated };

  // -------------------------------------------------------------------------
  // helpers (closures over linked / skipped / backed_up / removed / out / opts)

  /**
   * Surface `cli_excluded` entries the fan-out cannot honor as written: a name
   * that matches no command or skill, or a per-CLI distinction the shared
   * layout collapses. Neither is an error — the sync still runs — but a silent
   * no-op is exactly what finding A set out to remove.
   */
  function warnOnExclusionMismatch() {
    const map = cfg.cli_excluded ?? {};
    const known = new Set();
    if (fs.existsSync(commandsAbs)) {
      for (const entry of fs.readdirSync(commandsAbs)) {
        if (entry.endsWith(".md")) known.add(entry.replace(/\.md$/, ""));
      }
    }
    if (fs.existsSync(skillsAbs)) {
      for (const entry of fs.readdirSync(skillsAbs, { withFileTypes: true })) {
        if (entry.isDirectory()) known.add(entry.name);
      }
    }
    for (const [cli, names] of Object.entries(map)) {
      for (const name of names) {
        if (known.has(name)) continue;
        out.warn(
          `cli_excluded: ${cli}: no command or skill named "${name}" in ${cfg.commands_dir} or ${cfg.skills_dir}`,
        );
      }
    }
    if (!sharedLayout) return;
    const [a, b] = SKILL_DIR_CLIS;
    if (!fanOut.includes(a) || !fanOut.includes(b)) return;
    for (const [only, other] of [
      [a, b],
      [b, a],
    ]) {
      const otherSet = new Set(map[other] ?? []);
      for (const name of map[only] ?? []) {
        if (otherSet.has(name)) continue;
        out.warn(
          `cli_excluded: fan_out_layout "shared" drops "${name}" for ${other} too (excluded for ${only} only)`,
        );
      }
    }
  }

  function gateOnCli(cli, label) {
    if (shouldFanOutCli(cli, cfg, { allCli: opts.allCli })) return true;
    out.info(`skipped ${label} (${cli} not on PATH; use --all to force)`);
    skipped++;
    return false;
  }

  function doLink(src, dst) {
    // Store the symlink target as a path relative to the link's own
    // directory. fs.symlinkSync persists the string verbatim, so a relative
    // target keeps the link portable across clones and survives a parent-repo
    // rename or worktree cleanup. See #218.
    const linkSrc = path.relative(path.dirname(dst), src);
    if (opts.dryRun) {
      out.info(`would link: ${dst} -> ${linkSrc}`);
      linked++;
      return;
    }
    const r = linkOne(linkSrc, dst, out, timestamp);
    if (r.action === "backed_up") backed_up++;
    if (
      r.action === "linked" ||
      r.action === "updated" ||
      r.action === "ok" ||
      r.action === "backed_up"
    ) {
      linked++;
    }
  }

  function doEnsureRealDir(dst) {
    if (opts.dryRun) {
      // We can still inspect the filesystem to decide whether a backup would
      // happen — but never mutate.
      try {
        const lstat = fs.lstatSync(dst);
        if (!(lstat.isDirectory() && !lstat.isSymbolicLink())) {
          out.info(`would back up + create dir: ${dst}`);
        }
      } catch {
        out.info(`would create dir: ${dst}`);
      }
      return;
    }
    const r = ensureRealDir(dst, out, timestamp);
    if (r.action === "backed_up") backed_up++;
  }

  /**
   * Retire a link at an excluded destination. Only a symlink that resolves to
   * `src` (or dangles) is ours to remove — a real file or a link elsewhere is
   * left in place with a warning, because we did not write it. `wrapDir` is
   * the `<name>/` wrapper of a command entry, dropped once it is empty.
   */
  function doRemoveExcluded(dst, src, wrapDir) {
    let lstat;
    try {
      lstat = fs.lstatSync(dst);
    } catch {
      return;
    }
    const rel = path.relative(repoRoot, dst);
    if (!lstat.isSymbolicLink()) {
      out.warn(`excluded but not a symlink, left alone: ${rel}`);
      return;
    }
    let resolved = null;
    try {
      resolved = fs.realpathSync(dst);
    } catch {
      // Dangling: nothing to compare against, and nothing worth keeping.
    }
    if (resolved !== null && resolved !== fs.realpathSync(src)) {
      out.warn(`excluded but links elsewhere, left alone: ${rel}`);
      return;
    }
    if (opts.dryRun) {
      out.info(`would remove: ${rel}`);
      removed++;
      return;
    }
    fs.unlinkSync(dst);
    if (wrapDir) {
      try {
        if (fs.readdirSync(wrapDir).length === 0) fs.rmdirSync(wrapDir);
      } catch {
        // The wrapper is not ours if it holds anything else; leave it.
      }
    }
    out.pass(`removed: ${rel}`);
    removed++;
  }

  /**
   * Write a generated Copilot file (`.prompt.md` for a command, `.instructions.md`
   * for a skill) at `dst`, mapping `src`'s frontmatter per
   * `copilot-frontmatter.mjs`. Unlike `doLink`, this is a real write, not a
   * symlink, so collision handling is keyed on {@link isGeneratedFile} rather
   * than the symlink bit:
   *
   *  - missing                                  -> write
   *  - present, byte-identical to fresh content  -> no-op
   *  - present, a symlink (pre-#324 leftover)    -> replace, no backup
   *  - present, generated, content differs       -> overwrite, no backup
   *    (our own output evolving, same discipline `composeInject` already
   *    uses for AGENTS.md)
   *  - present, not generated (hand-authored)    -> back up, then write
   *
   * @param {string} dst
   * @param {string} src
   * @param {"command"|"skill"} kind
   */
  function doWriteGenerated(dst, src, kind) {
    const relDst = path.relative(repoRoot, dst);
    const relSrc = path.relative(repoRoot, src);
    const { content, dropped } = composeGeneratedFrontmatter(
      fs.readFileSync(src, "utf8"),
      kind,
      relSrc,
    );
    const surface = kind === "command" ? ".prompt.md" : ".instructions.md";
    for (const key of dropped) {
      out.warn(
        `copilot: dropped Claude-only key "${key}" from ${relDst} (no ${surface} equivalent)`,
      );
    }

    let lstat = null;
    try {
      lstat = fs.lstatSync(dst);
    } catch {
      // Missing — plain write below.
    }

    if (lstat && !lstat.isSymbolicLink()) {
      const existing = fs.readFileSync(dst, "utf8");
      if (existing === content) {
        out.pass(`ok: ${relDst}`);
        generated++;
        return;
      }
      if (!isGeneratedFile(existing)) {
        if (opts.dryRun) {
          out.info(`would back up + write: ${relDst}`);
          generated++;
          return;
        }
        fs.renameSync(dst, `${dst}.bak-${timestamp}`);
        backed_up++;
        out.warn(`hand-authored file backed up: ${relDst}.bak-${timestamp}`);
        fs.writeFileSync(dst, content);
        out.pass(`generated: ${relDst}`);
        generated++;
        return;
      }
    }

    if (opts.dryRun) {
      out.info(`would generate: ${relDst}`);
      generated++;
      return;
    }
    if (lstat && lstat.isSymbolicLink()) fs.unlinkSync(dst);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content);
    out.pass(`generated: ${relDst}`);
    generated++;
  }

  /**
   * Retire a generated Copilot file at an excluded destination. Mirrors
   * {@link doRemoveExcluded}'s "only remove what's recognizably ours" rule,
   * keyed on {@link isGeneratedFile} instead of the symlink bit — a flat
   * file has no wrapper directory to drop.
   *
   * @param {string} dst
   */
  function doRemoveExcludedGenerated(dst) {
    let content;
    try {
      content = fs.readFileSync(dst, "utf8");
    } catch {
      return;
    }
    const rel = path.relative(repoRoot, dst);
    if (!isGeneratedFile(content)) {
      out.warn(`excluded but not dotbabel-generated, left alone: ${rel}`);
      return;
    }
    if (opts.dryRun) {
      out.info(`would remove: ${rel}`);
      removed++;
      return;
    }
    fs.unlinkSync(dst);
    out.pass(`removed: ${rel}`);
    removed++;
  }

  function fanOutSkillsLayout({ cli, targetDir }) {
    if (!gateOnCli(cli, `${cli} skills fan-out`)) return;
    buildSkillsTree(targetDir, excludedNamesFor(cli, cfg));
  }

  /**
   * Populate a `<dir>/<name>/SKILL.md` tree. Split out of
   * `fanOutSkillsLayout` so the shared layout can build the canonical tree
   * once and then hand each CLI a redirect instead of a second copy.
   *
   * @param {string} targetDir
   * @param {Set<string>} excluded  Names to leave out (and retire if present).
   */
  function buildSkillsTree(targetDir, excluded) {
    if (!opts.dryRun) fs.mkdirSync(targetDir, { recursive: true });

    if (fs.existsSync(skillsAbs)) {
      const entries = fs.readdirSync(skillsAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".system") continue;
        const src = path.join(skillsAbs, entry.name);
        const dst = path.join(targetDir, entry.name);
        if (excluded.has(entry.name)) {
          doRemoveExcluded(dst, src);
          continue;
        }
        doLink(src, dst);
      }
    }

    if (fs.existsSync(commandsAbs)) {
      for (const entry of fs.readdirSync(commandsAbs)) {
        if (!entry.endsWith(".md")) continue;
        const name = entry.replace(/\.md$/, "");
        if (name === ".system") continue;
        const src = path.join(commandsAbs, entry);
        const wrapDir = path.join(targetDir, name);
        const dst = path.join(wrapDir, "SKILL.md");
        if (excluded.has(name)) {
          doRemoveExcluded(dst, src, wrapDir);
          continue;
        }
        doEnsureRealDir(wrapDir);
        doLink(src, dst);
      }
    }
  }

  function fanOutCopilotLayout() {
    if (!gateOnCli("copilot", "copilot prompt/instruction fan-out")) return;
    const excluded = excludedNamesFor("copilot", cfg);
    const promptsDir = path.join(repoRoot, ".github", "prompts");
    const instructionsDir = path.join(repoRoot, ".github", "instructions");

    // commands → .github/prompts/<name>.prompt.md (generated, frontmatter mapped)
    if (fs.existsSync(commandsAbs)) {
      if (!opts.dryRun) fs.mkdirSync(promptsDir, { recursive: true });
      for (const entry of fs.readdirSync(commandsAbs)) {
        if (!entry.endsWith(".md")) continue;
        const name = entry.replace(/\.md$/, "");
        if (name === ".system") continue;
        const src = path.join(commandsAbs, entry);
        const dst = path.join(promptsDir, `${name}.prompt.md`);
        if (excluded.has(name)) {
          doRemoveExcludedGenerated(dst);
          continue;
        }
        doWriteGenerated(dst, src, "command");
      }
    }

    // skills/<id>/SKILL.md → .github/instructions/<id>.instructions.md (generated, frontmatter mapped)
    if (fs.existsSync(skillsAbs)) {
      if (!opts.dryRun) fs.mkdirSync(instructionsDir, { recursive: true });
      const entries = fs.readdirSync(skillsAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".system") continue;
        const skillFile = path.join(skillsAbs, entry.name, "SKILL.md");
        if (!fs.existsSync(skillFile)) continue;
        const dst = path.join(
          instructionsDir,
          `${entry.name}.instructions.md`,
        );
        if (excluded.has(entry.name)) {
          doRemoveExcludedGenerated(dst);
          continue;
        }
        doWriteGenerated(dst, skillFile, "skill");
      }
    }
  }
}
