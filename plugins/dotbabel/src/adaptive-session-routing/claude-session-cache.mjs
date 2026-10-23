/** Per-session catalog cache for the persistent Claude plugin's one-shot `models route` process. */
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir } from "../lib/paths.mjs";

const safeSession = /^[A-Za-z0-9_-]{1,128}$/;
const safeRelease = /^[0-9]+(\.[0-9]+){1,3}$/;
const maximumAgeMs = 86_400_000;
const digest = text => createHash("sha256").update(text).digest("hex").slice(0, 32);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const shaped = catalog => isObject(catalog) && Array.isArray(catalog.runtimes) && catalog.runtimes.length === 1 && catalog.runtimes[0]?.runtimeId === "claude"
  && Array.isArray(catalog.runtimes[0].models) && catalog.runtimes[0].models.every(model => isObject(model?.fields) && Object.values(model.fields).every(Array.isArray));

/**
 * Open the cache that keeps one verified native catalog per Claude session, release and project, so a
 * later turn of the same session needs no new runtime probes (adaptive-session-routing §5). The file
 * holds only the catalog, its observation time and the release snapshot id it was built from: no
 * prompt, decision, policy or credential. The directory is owner-only (0700) and each file is 0600.
 * Freshness and the snapshot match stay the loader's decision.
 * @param {{session?:string, claudeVersion?:string, env?:NodeJS.ProcessEnv}} options Native session id and release.
 * @returns {{read:Function, write:Function, otherProjects:Function}|undefined} No store for a missing or unsafe id or release.
 */
export function openClaudeSessionCache({ session, claudeVersion, env = process.env }) {
  if (typeof session !== "string" || !safeSession.test(session) || typeof claudeVersion !== "string" || !safeRelease.test(claudeVersion)) return undefined;
  const directory = join(cacheDir(env), "claude-routing");
  const prefix = `${digest(`${session}\0${claudeVersion}`)}-`;
  const nameFor = repoRoot => `${prefix}${digest(repoRoot)}.json`;
  return {
    async read(repoRoot) {
      let value;
      try { value = JSON.parse(await readFile(join(directory, nameFor(repoRoot)), "utf8")); } catch { return undefined; }
      if (value?.repoRoot !== repoRoot || value.claudeVersion !== claudeVersion || typeof value.observedAt !== "string" || typeof value.snapshotId !== "string" || !shaped(value.catalog)) return undefined;
      return { observedAt: value.observedAt, snapshotId: value.snapshotId, catalog: value.catalog };
    },
    /** Count the other projects this session has cached, for the per-session project limit. */
    async otherProjects(repoRoot) {
      let names;
      try { names = await readdir(directory); } catch { return 0; }
      return names.filter(name => name.startsWith(prefix) && name.endsWith(".json") && name !== nameFor(repoRoot)).length;
    },
    async write(repoRoot, entry) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const now = Date.now();
      await Promise.all((await readdir(directory)).map(async name => {
        const path = join(directory, name);
        try { if (now - (await stat(path)).mtimeMs > maximumAgeMs) await rm(path, { force: true }); } catch { /* A concurrent session removed it. */ }
      }));
      const target = join(directory, nameFor(repoRoot)); const partial = `${target}.${process.pid}.tmp`;
      try {
        await writeFile(partial, JSON.stringify({ repoRoot, claudeVersion, observedAt: entry.observedAt, snapshotId: entry.snapshotId, catalog: entry.catalog }), { mode: 0o600 });
        await rename(partial, target);
      } finally { await rm(partial, { force: true }); }
    },
  };
}
