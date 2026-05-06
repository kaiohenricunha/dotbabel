/**
 * bootstrap-global.mjs — JS port of bootstrap.sh
 *
 * Symlinks dotclaude's CLAUDE.md, commands/, and skills/ into a target
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

// ---------------------------------------------------------------------------
// pkgRoot() — walk up from this file until we find a directory containing
// bootstrap.sh. That is the dotclaude repo root. Works in a git checkout
// where bootstrap.sh lives at the repo root. In a published npm install
// bootstrap.sh is not shipped, so the loop hits the filesystem root and
// falls back to two levels up from this file (src/ → plugins/dotclaude/ →
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
      // Fall back to two levels up from this file (plugins/dotclaude/src →
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
 * Determine the dotclaude source directory.
 *
 * Priority:
 *   1. `sourceOpt` (explicit --source flag)
 *   2. `env.DOTCLAUDE_DIR`
 *   3. `pkgRoot()` — walk up to find bootstrap.sh
 *
 * @param {string|undefined} sourceOpt
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveSource(sourceOpt, env) {
  if (sourceOpt) return sourceOpt;
  if (env && env.DOTCLAUDE_DIR) return env.DOTCLAUDE_DIR;
  return pkgRoot();
}

// ---------------------------------------------------------------------------
// linkOne — mirrors bootstrap.sh link_one()
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LinkResult
 * @property {'ok'|'updated'|'linked'|'backed_up'} action
 */

/**
 * Create or update a symlink at `dst` pointing to `src`.
 * Backs up a real file/dir at `dst` before replacing it.
 *
 * @param {string} src
 * @param {string} dst
 * @param {import('./lib/output.mjs').Output} out
 * @param {string} ts  Timestamp string for backup suffix
 * @returns {LinkResult}
 */
function linkOne(src, dst, out, ts) {
  let lstat;
  try {
    lstat = fs.lstatSync(dst);
  } catch {
    // dst does not exist
    fs.symlinkSync(src, dst);
    out.pass(`linked: ${dst} -> ${src}`);
    return { action: "linked" };
  }

  if (lstat.isSymbolicLink()) {
    const current = fs.readlinkSync(dst);
    if (current === src) {
      out.pass(`ok: ${dst}`);
      return { action: "ok" };
    }
    // Stale symlink — update it
    fs.unlinkSync(dst);
    fs.symlinkSync(src, dst);
    out.pass(`updated: ${dst} -> ${src}`);
    return { action: "updated" };
  }

  // Real file or directory — back up then link
  const bakPath = `${dst}.bak-${ts}`;
  fs.renameSync(dst, bakPath);
  fs.symlinkSync(src, dst);
  out.warn(`backed up + linked: ${dst} (old at ${bakPath})`);
  return { action: "backed_up" };
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
 *
 * @typedef {object} BootstrapResult
 * @property {boolean} ok
 * @property {number} linked
 * @property {number} skipped
 * @property {number} backed_up
 */

/**
 * Bootstrap dotclaude into the target directory.
 *
 * @param {BootstrapOpts} [opts]
 * @returns {Promise<BootstrapResult>}
 */
export async function bootstrapGlobal(opts = {}) {
  const source = resolveSource(opts.source, process.env);
  const target = opts.target ?? path.join(os.homedir(), ".claude");

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

  // Build YYYYMMDD-HHmmss timestamp matching bootstrap.sh's date +%Y%m%d-%H%M%S.
  // After replace(/[-:T]/g, "") the ISO string becomes "YYYYMMDDHHmmss.mmmZ",
  // so datePart is slice(0,8) and timePart is slice(8,14) — no T separator remains.
  const ts = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\..+$/, ""); // → "YYYYMMDDHHmmss"
  const timestamp = `${ts.slice(0, 8)}-${ts.slice(8, 14)}`;

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

  // --- CLAUDE.md ---
  const claudeMdSrc = path.join(source, "CLAUDE.md");
  if (fs.existsSync(claudeMdSrc)) {
    doLink(claudeMdSrc, path.join(target, "CLAUDE.md"));
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
  const hooksSrc = path.join(source, "plugins", "dotclaude", "hooks");
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
  const agentsSrc = path.join(source, "plugins", "dotclaude", "templates", "claude", "agents");
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

  out.flush();
  return { ok: true, linked, skipped, backed_up };
}
