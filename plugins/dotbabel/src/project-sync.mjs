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
  ERROR_CODES,
} from "./generate-instructions.mjs";
import { ValidationError } from "./lib/errors.mjs";

/** Default config returned when `.dotbabel.json` is absent. */
export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  rule_floor_source: "CLAUDE.md",
  commands_dir: ".claude/commands",
  skills_dir: ".claude/skills",
  fan_out: Object.freeze(["codex", "gemini", "copilot"]),
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
  return { ...DEFAULT_PROJECT_CONFIG, ...raw };
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
  for (const cli of fanOut) {
    if (cli === "codex") {
      fanOutSkillsLayout({
        cli: "codex",
        targetDir: path.join(repoRoot, ".codex", "skills"),
      });
    } else if (cli === "gemini") {
      fanOutSkillsLayout({
        cli: "gemini",
        targetDir: path.join(repoRoot, ".gemini", "skills"),
      });
    } else if (cli === "copilot") {
      fanOutCopilotLayout();
    } else {
      out.warn(`unknown fan_out CLI: ${cli} (skipped)`);
      skipped++;
    }
  }

  out.flush();
  return { ok: true, linked, skipped, backed_up, written };

  // -------------------------------------------------------------------------
  // helpers (closures over linked / skipped / backed_up / out / opts)

  function gateOnCli(cli, label) {
    if (opts.allCli) return true;
    if (!cfg.gate_on_cli_presence) return true;
    if (commandExists(cli)) return true;
    out.info(`skipped ${label} (${cli} not on PATH; use --all to force)`);
    skipped++;
    return false;
  }

  function doLink(src, dst) {
    if (opts.dryRun) {
      out.info(`would link: ${dst} -> ${src}`);
      linked++;
      return;
    }
    const r = linkOne(src, dst, out, timestamp);
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
