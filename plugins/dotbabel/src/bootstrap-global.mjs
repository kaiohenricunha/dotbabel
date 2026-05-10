/**
 * bootstrap-global.mjs — JS port of bootstrap.sh
 *
 * Symlinks dotbabel's CLAUDE.md, commands/, and skills/ into a target
 * directory (default: ~/.claude/), and copies agent templates on first install.
 *
 * Exported API:
 *   bootstrapGlobal(opts)  — main entry point
 *   resolveSource(sourceOpt, env)  — exported for testability
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createOutput } from "./lib/output.mjs";
import {
  buildTimestamp,
  commandExists,
  ensureRealDir,
  linkOne,
} from "./lib/symlink.mjs";
import {
  resolveLocalRulesPath,
  writeUserScopeClaudeMd,
} from "./lib/user-overlay.mjs";

// ---------------------------------------------------------------------------
// pkgRoot() — walk up from this file until we find a directory containing
// bootstrap.sh. That is the dotbabel repo root. Works in a git checkout
// where bootstrap.sh lives at the repo root. In a published npm install
// bootstrap.sh is not shipped, so the loop hits the filesystem root and
// falls back to two levels up from this file (src/ → plugins/dotbabel/ →
// repo root), which is correct for the npm package layout.
// ---------------------------------------------------------------------------

function pkgRoot() {
  const start = path.dirname(fileURLToPath(import.meta.url));
  let cur = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(cur, "bootstrap.sh"))) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      // Reached filesystem root without finding bootstrap.sh.
      // Fall back to two levels up from this file (plugins/dotbabel/src →
      // repo root) as a best-effort.
      return path.resolve(start, "..", "..", "..");
    }
    cur = parent;
  }
}

// ---------------------------------------------------------------------------
// resolveSource — exported so tests can exercise the env-var + fallback logic
// ---------------------------------------------------------------------------

/**
 * Determine the dotbabel source directory.
 *
 * Priority:
 *   1. `sourceOpt` (explicit --source flag)
 *   2. `env.DOTBABEL_DIR` (legacy `env.DOTCLAUDE_DIR` honored as fallback through 2.x)
 *   3. `pkgRoot()` — walk up to find bootstrap.sh
 *
 * @param {string|undefined} sourceOpt
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveSource(sourceOpt, env) {
  if (sourceOpt) return sourceOpt;
  if (env) {
    if (env.DOTBABEL_DIR) return env.DOTBABEL_DIR;
    if (env.DOTCLAUDE_DIR) {
      process.emitWarning(
        "DOTCLAUDE_DIR is deprecated; use DOTBABEL_DIR (removal in 3.0.0)",
        { code: "DOTBABEL_LEGACY_ENV", type: "DeprecationWarning" },
      );
      return env.DOTCLAUDE_DIR;
    }
  }
  return pkgRoot();
}

// ---------------------------------------------------------------------------
// bootstrapGlobal — main entry point
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BootstrapOpts
 * @property {string} [source]   Override source directory (default: resolveSource).
 * @property {string} [target]   Override target directory (default: ~/.claude).
 * @property {boolean} [quiet]   Suppress per-file output.
 * @property {boolean} [json]    Buffer output as JSON.
 * @property {boolean} [noColor] Suppress ANSI colors.
 * @property {boolean} [allCli]  Link all supported CLI instructions even when
 *                               the CLI binary is not on PATH.
 *
 * @typedef {object} BootstrapResult
 * @property {boolean} ok
 * @property {number} linked
 * @property {number} skipped
 * @property {number} backed_up
 */

/**
 * Bootstrap dotbabel into the target directory.
 *
 * @param {BootstrapOpts} [opts]
 * @returns {Promise<BootstrapResult>}
 */
export async function bootstrapGlobal(opts = {}) {
  const source = resolveSource(opts.source, process.env);
  const target = opts.target ?? path.join(os.homedir(), ".claude");
  const homeRoot = opts.target ? target : os.homedir();

  const out = createOutput({
    noColor: opts.noColor ?? false,
    json: opts.json ?? false,
    quiet: opts.quiet ?? false,
  });

  // Validate source exists
  if (!fs.existsSync(source)) {
    out.fail(`source directory does not exist: ${source}`);
    out.flush();
    return { ok: false, linked: 0, skipped: 0, backed_up: 0 };
  }

  const timestamp = buildTimestamp();

  fs.mkdirSync(target, { recursive: true });

  let linked = 0;
  let skipped = 0;
  let backed_up = 0;

  /**
   * Wrapper that counts outcomes.
   */
  function doLink(src, dst) {
    const r = linkOne(src, dst, out, timestamp);
    if (r.action === "linked" || r.action === "updated") linked++;
    else if (r.action === "ok") {
      // already correct — counts as "linked" for idempotency metrics but no
      // new work done; we keep it in the linked tally
      linked++;
    } else if (r.action === "backed_up") {
      backed_up++;
      linked++;
    }
  }

  function doEnsureRealDir(dst) {
    const r = ensureRealDir(dst, out, timestamp);
    if (r.action === "backed_up") backed_up++;
  }

  // --- CLAUDE.md (user-scope: canonical + optional user overlay; #228) ---
  // Pre-2.7.0 this was a plain symlink to the canonical source. Now it's a
  // generated file: <canonical> + a marker-delimited overlay block populated
  // from ~/.config/dotbabel/local-rules.md (when present). Bootstrap
  // regenerates the merged file every run, backing up direct edits or the
  // legacy symlink before overwriting.
  const claudeMdSrc = path.join(source, "CLAUDE.md");
  if (fs.existsSync(claudeMdSrc)) {
    const r = writeUserScopeClaudeMd({
      canonicalSrc: claudeMdSrc,
      target: path.join(target, "CLAUDE.md"),
      overlaySrc: resolveLocalRulesPath(process.env),
      out,
      timestamp,
    });
    if (r.action === "migrated" || r.action === "regenerated") backed_up++;
    linked++;
  }

  // --- commands/*.md ---
  const commandsSrc = path.join(source, "commands");
  if (fs.existsSync(commandsSrc)) {
    fs.mkdirSync(path.join(target, "commands"), { recursive: true });
    const entries = fs.readdirSync(commandsSrc);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const src = path.join(commandsSrc, entry);
      const dst = path.join(target, "commands", entry);
      doLink(src, dst);
    }
  }

  // --- skills/*/ (directories) ---
  const skillsSrc = path.join(source, "skills");
  if (fs.existsSync(skillsSrc)) {
    fs.mkdirSync(path.join(target, "skills"), { recursive: true });
    const entries = fs.readdirSync(skillsSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const src = path.join(skillsSrc, entry.name);
      const dst = path.join(target, "skills", entry.name);
      doLink(src, dst);
    }
  }

  // --- hooks/*.sh ---
  const hooksSrc = path.join(source, "plugins", "dotbabel", "hooks");
  if (fs.existsSync(hooksSrc)) {
    const hooksDst = path.join(target, "hooks");
    fs.mkdirSync(hooksDst, { recursive: true });
    for (const entry of fs.readdirSync(hooksSrc)) {
      if (!entry.endsWith(".sh")) continue;
      const src = path.join(hooksSrc, entry);
      const dst = path.join(hooksDst, entry);
      doLink(src, dst);
    }
  }

  // --- agents (copy, not symlink) ---
  const agentsSrc = path.join(source, "plugins", "dotbabel", "templates", "claude", "agents");
  const agentsDst = path.join(target, "agents");
  if (fs.existsSync(agentsSrc)) {
    fs.mkdirSync(agentsDst, { recursive: true });
    const agentFiles = fs.readdirSync(agentsSrc);
    for (const agentFile of agentFiles) {
      if (!agentFile.endsWith(".md")) continue;
      const dstFile = path.join(agentsDst, agentFile);
      if (fs.existsSync(dstFile)) {
        out.info(`skipped (exists): ${agentFile}`);
        skipped++;
      } else {
        fs.copyFileSync(path.join(agentsSrc, agentFile), dstFile);
        out.pass(`installed agent: ${agentFile}`);
      }
    }
  }

  const cliInstructionsSrc = path.join(source, "plugins", "dotbabel", "templates", "cli-instructions");
  // Copilot CLI has no skill auto-discovery dir (~/.copilot/), so we link only
  // the instruction file, not skills.
  linkCliInstruction({
    cli: "copilot",
    src: path.join(cliInstructionsSrc, "copilot-instructions.md"),
    dst: path.join(homeRoot, ".github", "copilot-instructions.md"),
  });
  linkCliInstruction({
    cli: "codex",
    src: path.join(cliInstructionsSrc, "codex-AGENTS.md"),
    dst: path.join(homeRoot, ".codex", "AGENTS.md"),
  });
  fanOutSkillsToDir({
    cli: "codex",
    dstDir: path.join(process.env.CODEX_HOME || path.join(homeRoot, ".codex"), "skills"),
  });
  linkCliInstruction({
    cli: "gemini",
    src: path.join(cliInstructionsSrc, "gemini-GEMINI.md"),
    dst: path.join(homeRoot, ".gemini", "GEMINI.md"),
  });
  fanOutSkillsToDir({
    cli: "gemini",
    dstDir: path.join(process.env.GEMINI_HOME || path.join(homeRoot, ".gemini"), "skills"),
  });

  out.flush();
  return { ok: true, linked, skipped, backed_up };

  /**
   * @param {{ cli: string, src: string, dst: string }} cfg
   */
  function linkCliInstruction({ cli, src, dst }) {
    if (!opts.allCli && !commandExists(cli)) {
      out.info(`skipped ${cli} instructions (command not found; use --all to force)`);
      skipped++;
      return;
    }
    if (!fs.existsSync(src)) {
      out.info(`skipped ${cli} instructions (missing source: ${src})`);
      skipped++;
      return;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    doLink(src, dst);
  }

  /**
   * Fan out skills/ + commands/ into a CLI-specific skills directory.
   *
   * Each skills/<id>/ becomes <dstDir>/<id>/ (whole-dir symlink). Each
   * commands/<name>.md becomes <dstDir>/<name>/SKILL.md so the host CLI sees
   * the canonical skill shape. Skips entries named ".system" defensively —
   * Codex reserves that namespace for its bundled built-in skills.
   *
   * @param {{ cli: string, dstDir: string }} cfg
   */
  function fanOutSkillsToDir({ cli, dstDir }) {
    if (!opts.allCli && !commandExists(cli)) {
      out.info(`skipped ${cli} skills (command not found; use --all to force)`);
      skipped++;
      return;
    }
    fs.mkdirSync(dstDir, { recursive: true });

    if (fs.existsSync(skillsSrc)) {
      const entries = fs.readdirSync(skillsSrc, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".system") continue;
        const src = path.join(skillsSrc, entry.name);
        const dst = path.join(dstDir, entry.name);
        doLink(src, dst);
      }
    }

    if (fs.existsSync(commandsSrc)) {
      for (const entry of fs.readdirSync(commandsSrc)) {
        if (!entry.endsWith(".md")) continue;
        const name = entry.replace(/\.md$/, "");
        if (name === ".system") continue;
        const src = path.join(commandsSrc, entry);
        const wrapDir = path.join(dstDir, name);
        doEnsureRealDir(wrapDir);
        const dst = path.join(wrapDir, "SKILL.md");
        doLink(src, dst);
      }
    }
  }
}
