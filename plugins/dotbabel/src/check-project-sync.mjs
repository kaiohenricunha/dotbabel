/**
 * check-project-sync.mjs — read-only drift report for project-scope sync.
 *
 * Walks the same set of intended outputs as `projectSync` and reports each as
 * one of: ok, missing (expected symlink/file does not exist), or stale
 * (symlink target diverges from the source path the regenerator would use).
 * Never mutates the filesystem.
 */

import fs from "node:fs";
import path from "node:path";
import { createOutput } from "./lib/output.mjs";
import {
  RULE_FLOOR_BEGIN,
  RULE_FLOOR_END,
  composeInject,
  renderTarget,
  validateSubstitutions,
  ERROR_CODES,
} from "./generate-instructions.mjs";
import { extractRuleFloorOrWhole, loadProjectConfig } from "./project-sync.mjs";
import { ValidationError } from "./lib/errors.mjs";

/**
 * @typedef {object} CheckProjectSyncOpts
 * @property {string} repoRoot
 * @property {boolean} [json]
 * @property {boolean} [noColor]
 * @property {boolean} [quiet]
 * @property {import('./lib/output.mjs').Output} [out]
 *
 * @typedef {{ kind: 'instruction'|'symlink', path: string, expected?: string, actual?: string }} DriftEntry
 *
 * @typedef {object} CheckProjectSyncResult
 * @property {boolean} ok                 true iff missing.length === 0 && stale.length === 0
 * @property {DriftEntry[]} missing
 * @property {DriftEntry[]} stale
 * @property {DriftEntry[]} okEntries
 */

/**
 * @param {CheckProjectSyncOpts} opts
 * @returns {Promise<CheckProjectSyncResult>}
 */
export async function checkProjectSync(opts) {
  const repoRoot = opts.repoRoot;
  const out =
    opts.out ??
    createOutput({
      json: opts.json ?? false,
      noColor: opts.noColor ?? false,
      quiet: opts.quiet ?? false,
    });

  /** @type {DriftEntry[]} */ const missing = [];
  /** @type {DriftEntry[]} */ const stale = [];
  /** @type {DriftEntry[]} */ const okEntries = [];

  if (!fs.existsSync(repoRoot)) {
    out.fail(`repo root does not exist: ${repoRoot}`);
    out.flush();
    return { ok: false, missing, stale, okEntries };
  }

  const cfg = loadProjectConfig(repoRoot);
  const sourcePath = path.join(repoRoot, cfg.rule_floor_source);
  if (!fs.existsSync(sourcePath)) {
    out.fail(`rule-floor source does not exist: ${cfg.rule_floor_source}`);
    out.flush();
    return { ok: false, missing, stale, okEntries };
  }

  // ---- Instruction files: compare existing host content against what
  // composeInject would produce. Differences are "stale".

  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const subs = validateSubstitutions(
    cfg.cli_substitutions ?? {},
    ".dotbabel.json",
  );

  for (const target of cfg.targets) {
    const { body } = renderTarget(sourceText, target, subs);
    const ruleFloor = extractRuleFloorOrWhole(body);
    const absHost = path.join(repoRoot, target.relativeOutputPath);
    if (!fs.existsSync(absHost)) {
      missing.push({ kind: "instruction", path: target.relativeOutputPath });
      out.fail(`missing: ${target.relativeOutputPath}`);
      continue;
    }
    const existing = fs.readFileSync(absHost, "utf8");
    let next;
    try {
      next = composeInject(existing, ruleFloor, target.relativeOutputPath);
    } catch (err) {
      if (err instanceof ValidationError) {
        stale.push({
          kind: "instruction",
          path: target.relativeOutputPath,
          expected: "valid rule-floor markers",
          actual: err.message,
        });
        out.fail(`stale: ${target.relativeOutputPath} (${err.message})`);
        continue;
      }
      throw err;
    }
    if (existing === next) {
      okEntries.push({ kind: "instruction", path: target.relativeOutputPath });
      out.pass(`ok: ${target.relativeOutputPath}`);
    } else {
      stale.push({ kind: "instruction", path: target.relativeOutputPath });
      out.fail(`stale: ${target.relativeOutputPath}`);
    }
  }

  // ---- Symlink fan-out: for each enabled CLI, verify each expected symlink
  // exists and points at the source path the regenerator would write.

  const commandsAbs = path.join(repoRoot, cfg.commands_dir);
  const skillsAbs = path.join(repoRoot, cfg.skills_dir);

  /**
   * Compare the symlink at `dstAbs` against the expected source `srcAbs` by
   * resolving both with `fs.realpathSync` and comparing canonical paths. This
   * is robust against the link-target encoding (relative vs absolute) and
   * naturally surfaces dangling symlinks when realpath throws.
   */
  function checkLink(dstAbs, srcAbs, kind = "symlink") {
    const relDst = path.relative(repoRoot, dstAbs);
    let lstat;
    try {
      lstat = fs.lstatSync(dstAbs);
    } catch {
      missing.push({ kind, path: relDst, expected: srcAbs });
      out.fail(`missing: ${relDst}`);
      return;
    }
    if (!lstat.isSymbolicLink()) {
      stale.push({
        kind,
        path: relDst,
        expected: srcAbs,
        actual: "not a symlink",
      });
      out.fail(`stale (not a symlink): ${relDst}`);
      return;
    }
    let resolved;
    try {
      resolved = fs.realpathSync(dstAbs);
    } catch {
      // Dangling symlink — readlink succeeds, but the target doesn't exist.
      const target = fs.readlinkSync(dstAbs);
      stale.push({
        kind,
        path: relDst,
        expected: srcAbs,
        actual: `dangling: ${target}`,
      });
      out.fail(`stale (dangling): ${relDst} -> ${target}`);
      return;
    }
    const expectedResolved = fs.realpathSync(srcAbs);
    if (resolved !== expectedResolved) {
      stale.push({
        kind,
        path: relDst,
        expected: expectedResolved,
        actual: resolved,
      });
      out.fail(`stale: ${relDst} -> ${resolved} (expected ${expectedResolved})`);
      return;
    }
    okEntries.push({ kind, path: relDst });
    out.pass(`ok: ${relDst}`);
  }

  const fanOut = Array.isArray(cfg.fan_out) ? cfg.fan_out : [];

  for (const cli of fanOut) {
    if (cli === "codex" || cli === "gemini") {
      const targetDir = path.join(repoRoot, `.${cli}`, "skills");
      if (fs.existsSync(skillsAbs)) {
        for (const entry of fs.readdirSync(skillsAbs, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name === ".system") continue;
          checkLink(
            path.join(targetDir, entry.name),
            path.join(skillsAbs, entry.name),
          );
        }
      }
      if (fs.existsSync(commandsAbs)) {
        for (const entry of fs.readdirSync(commandsAbs)) {
          if (!entry.endsWith(".md")) continue;
          const name = entry.replace(/\.md$/, "");
          if (name === ".system") continue;
          checkLink(
            path.join(targetDir, name, "SKILL.md"),
            path.join(commandsAbs, entry),
          );
        }
      }
    } else if (cli === "copilot") {
      const promptsDir = path.join(repoRoot, ".github", "prompts");
      const instructionsDir = path.join(repoRoot, ".github", "instructions");
      if (fs.existsSync(commandsAbs)) {
        for (const entry of fs.readdirSync(commandsAbs)) {
          if (!entry.endsWith(".md")) continue;
          const name = entry.replace(/\.md$/, "");
          if (name === ".system") continue;
          checkLink(
            path.join(promptsDir, `${name}.prompt.md`),
            path.join(commandsAbs, entry),
          );
        }
      }
      if (fs.existsSync(skillsAbs)) {
        for (const entry of fs.readdirSync(skillsAbs, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name === ".system") continue;
          const skillFile = path.join(skillsAbs, entry.name, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          checkLink(
            path.join(instructionsDir, `${entry.name}.instructions.md`),
            skillFile,
          );
        }
      }
    }
  }

  out.flush();
  const ok = missing.length === 0 && stale.length === 0;
  return { ok, missing, stale, okEntries };
}

// Re-export markers for callers that want to inspect a CLAUDE.md directly.
export { RULE_FLOOR_BEGIN, RULE_FLOOR_END, ERROR_CODES };
