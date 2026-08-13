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
  return { ...DEFAULT_PROJECT_CONFIG, ...raw };
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
    return { ok: false, linked: 0, skipped: 0, backed_up: 0, written: 0 };
  }

  const cfg = loadProjectConfig(repoRoot);
  const sourcePath = path.join(repoRoot, cfg.rule_floor_source);
  if (!fs.existsSync(sourcePath)) {
    out.fail(`rule-floor source does not exist: ${cfg.rule_floor_source}`);
    out.flush();
    return { ok: false, linked: 0, skipped: 0, backed_up: 0, written: 0 };
  }

  const timestamp = buildTimestamp();
  let linked = 0;
  let skipped = 0;
  let backed_up = 0;
  let written = 0;

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

  for (const cli of fanOut) {
    if (SKILL_DIR_CLIS.includes(cli)) {
      const cliDir = path.join(repoRoot, `.${cli}`, "skills");
      if (!sharedLayout) {
        fanOutSkillsLayout({ cli, targetDir: cliDir });
      } else if (gateOnCli(cli, `${cli} skills fan-out`)) {
        if (!sharedBuilt) {
          buildSkillsTree(sharedAbs);
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
  return { ok: true, linked, skipped, backed_up, written };

  // -------------------------------------------------------------------------
  // helpers (closures over linked / skipped / backed_up / out / opts)

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

  function fanOutSkillsLayout({ cli, targetDir }) {
    if (!gateOnCli(cli, `${cli} skills fan-out`)) return;
    buildSkillsTree(targetDir);
  }

  /**
   * Populate a `<dir>/<name>/SKILL.md` tree. Split out of
   * `fanOutSkillsLayout` so the shared layout can build the canonical tree
   * once and then hand each CLI a redirect instead of a second copy.
   */
  function buildSkillsTree(targetDir) {
    if (!opts.dryRun) fs.mkdirSync(targetDir, { recursive: true });

    if (fs.existsSync(skillsAbs)) {
      const entries = fs.readdirSync(skillsAbs, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".system") continue;
        const src = path.join(skillsAbs, entry.name);
        const dst = path.join(targetDir, entry.name);
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
        doEnsureRealDir(wrapDir);
        const dst = path.join(wrapDir, "SKILL.md");
        doLink(src, dst);
      }
    }
  }

  function fanOutCopilotLayout() {
    if (!gateOnCli("copilot", "copilot prompt/instruction fan-out")) return;
    const promptsDir = path.join(repoRoot, ".github", "prompts");
    const instructionsDir = path.join(repoRoot, ".github", "instructions");

    // commands → .github/prompts/<name>.prompt.md
    if (fs.existsSync(commandsAbs)) {
      if (!opts.dryRun) fs.mkdirSync(promptsDir, { recursive: true });
      for (const entry of fs.readdirSync(commandsAbs)) {
        if (!entry.endsWith(".md")) continue;
        const name = entry.replace(/\.md$/, "");
        if (name === ".system") continue;
        const src = path.join(commandsAbs, entry);
        const dst = path.join(promptsDir, `${name}.prompt.md`);
        doLink(src, dst);
      }
    }

    // skills/<id>/SKILL.md → .github/instructions/<id>.instructions.md
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
        doLink(skillFile, dst);
      }
    }
  }
}
