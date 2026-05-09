/**
 * project-init-scaffold.mjs — minimal scaffolder for cross-CLI project sync.
 *
 * Distinct from `init-harness-scaffold.mjs`: this writes only the files
 * `dotbabel project-sync` needs, not the full spec-governance harness.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError, ERROR_CODES } from "./lib/errors.mjs";

/** Default `.dotbabel.json` body written when none exists. */
export const DEFAULT_DOTBABEL_JSON = Object.freeze({
  rule_floor_source: "CLAUDE.md",
  commands_dir: ".claude/commands",
  skills_dir: ".claude/skills",
  fan_out: ["codex", "gemini", "copilot"],
  gate_on_cli_presence: true,
  cli_substitutions: {},
  targets: [
    {
      relativeOutputPath: "AGENTS.md",
      cliSet: ["copilot", "codex"],
      substitutionKey: "agents",
    },
    {
      relativeOutputPath: "GEMINI.md",
      cliSet: ["gemini"],
      substitutionKey: "gemini",
    },
    {
      relativeOutputPath: ".github/copilot-instructions.md",
      cliSet: ["copilot"],
      substitutionKey: "copilot",
    },
  ],
});

const STARTER_CLAUDE_MD = `# CLAUDE.md — Project rules

Project-level rules for every agentic CLI in this repo. The block between the
\`dotbabel:rule-floor\` markers below is fanned out into AGENTS.md, GEMINI.md,
and .github/copilot-instructions.md by \`dotbabel project-sync\`.

<!-- dotbabel:rule-floor:begin -->

(Add project-wide rules here. Empty by default.)

<!-- dotbabel:rule-floor:end -->
`;

/**
 * @typedef {object} ScaffoldProjectInitOpts
 * @property {string} repoRoot
 * @property {boolean} [force]   Overwrite an existing .dotbabel.json.
 * @property {boolean} [dryRun]  Report planned actions, do not mutate.
 *
 * @typedef {object} ScaffoldProjectInitResult
 * @property {boolean} ok
 * @property {string[]} filesWritten   Repo-relative POSIX paths created or planned.
 * @property {string[]} skipped        Repo-relative POSIX paths already present.
 */

/**
 * Scaffold the minimum tree project-sync needs into `repoRoot`.
 *
 * Always written:
 *   .dotbabel.json            (refuses to overwrite without --force)
 *   .claude/commands/.gitkeep (only if .claude/commands/ is missing)
 *   .claude/skills/.gitkeep   (only if .claude/skills/ is missing)
 *   CLAUDE.md                 (only if missing — preserves user content)
 *
 * @param {ScaffoldProjectInitOpts} opts
 * @returns {ScaffoldProjectInitResult}
 */
export function scaffoldProjectInit(opts) {
  const { repoRoot } = opts;
  if (!fs.existsSync(repoRoot)) {
    throw new ValidationError({
      code: ERROR_CODES.SCAFFOLD_USAGE,
      category: "scaffold",
      message: `repo root does not exist: ${repoRoot}`,
    });
  }

  /** @type {string[]} */ const filesWritten = [];
  /** @type {string[]} */ const skipped = [];

  const dotbabelPath = path.join(repoRoot, ".dotbabel.json");
  if (fs.existsSync(dotbabelPath) && !opts.force) {
    throw new ValidationError({
      code: ERROR_CODES.SCAFFOLD_CONFLICT,
      category: "scaffold",
      file: ".dotbabel.json",
      message:
        ".dotbabel.json already exists; pass --force to overwrite (a backup is NOT made)",
    });
  }
  if (opts.dryRun) {
    filesWritten.push(".dotbabel.json");
  } else {
    fs.writeFileSync(
      dotbabelPath,
      `${JSON.stringify(DEFAULT_DOTBABEL_JSON, null, 2)}\n`,
    );
    filesWritten.push(".dotbabel.json");
  }

  for (const dir of [".claude/commands", ".claude/skills"]) {
    const abs = path.join(repoRoot, dir);
    const keep = path.join(abs, ".gitkeep");
    if (fs.existsSync(abs)) {
      skipped.push(dir);
      continue;
    }
    if (opts.dryRun) {
      filesWritten.push(`${dir}/.gitkeep`);
    } else {
      fs.mkdirSync(abs, { recursive: true });
      fs.writeFileSync(keep, "");
      filesWritten.push(`${dir}/.gitkeep`);
    }
  }

  const claudeMdPath = path.join(repoRoot, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    skipped.push("CLAUDE.md");
  } else {
    if (opts.dryRun) {
      filesWritten.push("CLAUDE.md");
    } else {
      fs.writeFileSync(claudeMdPath, STARTER_CLAUDE_MD);
      filesWritten.push("CLAUDE.md");
    }
  }

  return { ok: true, filesWritten, skipped };
}
