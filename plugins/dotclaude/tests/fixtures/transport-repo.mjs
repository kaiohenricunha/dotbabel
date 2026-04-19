// Helpers for standing up a bare git repo inside a tmpdir, suitable for
// DOTCLAUDE_HANDOFF_REPO tests. Each helper returns an absolute path.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Create a bare git repo. Caller must clean up with `cleanupTransportRepo`.
 * @returns {{path: string, cleanup: () => void}}
 */
export function makeTransportRepo() {
  const bare = mkdtempSync(join(tmpdir(), "handoff-bare-"));
  const result = spawnSync("git", ["init", "-q", "--bare", bare], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`git init --bare failed (exit ${result.status})`);
  }
  return {
    path: bare,
    cleanup: () => rmSync(bare, { recursive: true, force: true }),
  };
}
