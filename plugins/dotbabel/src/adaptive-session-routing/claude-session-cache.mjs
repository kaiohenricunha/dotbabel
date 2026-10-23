/** Per-session catalog cache for the persistent Claude plugin's one-shot `models route` process. */
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "../lib/paths.mjs";

const safeSession = /^[A-Za-z0-9_-]{1,128}$/;
const safeRelease = /^[0-9]+(\.[0-9]+){1,3}$/;
const maximumAgeMs = 86_400_000;

/**
 * Open the cache that keeps one verified native catalog per Claude session, release and project, so a
 * later turn of the same session needs no new runtime probes (adaptive-session-routing §5). The file
 * holds only the catalog and its observation time: no prompt, decision, policy or credential. The
 * directory is owner-only (0700) and each file is 0600. Freshness stays the loader's decision.
 * @param {{session?:string, claudeVersion?:string, env?:NodeJS.ProcessEnv}} options Native session id and release.
 * @returns {{read:Function, write:Function}|undefined} No store for a missing or unsafe id or release.
 */
export function openClaudeSessionCache({ session, claudeVersion, env = process.env }) {
  if (typeof session !== "string" || !safeSession.test(session) || typeof claudeVersion !== "string" || !safeRelease.test(claudeVersion)) return undefined;
  const directory = join(cacheDir(env), "claude-routing");
  const fileFor = repoRoot => join(directory, `${createHash("sha256").update(`${session}\0${claudeVersion}\0${repoRoot}`).digest("hex")}.json`);
  return {
    async read(repoRoot) {
      let value;
      try { value = JSON.parse(await readFile(fileFor(repoRoot), "utf8")); } catch { return undefined; }
      if (value?.repoRoot !== repoRoot || value.claudeVersion !== claudeVersion || typeof value.observedAt !== "string" || !Array.isArray(value.catalog?.runtimes)) return undefined;
      return { observedAt: value.observedAt, catalog: value.catalog };
    },
    async write(repoRoot, entry) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const now = Date.now();
      for (const name of await readdir(directory)) {
        const path = join(directory, name);
        try { if (now - (await stat(path)).mtimeMs > maximumAgeMs) await rm(path, { force: true }); } catch { /* A concurrent session removed it. */ }
      }
      const target = fileFor(repoRoot); const partial = `${target}.${process.pid}.tmp`;
      await writeFile(partial, JSON.stringify({ repoRoot, claudeVersion, observedAt: entry.observedAt, catalog: entry.catalog }), { mode: 0o600 });
      await rename(partial, target);
    },
  };
}
