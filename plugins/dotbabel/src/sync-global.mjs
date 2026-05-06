/**
 * sync-global.mjs — JS port of sync.sh
 *
 * Handles pull/push/status for dotbabel in both npm and clone modes.
 *
 * Exported API:
 *   resolveMode(sourceOpt)        — 'clone' | 'npm'
 *   syncGlobal(subcommand, opts)  — main entry point
 */

import { spawnSync } from "node:child_process";
import { createOutput } from "./lib/output.mjs";
import { bootstrapGlobal } from "./bootstrap-global.mjs";
import { version as currentVersion } from "./index.mjs";

// ---------------------------------------------------------------------------
// SECRET_RX — verbatim port from sync.sh
// Catches common literal-secret shapes. High-entropy strings still slip
// through; this is a last-ditch guard, not a full DLP system.
// ---------------------------------------------------------------------------

const SECRET_RX =
  /(^|[^A-Z_])(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|[A-Z_]*_?(API|ACCESS|AUTH|BEARER|PRIVATE)?_?(KEY|TOKEN|SECRET|PASSWORD))[  ]*[:=][  ]*["']?[A-Za-z0-9+/=_-]{20,}["']?|AKIA[0-9A-Z]{16}|bearer[ \t]+[A-Za-z0-9._-]{20,}/im;

// ---------------------------------------------------------------------------
// resolveMode
// ---------------------------------------------------------------------------

/**
 * Determine operating mode.
 *
 * @param {string|undefined} sourceOpt
 * @returns {'clone'|'npm'}
 */
export function resolveMode(sourceOpt) {
  return sourceOpt ? "clone" : "npm";
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Run a subprocess synchronously. Returns the result.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

/**
 * Trim trailing whitespace / newlines from spawnSync stdout.
 *
 * @param {string} s
 * @returns {string}
 */
function trim(s) {
  return (s ?? "").trim();
}

// ---------------------------------------------------------------------------
// subcommand implementations
// ---------------------------------------------------------------------------

async function pullNpm(out, opts) {
  const res = run("npm", ["view", "@dotbabel/dotbabel", "version"]);
  if (res.status !== 0) {
    out.fail(`npm view failed: ${trim(res.stderr || res.stdout)}`);
    return { ok: false, mode: "npm", summary: "npm view failed" };
  }
  const latest = trim(res.stdout);

  if (currentVersion === latest) {
    out.info(`already up to date (v${currentVersion})`);
  } else {
    const updateRes = run("npm", ["update", "-g", "@dotbabel/dotbabel"]);
    if (updateRes.status !== 0) {
      out.fail(`npm update failed: ${trim(updateRes.stderr)}`);
      return { ok: false, mode: "npm", summary: "npm update failed" };
    }
  }

  await bootstrapGlobal({ quiet: opts.quiet, json: opts.json, noColor: opts.noColor });
  return { ok: true, mode: "npm", summary: `updated to v${latest || currentVersion}` };
}

async function pullClone(out, source, opts) {
  const fetchRes = run("git", ["-C", source, "fetch", "origin"]);
  if (fetchRes.status !== 0) {
    out.fail(`git fetch failed: ${trim(fetchRes.stderr)}`);
    return { ok: false, mode: "clone", summary: "git fetch failed" };
  }

  const rebaseRes = run("git", ["-C", source, "rebase", "origin/main"]);
  if (rebaseRes.status !== 0) {
    out.fail(`git rebase failed: ${trim(rebaseRes.stderr)}`);
    return { ok: false, mode: "clone", summary: "git rebase failed" };
  }

  await bootstrapGlobal({ source, quiet: opts.quiet, json: opts.json, noColor: opts.noColor });
  return { ok: true, mode: "clone", summary: "pulled and re-bootstrapped from clone" };
}

async function statusNpm(out) {
  const res = run("npm", ["view", "@dotbabel/dotbabel", "version"]);
  const latest = trim(res.stdout);

  const msg = `installed: v${currentVersion}  latest: v${latest}`;
  if (latest && currentVersion !== latest) {
    out.warn(msg);
  } else {
    out.info(msg);
  }

  return { ok: true, mode: "npm", summary: msg };
}

async function statusClone(out, source) {
  const res = run("git", ["-C", source, "status", "--short"]);
  if (res.status !== 0) {
    out.fail(`git status failed: ${trim(res.stderr || res.stdout)}`);
    return { ok: false, mode: "clone", summary: "git status failed" };
  }
  out.info(trim(res.stdout));
  return { ok: true, mode: "clone", summary: "git status shown" };
}

async function pushNpm(out) {
  out.fail("sync push is only available in clone mode (--source <path>)");
  return { ok: false, mode: "npm", summary: "push unavailable in npm mode — use clone mode (--source <path>)" };
}

async function pushClone(out, source) {
  // Stage all changes
  const addRes = run("git", ["-C", source, "add", "-A"]);
  if (addRes.status !== 0) {
    out.fail(`git add failed: ${trim(addRes.stderr)}`);
    return { ok: false, mode: "clone", summary: "git add failed" };
  }

  // Check if anything is staged (exit 0 = nothing staged, exit 1 = changes staged, >1 = error)
  const diffRes = run("git", ["-C", source, "diff", "--cached", "--quiet"]);
  if (diffRes.status === 0) {
    out.info("no changes to push");
    return { ok: true, mode: "clone", summary: "nothing to push" };
  }
  if (diffRes.status > 1) {
    out.fail(`git diff failed: ${trim(diffRes.stderr)}`);
    return { ok: false, mode: "clone", summary: "git diff failed" };
  }

  // Secret scan: get list of staged files
  const stagedRes = run("git", [
    "-C",
    source,
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
  ]);
  if (stagedRes.status !== 0) {
    out.fail(`git diff --name-only failed: ${trim(stagedRes.stderr)}`);
    return { ok: false, mode: "clone", summary: "git diff --name-only failed" };
  }
  const stagedFiles = trim(stagedRes.stdout)
    .split("\n")
    .filter((f) => f.length > 0);

  for (const file of stagedFiles) {
    const showRes = run("git", ["-C", source, "show", `:${file}`]);
    if (showRes.status !== 0) {
      out.fail(`secret-scan: could not read staged file ${file}`);
      return { ok: false, mode: "clone", summary: `could not read staged file ${file}` };
    }
    if (SECRET_RX.test(showRes.stdout)) {
      out.fail(`secret-scan: POSSIBLE SECRET in ${file}`);
      out.fail(
        "secret-scan: aborting push. Re-run after removing or whitelisting."
      );
      return { ok: false, mode: "clone", summary: `secret detected in ${file}` };
    }
  }

  // Commit
  const date = new Date().toISOString().slice(0, 10);
  const commitRes = run("git", ["-C", source, "commit", "-m", `dotbabel: sync ${date}`]);
  if (commitRes.status !== 0) {
    out.fail(`git commit failed: ${trim(commitRes.stderr)}`);
    return { ok: false, mode: "clone", summary: "git commit failed" };
  }

  // Push
  const pushRes = run("git", ["-C", source, "push"]);
  if (pushRes.status !== 0) {
    out.fail(`git push failed: ${trim(pushRes.stderr)}`);
    return { ok: false, mode: "clone", summary: "git push failed" };
  }

  return { ok: true, mode: "clone", summary: `pushed dotbabel: sync ${date}` };
}

// ---------------------------------------------------------------------------
// syncGlobal — main entry point
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SyncOpts
 * @property {string} [source]   Path to dotbabel clone (triggers clone mode).
 * @property {boolean} [quiet]
 * @property {boolean} [json]
 * @property {boolean} [noColor]
 *
 * @typedef {object} SyncResult
 * @property {boolean} ok
 * @property {'npm'|'clone'} mode
 * @property {string} summary
 */

/**
 * Run a sync subcommand.
 *
 * @param {'pull'|'status'|'push'} subcommand
 * @param {SyncOpts} [opts]
 * @returns {Promise<SyncResult>}
 */
export async function syncGlobal(subcommand, opts = {}) {
  const { source, quiet, json, noColor } = opts;
  const mode = resolveMode(source);

  const out = createOutput({ quiet, json, noColor });

  try {
    if (subcommand === "pull") {
      return await (mode === "clone"
        ? pullClone(out, source, opts)
        : pullNpm(out, opts));
    }

    if (subcommand === "status") {
      return await (mode === "clone" ? statusClone(out, source) : statusNpm(out));
    }

    if (subcommand === "push") {
      return await (mode === "clone" ? pushClone(out, source) : pushNpm(out));
    }

    out.fail(`unknown subcommand: ${subcommand}`);
    return { ok: false, mode, summary: `unknown subcommand: ${subcommand}` };
  } finally {
    out.flush();
  }
}
