import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the module at `importMetaUrl` is the script Node was asked to run,
 * as opposed to being imported by a test or another module.
 *
 * The comparison must resolve `process.argv[1]` through symlinks: npm installs
 * package bins as `node_modules/.bin` symlinks, and Node realpath-resolves the
 * ESM entry module (so `import.meta.url` points at the real file) while
 * leaving `argv[1]` as the symlink path. A verbatim comparison therefore
 * concludes an `npx`-invoked bin was merely imported, and the process exits 0
 * having done nothing.
 *
 * @param {string} importMetaUrl - the caller's `import.meta.url`
 * @returns {boolean}
 */
export function invokedDirectly(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // argv[1] can name a path that no longer exists (embedded runners,
    // deleted cwd). Not resolvable means not this module.
    return false;
  }
}
