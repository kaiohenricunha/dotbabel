import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `importMetaUrl` is the script Node was asked to run,
 * as opposed to being imported by a test or another module.
 *
 * Two comparisons, cheapest first. The verbatim one is pure string math and
 * never throws. The realpath one resolves BOTH sides, which is what makes it
 * correct in either symlink mode: npm installs bins as `node_modules/.bin`
 * symlinks, and by default Node realpath-resolves the ESM entry (so
 * `import.meta.url` points at the real file) while leaving `argv[1]` as the
 * symlink — a verbatim-only comparison concludes an `npx`-invoked bin was
 * merely imported, and the process exits 0 having done nothing. Under
 * `--preserve-symlinks-main` the asymmetry flips (the entry URL keeps the
 * symlink), and resolving both sides collapses either shape to the same real
 * file. Ordering matters too: the syscalls are a widening step, never
 * load-bearing, so a filesystem error cannot veto a match the pure
 * comparison already made.
 *
 * @param {string} importMetaUrl - the caller's `import.meta.url`
 * @returns {boolean}
 */
export function invokedDirectly(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(importMetaUrl);
  if (self === entry) return true;
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    // argv[1] can name a path that no longer exists (embedded runners,
    // deleted cwd). Unresolvable and not a literal match means not direct.
    return false;
  }
}

/**
 * Tripwire for the `invokedDirectly` miss case: true when `argv[1]` plainly
 * names this bin (with or without the `.mjs` suffix) yet the guard did not
 * match. For gate tooling, falling through to `exit 0` without running
 * `main()` is indistinguishable from a PASS, so a caller that sees this
 * should fail loudly instead. Never true on the import-for-tests path —
 * a test runner's `argv[1]` is the runner, not the bin.
 *
 * @param {string} binName - the bin's canonical name, e.g. "dotbabel-pr-stack"
 * @returns {boolean}
 */
export function misfiredAs(binName) {
  const entry = process.argv[1];
  return Boolean(entry) && basename(entry).replace(/\.mjs$/, "") === binName;
}
