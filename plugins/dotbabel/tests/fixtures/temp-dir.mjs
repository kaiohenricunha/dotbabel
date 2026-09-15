// Tempdirs that remove themselves. Tests call `makeTempDir(prefix)` instead of
// `mkdtempSync(join(tmpdir(), prefix))`, which leaks a directory per call.
//
// Removal happens when the current test finishes, whether it passed or failed.
// Outside a test (module scope, beforeAll) there is no test to hook, so the
// path waits for the file-level afterAll that temp-dir-setup.mjs registers
// through `setupFiles` in vitest.config.mjs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

const pending = new Set();

function remove(target) {
  rmSync(target, { recursive: true, force: true });
}

/**
 * Schedule an existing path for removal — e.g. a sibling a test derives from a
 * tempdir, like `${work}-bare.git`. Returns the path for inline use.
 * @param {string} target
 * @returns {string}
 */
export function trackTempPath(target) {
  try {
    onTestFinished(() => remove(target));
  } catch {
    // onTestFinished throws when no test is running.
    pending.add(target);
  }
  return target;
}

/**
 * mkdtempSync under os.tmpdir(), removed automatically (see header).
 * @param {string} prefix e.g. "criteria-verify-test-"
 * @returns {string} absolute path of the new directory
 */
export function makeTempDir(prefix) {
  return trackTempPath(mkdtempSync(join(tmpdir(), prefix)));
}

/** Remove every path tracked outside a running test. */
export function removePendingTempPaths() {
  for (const target of pending) remove(target);
  pending.clear();
}
